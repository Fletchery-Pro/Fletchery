// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";

import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {LiquidityAmounts} from "@uniswap/v4-core/test/utils/LiquidityAmounts.sol";

import {CredentialRegistry} from "../src/access/CredentialRegistry.sol";
import {AgentMandates} from "../src/access/AgentMandates.sol";
import {VenueController} from "../src/compliance/VenueController.sol";
import {FairValueOracle} from "../src/safety/FairValueOracle.sol";
import {StockToken} from "../src/rights/StockToken.sol";
import {RightsDistributor} from "../src/rights/RightsDistributor.sol";
import {ProofAnchor} from "../src/proof/ProofAnchor.sol";
import {FletcheryHook} from "../src/FletcheryHook.sol";
import {FletcheryRouter} from "../src/FletcheryRouter.sol";

/// @notice Deploys a full Fletchery venue on a real Uniswap v4 PoolManager:
///         one AAPL stock-token / dUSD pool at $200 with 10,000 shares of liquidity.
abstract contract Fixture is Test {
    uint256 constant MON_2026_10_26_1430 = 1_793_025_000; // Monday, regular session
    uint16 constant US = 840;
    uint16 constant UK = 826;
    uint16 constant KP = 408; // sanctioned jurisdiction for the block test
    bytes32 constant AAPL = "AAPL";
    uint128 constant PX = 200e8; // $200.00

    PoolManager manager;
    CredentialRegistry creds;
    AgentMandates mandates;
    VenueController venue;
    FairValueOracle oracle;
    StockToken aapl;
    MockERC20 dusd;
    RightsDistributor rights;
    ProofAnchor proof;
    FletcheryHook hook;
    FletcheryRouter router;
    PoolKey key;
    bool stockIs0;

    address attester = makeAddr("broker-kyc");
    address alice = makeAddr("alice"); // US retail
    address bob = makeAddr("bob"); // UK retail
    address mm = makeAddr("market-maker"); // institutional LP
    address eve = makeAddr("eve"); // no credential
    address agent = makeAddr("ai-agent"); // trades for alice under a mandate
    address issuer = makeAddr("apple-ir");

    function setUp() public virtual {
        vm.warp(MON_2026_10_26_1430);
        manager = new PoolManager(address(this));

        creds = new CredentialRegistry(address(this));
        creds.setRole(creds.ATTESTER(), attester, true);
        mandates = new AgentMandates(address(this));
        venue = new VenueController(address(this), 1);
        oracle = new FairValueOracle(address(this));
        rights = new RightsDistributor(address(this));
        proof = new ProofAnchor(address(this));

        _credential(alice, US, CredentialRegistry.InvestorClass.RETAIL);
        _credential(bob, UK, CredentialRegistry.InvestorClass.RETAIL);
        _credential(mm, US, CredentialRegistry.InvestorClass.INSTITUTIONAL);
        _credential(address(this), US, CredentialRegistry.InvestorClass.INSTITUTIONAL); // issuer / treasury

        aapl = new StockToken(address(this), "Apple Inc. (tokenized)", "AAPL", creds);
        // Force token ordering so both code paths (stock = currency0 / currency1) are tested.
        address dusdAddr = dusdIsCurrency0() ? address(0x0000000000000000000000000000000000001000)
            : address(0xffffFfFFFFfffFfFfffFffFffFfFfFfFfFFFf000);
        deployCodeTo("MockERC20.sol:MockERC20", abi.encode("Demo Dollar", "dUSD", uint8(6)), dusdAddr);
        dusd = MockERC20(dusdAddr);

        // hook must live at an address whose low bits encode its permissions
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
                | Hooks.AFTER_SWAP_FLAG
        );
        address hookAddr = address(flags | (uint160(0xC0C0) << 144));
        deployCodeTo(
            "FletcheryHook.sol:FletcheryHook",
            abi.encode(address(this), IPoolManager(address(manager)), creds, mandates, venue, oracle),
            hookAddr
        );
        hook = FletcheryHook(hookAddr);
        router = new FletcheryRouter(IPoolManager(address(manager)));
        hook.setRouter(address(router), true);
        hook.setJurisdictionBlocked(KP, true);

        venue.setRole(venue.METER(), address(hook), true);
        venue.setRole(venue.LISTING_ADMIN(), address(this), true);
        venue.setRole(venue.DATA_ORACLE(), address(this), true);
        venue.setRole(venue.HALT_ORACLE(), address(this), true);
        mandates.setRole(mandates.ENFORCER(), address(hook), true);
        oracle.setRole(oracle.REPORTER(), address(this), true);

        aapl.setRole(aapl.TRANSFER_AGENT(), address(this), true);
        aapl.setSystem(address(manager), true);
        aapl.setSystem(address(rights), true);

        // listing: issuer-sponsored, 30-day notice then activate
        vm.warp(MON_2026_10_26_1430 - 31 days);
        venue.noticeListing(AAPL, address(aapl), issuer, true);
        vm.warp(MON_2026_10_26_1430);
        venue.activateListing(AAPL);
        venue.setCapBasis(AAPL, 4_000_000e18); // prior-month ADV 4m shares → Tier 1 cap 10,000 shares
        oracle.post(AAPL, PX, 10, FairValueOracle.Session.REGULAR);

        // pool
        stockIs0 = address(aapl) < address(dusd);
        key = PoolKey({
            currency0: Currency.wrap(stockIs0 ? address(aapl) : address(dusd)),
            currency1: Currency.wrap(stockIs0 ? address(dusd) : address(aapl)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        hook.registerPool(key, AAPL, stockIs0, 18, 6);
        manager.initialize(key, sqrtPriceFor(PX));

        // fund and approve
        address[4] memory people = [alice, bob, mm, address(this)];
        for (uint256 i; i < people.length; i++) {
            aapl.mint(people[i], 50_000e18);
            dusd.mint(people[i], 20_000_000e6);
            vm.startPrank(people[i]);
            aapl.approve(address(router), type(uint256).max);
            dusd.approve(address(router), type(uint256).max);
            vm.stopPrank();
        }
        _addLiquidity(mm, 10_000e18, 2_000_000e6, 2000);
    }

    function dusdIsCurrency0() internal pure virtual returns (bool) {
        return false;
    }

    // ───────────── helpers ─────────────

    function _credential(address who, uint16 j, CredentialRegistry.InvestorClass c) internal {
        vm.prank(attester);
        creds.issue(who, j, c, uint64(block.timestamp + 365 days), keccak256(abi.encode(who)));
    }

    /// @notice sqrtPriceX96 for a $ price (8 decimals) of an 18-dec stock against a 6-dec dollar.
    function sqrtPriceFor(uint256 priceE8) internal view returns (uint160) {
        // raw price = token1 units per token0 unit
        uint256 cashPerShareRaw = priceE8 * 1e6 / 1e8; // cash units per 1e18 stock units
        uint256 ratioX192 = stockIs0
            ? FullMath.mulDiv(cashPerShareRaw, 1 << 192, 1e18)
            : FullMath.mulDiv(1e18, 1 << 192, cashPerShareRaw);
        return uint160(FixedPointMathLib.sqrt(ratioX192));
    }

    function _addLiquidity(address lp, uint256 shares, uint256 cash, int24 halfWidthTicks) internal {
        (uint160 sqrtP,,,) = _slot0();
        int24 tick = TickMath.getTickAtSqrtPrice(sqrtP);
        int24 lower = ((tick - halfWidthTicks) / 60) * 60;
        int24 upper = ((tick + halfWidthTicks) / 60) * 60;
        uint256 a0 = stockIs0 ? shares : cash;
        uint256 a1 = stockIs0 ? cash : shares;
        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), a0, a1
        );
        vm.prank(lp);
        router.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, int256(uint256(liq)), 0), block.timestamp);
    }

    function _slot0() internal view returns (uint160, int24, uint24, uint24) {
        return StateLibraryView.getSlot0(IPoolManager(address(manager)), key);
    }

    function buy(address who, uint256 cashIn) internal returns (uint256 shares) {
        vm.prank(who);
        shares = router.swapExactIn(key, !stockIs0, cashIn, 0, address(0), block.timestamp);
    }

    function sell(address who, uint256 sharesIn) internal returns (uint256 cash) {
        vm.prank(who);
        cash = router.swapExactIn(key, stockIs0, sharesIn, 0, address(0), block.timestamp);
    }

    function agentBuy(uint256 cashIn) internal returns (uint256 shares) {
        vm.prank(agent);
        shares = router.swapExactIn(key, !stockIs0, cashIn, 0, alice, block.timestamp);
    }
}

import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";

library StateLibraryView {
    using PoolIdLibrary for PoolKey;

    function getSlot0(IPoolManager m, PoolKey memory k) internal view returns (uint160, int24, uint24, uint24) {
        return StateLibrary.getSlot0(m, k.toId());
    }
}
