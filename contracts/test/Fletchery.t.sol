// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {Fixture} from "./Fixture.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";

import {CredentialRegistry} from "../src/access/CredentialRegistry.sol";
import {AgentMandates} from "../src/access/AgentMandates.sol";
import {VenueController} from "../src/compliance/VenueController.sol";
import {FairValueOracle} from "../src/safety/FairValueOracle.sol";
import {StockToken} from "../src/rights/StockToken.sol";
import {RightsDistributor, IERC20Min} from "../src/rights/RightsDistributor.sol";
import {ProofAnchor} from "../src/proof/ProofAnchor.sol";
import {FletcheryHook} from "../src/FletcheryHook.sol";
import {FletcheryRouter} from "../src/FletcheryRouter.sol";

/// @dev Hook reverts reach the caller wrapped by the PoolManager, so tests assert on the
///      inner hook error via `_expectHookRevert`.
contract FletcheryTest is Fixture {
    function test_DefaultOrdering() public view virtual {
        assertTrue(stockIs0);
    }

    /// Calls `fn` and asserts the hook reverted with `expectedInner` (selector match).
    function _assertHookError(bytes memory callData, bytes4 expectedInner) internal {
        (bool ok, bytes memory ret) = address(this).call(callData);
        assertFalse(ok, "expected revert");
        bytes4 outer;
        assembly {
            outer := mload(add(ret, 32))
        }
        if (outer == CustomRevert.WrappedError.selector) {
            // WrappedError(address target, bytes4 selector, bytes reason, bytes details)
            bytes memory body = new bytes(ret.length - 4);
            for (uint256 i; i < body.length; i++) body[i] = ret[i + 4];
            (,, bytes memory reason,) = abi.decode(body, (address, bytes4, bytes, bytes));
            bytes4 inner;
            assembly {
                inner := mload(add(reason, 32))
            }
            assertEq(inner, expectedInner, "wrong inner error");
        } else {
            assertEq(outer, expectedInner, "wrong error");
        }
    }

    // external wrappers so _assertHookError can capture revert data
    function doBuy(address who, uint256 cashIn) external returns (uint256) {
        return buy(who, cashIn);
    }

    function doSell(address who, uint256 sharesIn) external returns (uint256) {
        return sell(who, sharesIn);
    }

    function doAgentBuy(uint256 cashIn) external returns (uint256) {
        return agentBuy(cashIn);
    }

    function doAddLiquidity(address lp, uint256 shares, uint256 cash) external {
        _addLiquidity(lp, shares, cash, 600);
    }

    // ═════════════════════════ Execution ═════════════════════════

    function test_CredentialedBuyAndSell() public {
        uint256 shares = buy(alice, 10_000e6);
        assertApproxEqRel(shares, 50e18, 0.01e18, "~50 shares for $10k at $200");
        assertEq(aapl.balanceOf(alice), 50_000e18 + shares);

        uint256 cash = sell(bob, 10e18);
        assertApproxEqRel(cash, 2_000e6, 0.01e18, "~$2,000 for 10 shares");
    }

    function test_FillEventCarriesAuditFields() public {
        vm.recordLogs();
        buy(alice, 1_000e6);
        bytes32 fillSig = keccak256(
            "Fill(bytes32,bytes32,address,address,address,bool,uint256,uint256,uint256,uint256)"
        );
        bool found;
        Vm_Log[] memory logs = _logs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == fillSig) {
                found = true;
                assertEq(logs[i].topics[2], AAPL);
                assertEq(address(uint160(uint256(logs[i].topics[3]))), alice);
                (address principal, address r, bool isSell,,, uint256 px, uint256 fv) =
                    abi.decode(logs[i].data, (address, address, bool, uint256, uint256, uint256, uint256));
                assertEq(principal, alice);
                assertEq(r, address(router));
                assertFalse(isSell);
                assertApproxEqRel(px, 200e8, 0.01e18);
                assertEq(fv, 200e8);
            }
        }
        assertTrue(found, "Fill emitted");
    }

    // ═════════════════════════ Access ═════════════════════════

    function test_RejectsTraderWithoutCredential() public {
        dusd.mint(eve, 1_000e6);
        vm.prank(eve);
        dusd.approve(address(router), type(uint256).max);
        _assertHookError(abi.encodeCall(this.doBuy, (eve, 1_000e6)), FletcheryHook.NoCredential.selector);
    }

    function test_RejectsUnapprovedRouter() public {
        PoolSwapTest rogue = new PoolSwapTest(IPoolManager(address(manager)));
        dusd.approve(address(rogue), type(uint256).max);
        vm.expectPartialRevert(CustomRevert.WrappedError.selector);
        rogue.swap(
            key,
            SwapParams(!stockIs0, -1_000e6, !stockIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            abi.encode(alice, alice) // tries to spoof alice
        );
    }

    function test_RejectsBlockedJurisdiction() public {
        _credential(eve, KP, CredentialRegistry.InvestorClass.RETAIL);
        dusd.mint(eve, 1_000e6);
        vm.prank(eve);
        dusd.approve(address(router), type(uint256).max);
        _assertHookError(abi.encodeCall(this.doBuy, (eve, 1_000e6)), FletcheryHook.JurisdictionNotAllowed.selector);
    }

    function test_RevokedAndExpiredCredentialsFail() public {
        vm.prank(attester);
        creds.revoke(alice, "aml-review");
        _assertHookError(abi.encodeCall(this.doBuy, (alice, 1_000e6)), FletcheryHook.NoCredential.selector);

        vm.warp(block.timestamp + 366 days); // bob's credential expires
        assertFalse(creds.isValid(bob));
    }

    function test_DistrustingAttesterInvalidatesItsCredentials() public {
        creds.setRole(creds.ATTESTER(), attester, false);
        assertFalse(creds.isValid(alice));
    }

    function test_MinInvestorClass() public {
        hook.setMinClass(CredentialRegistry.InvestorClass.ACCREDITED);
        _assertHookError(abi.encodeCall(this.doBuy, (alice, 1_000e6)), FletcheryHook.InvestorClassTooLow.selector);
    }

    function test_StockTokenOnlyMovesBetweenEligibleHolders() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StockToken.NotEligible.selector, eve));
        aapl.transfer(eve, 1e18);
        vm.prank(alice);
        aapl.transfer(bob, 1e18);
        assertEq(aapl.balanceOf(bob), 50_001e18);
    }

    function test_UncredentialedLpCannotAddLiquidity() public {
        aapl.setSystem(eve, true); // even if eve could hold tokens, the hook still blocks her
        aapl.mint(eve, 100e18);
        dusd.mint(eve, 100_000e6);
        vm.startPrank(eve);
        aapl.approve(address(router), type(uint256).max);
        dusd.approve(address(router), type(uint256).max);
        vm.stopPrank();
        _assertHookError(abi.encodeCall(this.doAddLiquidity, (eve, 100e18, 20_000e6)), FletcheryHook.NoCredential.selector);
    }

    // ═════════════════════════ Compliance ═════════════════════════

    function test_MonthlyCapEnforcedPreTrade() public {
        venue.setCapBasis(AAPL, 200_000e18); // cap = 0.25% = 500 shares
        (uint256 remaining, uint256 cap,) = venue.headroom(AAPL);
        assertEq(cap, 500e18);
        assertEq(remaining, 500e18);

        sell(alice, 300e18);
        sell(bob, 150e18);
        (remaining,,) = venue.headroom(AAPL);
        assertEq(remaining, 50e18);

        _assertHookError(abi.encodeCall(this.doSell, (alice, 60e18)), VenueController.CapExceeded.selector);
        sell(alice, 50e18); // exactly fills the cap
        (remaining,,) = venue.headroom(AAPL);
        assertEq(remaining, 0);
    }

    function test_CapResetsOnFirstOfMonth_AndFailsClosedWithoutBasis() public {
        venue.setCapBasis(AAPL, 200_000e18);
        sell(alice, 500e18);
        vm.warp(1_793_491_200 + 3600); // 1 Nov 2026 01:00 UTC
        oracle.post(AAPL, PX, 10, FairValueOracle.Session.CLOSED);
        // no basis posted for November yet → trading halts rather than guessing
        _assertHookError(abi.encodeCall(this.doSell, (alice, 1e18)), VenueController.NoCapBasis.selector);
        venue.setCapBasis(AAPL, 200_000e18);
        sell(alice, 400e18);
        (uint256 remaining,,) = venue.headroom(AAPL);
        assertEq(remaining, 100e18);
    }

    function test_RepeatBreachStopsSymbolForThreeMonths() public {
        venue.setCapBasis(AAPL, 200_000e18);
        sell(alice, 400e18);
        venue.setCapBasis(AAPL, 100_000e18); // downward ADV revision → 400 > 250 → breach #1
        (,,,,,, uint32 breaches) = venue.meters(AAPL);
        assertEq(breaches, 1);

        vm.warp(1_793_491_200 + 40 days); // December
        oracle.post(AAPL, PX, 10, FairValueOracle.Session.REGULAR);
        venue.setCapBasis(AAPL, 200_000e18);
        sell(alice, 400e18);
        venue.setCapBasis(AAPL, 100_000e18); // breach #2 within 12 months → stop
        (,,,,, uint64 stoppedUntil,) = venue.meters(AAPL);
        assertEq(stoppedUntil, block.timestamp + 90 days);
        _assertHookError(abi.encodeCall(this.doSell, (alice, 1e18)), VenueController.Stopped.selector);
    }

    function test_HaltMirroring() public {
        venue.setHalt(AAPL, true, "LULD");
        _assertHookError(abi.encodeCall(this.doBuy, (alice, 1_000e6)), VenueController.Halted.selector);
        venue.setHalt(AAPL, false, "");
        buy(alice, 1_000e6);

        venue.setMarketWideHalt(true, "MWCB-L1");
        _assertHookError(abi.encodeCall(this.doBuy, (alice, 1_000e6)), VenueController.Halted.selector);
    }

    function test_ThirdPartyListingNeedsNotice_IssuerCanObject() public {
        bytes32 tsla = "TSLA";
        address tslaIssuer = makeAddr("tesla-ir");
        venue.noticeListing(tsla, address(0xBEEF), tslaIssuer, false);
        vm.expectRevert();
        venue.activateListing(tsla); // 30-day notice still running

        vm.warp(block.timestamp + 10 days);
        vm.prank(tslaIssuer);
        venue.objectToListing(tsla);
        (VenueController.ListingStatus s,,,,) = venue.listings(tsla);
        assertEq(uint8(s), uint8(VenueController.ListingStatus.OBJECTED));
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(abi.encodeWithSelector(VenueController.NotNoticed.selector, tsla));
        venue.activateListing(tsla);
    }

    function test_ObjectionWindowCloses() public {
        bytes32 nvda = "NVDA";
        venue.noticeListing(nvda, address(0xBEEF), issuer, false);
        vm.warp(block.timestamp + 30 days);
        vm.prank(issuer);
        vm.expectRevert(VenueController.ObjectionWindowClosed.selector);
        venue.objectToListing(nvda);
        venue.activateListing(nvda);
    }

    function test_Tier1SymbolLimit() public {
        uint256 start = venue.activeSymbols();
        for (uint256 i = start; i < 75; i++) {
            venue.noticeListing(bytes32(i + 1000), address(0), issuer, true);
        }
        vm.warp(block.timestamp + 30 days);
        for (uint256 i = start; i < 75; i++) {
            venue.activateListing(bytes32(i + 1000));
        }
        assertEq(venue.activeSymbols(), 75);
        venue.noticeListing("ONE-TOO-MANY", address(0), issuer, true);
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(abi.encodeWithSelector(VenueController.SymbolLimit.selector, uint16(75)));
        venue.activateListing("ONE-TOO-MANY");
    }

    function test_Tier2Parameters() public {
        VenueController t2 = new VenueController(address(this), 2);
        assertEq(t2.capBps(), 250);
        assertEq(t2.maxSymbols(), 250);
        vm.expectRevert(VenueController.BadTier.selector);
        new VenueController(address(this), 3);
    }

    function test_MonthKeyMatchesCalendar() public view {
        assertEq(venue.monthKey(1_793_025_000), 24321); // 2026-10-26
        assertEq(venue.monthKey(1_793_491_140), 24321); // 2026-10-31 23:59
        assertEq(venue.monthKey(1_793_491_200), 24322); // 2026-11-01 00:00
        assertEq(venue.monthKey(1_772_280_000), 24313); // 2026-02-28
        assertEq(venue.monthKey(1_835_438_400), 24337); // 2028-02-29 (leap day)
        assertEq(venue.monthKey(951_868_800), 24002); // 2000-03-01
    }

    // ═════════════════════════ Safety (Weekend Guard) ═════════════════════════

    function test_StaleFairValueFailsClosed() public {
        vm.warp(block.timestamp + 121); // regular-session staleness limit is 120s
        _assertHookError(abi.encodeCall(this.doBuy, (alice, 1_000e6)), FairValueOracle.StaleFairValue.selector);
    }

    function test_TradeThatDislocatesPriceIsRejected() public {
        // ±3% + 0.1% band in regular hours; a $600k market buy would push price ~6% above fair value
        _assertHookError(abi.encodeCall(this.doBuy, (alice, 600_000e6)), FletcheryHook.PriceOutOfBand.selector);
        buy(alice, 20_000e6); // a normal-size order goes through
    }

    function test_WeekendBandIsWiderButStillBinding() public {
        oracle.post(AAPL, PX, 50, FairValueOracle.Session.CLOSED); // ±10.5% at weekends
        buy(alice, 600_000e6); // allowed at the weekend, rejected on a weekday (see above)
        _assertHookError(abi.encodeCall(this.doBuy, (alice, 900_000e6)), FletcheryHook.PriceOutOfBand.selector);
    }

    function test_ArbitrageTowardFairValueIsAlwaysAllowed() public {
        // Overnight news: fair value drops 15%. The pool is now far outside the band.
        oracle.post(AAPL, 170e8, 20, FairValueOracle.Session.OVERNIGHT);
        uint256 before = hook.poolPriceE8(key);
        assertApproxEqRel(before, 200e8, 0.001e18);
        // Buying would move price further away → blocked
        _assertHookError(abi.encodeCall(this.doBuy, (alice, 1_000e6)), FletcheryHook.PriceOutOfBand.selector);
        // Selling repairs the pool → allowed, even though it ends still outside the band
        sell(bob, 100e18);
        assertLt(hook.poolPriceE8(key), before);
    }

    // ═════════════════════════ Agent mandates (Leash) ═════════════════════════

    function test_AgentTradesWithinMandate() public {
        vm.prank(alice);
        mandates.setMandate(agent, 2_000e6, 5_000e6, uint64(block.timestamp + 7 days), false, false);
        vm.prank(alice);
        mandates.setSymbol(agent, AAPL, true);

        uint256 aliceBefore = aapl.balanceOf(alice);
        uint256 shares = agentBuy(2_000e6);
        assertEq(aapl.balanceOf(alice), aliceBefore + shares, "shares go to the principal, not the agent");
        assertEq(aapl.balanceOf(agent), 0);
        agentBuy(2_000e6);
        // 4,000 spent today; a further 2,000 would breach the 5,000 daily limit
        _assertHookError(abi.encodeCall(this.doAgentBuy, (2_000e6)), AgentMandates.DailyLimit.selector);
        vm.warp(block.timestamp + 1 days);
        oracle.post(AAPL, PX, 10, FairValueOracle.Session.REGULAR);
        agentBuy(2_000e6); // new day, new allowance
    }

    function test_AgentBlockedOverPerTradeLimit_AndAfterRevoke() public {
        vm.prank(alice);
        mandates.setMandate(agent, 1_000e6, 10_000e6, uint64(block.timestamp + 7 days), false, true);
        _assertHookError(abi.encodeCall(this.doAgentBuy, (1_500e6)), AgentMandates.PerTradeLimit.selector);
        agentBuy(900e6);
        vm.prank(alice);
        mandates.revoke(agent);
        _assertHookError(abi.encodeCall(this.doAgentBuy, (500e6)), AgentMandates.NoMandate.selector);
    }

    function test_AgentWithoutMandateCannotSpendSomeoneElsesFunds() public {
        _assertHookError(abi.encodeCall(this.doAgentBuy, (100e6)), AgentMandates.NoMandate.selector);
    }

    // ═════════════════════════ Rights (Rightsrail) ═════════════════════════

    function test_DividendPaysRecordDateHolders_IncludingPoolPassThrough() public {
        rights.setRole(rights.CORPORATE_ACTIONS(), address(this), true);
        address lpVault = makeAddr("lp-pass-through");
        rights.setBeneficiary(address(manager), lpVault);

        uint64 recordDate = aapl.snapshot();
        uint256 aliceAtRecord = aapl.balanceOf(alice);
        uint256 poolAtRecord = aapl.balanceOf(address(manager));
        // alice sells after the record date: she still gets the dividend on her record-date balance
        sell(alice, 1_000e18);

        dusd.approve(address(rights), type(uint256).max);
        uint256 id = rights.declareDividend(aapl, recordDate, IERC20Min(address(dusd)), 0.26e6, uint64(block.timestamp));

        uint256 before = dusd.balanceOf(alice);
        vm.prank(alice);
        rights.claim(id, alice);
        assertEq(dusd.balanceOf(alice) - before, aliceAtRecord * 0.26e6 / 1e18);

        vm.prank(lpVault);
        uint256 lpPaid = rights.claim(id, address(manager));
        assertEq(lpPaid, poolAtRecord * 0.26e6 / 1e18, "pool-held shares are not short-changed");

        vm.prank(alice);
        vm.expectRevert(RightsDistributor.AlreadyClaimed.selector);
        rights.claim(id, alice);
    }

    function test_ProxyVoteUsesRecordDateWeights() public {
        rights.setRole(rights.CORPORATE_ACTIONS(), address(this), true);
        uint64 recordDate = aapl.snapshot();
        vm.prank(alice);
        aapl.transfer(bob, 10_000e18); // moved after record date: doesn't change weights
        uint256 id = rights.openVote(aapl, recordDate, keccak256("Item 1: elect directors"), uint64(block.timestamp + 14 days));
        vm.prank(alice);
        assertEq(rights.castVote(id, 1), 50_000e18);
        vm.prank(bob);
        assertEq(rights.castVote(id, 0), 50_000e18);
        vm.prank(alice);
        vm.expectRevert(RightsDistributor.AlreadyVoted.selector);
        rights.castVote(id, 1);
    }

    function test_SnapshotHistoryIsExact() public {
        uint64 s1 = aapl.snapshot();
        vm.prank(alice);
        aapl.transfer(bob, 1e18);
        uint64 s2 = aapl.snapshot();
        vm.prank(alice);
        aapl.transfer(bob, 2e18);
        assertEq(aapl.balanceOfAt(alice, s1), 50_000e18);
        assertEq(aapl.balanceOfAt(alice, s2), 49_999e18);
        assertEq(aapl.balanceOf(alice), 49_997e18);
        assertEq(aapl.balanceOfAt(bob, s2), 50_001e18);
    }

    // ═════════════════════════ Proof ═════════════════════════

    function test_ProofAnchorsMustBeContiguous() public {
        proof.setRole(proof.ANCHORER(), address(this), true);
        proof.anchor(keccak256("head-1"), 0, 99, "s3://fletchery/log/0-99");
        proof.anchor(keccak256("head-2"), 100, 250, "s3://fletchery/log/100-250");
        vm.expectRevert(abi.encodeWithSelector(ProofAnchor.NonContiguous.selector, uint64(251), uint64(300)));
        proof.anchor(keccak256("gap"), 300, 400, "");
        assertTrue(proof.isAnchored(keccak256("head-2")));
    }

    // ═════════════════════════ Fuzz ═════════════════════════

    /// Whatever the order sizes, the venue never trades past its cap.
    function testFuzz_CapNeverExceeded(uint96[6] memory sizes) public {
        venue.setCapBasis(AAPL, 200_000e18); // 500-share cap
        for (uint256 i; i < sizes.length; i++) {
            uint256 s = bound(uint256(sizes[i]), 1e15, 300e18);
            try this.doSell(i % 2 == 0 ? alice : bob, s) {} catch {}
            (, uint256 cap, uint256 used) = venue.headroom(AAPL);
            assertLe(used, cap);
        }
    }

    // ───────── log plumbing ─────────
    struct Vm_Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function _logs() internal view returns (Vm_Log[] memory out) {
        bytes memory raw = abi.encode(vm.getRecordedLogs());
        out = abi.decode(raw, (Vm_Log[]));
    }
}

/// @notice Re-runs the entire suite with the cash token as currency0 (stock as currency1).
contract FletcheryFlippedOrderingTest is FletcheryTest {
    function dusdIsCurrency0() internal pure override returns (bool) {
        return true;
    }

    function test_DefaultOrdering() public view override {
        assertFalse(stockIs0);
    }

    function test_OrderingIsFlipped() public view {
        assertFalse(stockIs0);
    }
}
