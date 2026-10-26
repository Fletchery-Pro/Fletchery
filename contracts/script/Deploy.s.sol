// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {CredentialRegistry} from "../src/access/CredentialRegistry.sol";
import {AgentMandates} from "../src/access/AgentMandates.sol";
import {VenueController} from "../src/compliance/VenueController.sol";
import {FairValueOracle} from "../src/safety/FairValueOracle.sol";
import {StockToken} from "../src/rights/StockToken.sol";
import {RightsDistributor} from "../src/rights/RightsDistributor.sol";
import {ProofAnchor} from "../src/proof/ProofAnchor.sol";
import {FletcheryHook} from "../src/FletcheryHook.sol";
import {FletcheryRouter} from "../src/FletcheryRouter.sol";

/// @notice Phase 1 of a local Fletchery venue: deploy every module, wire roles, issue demo
///         credentials and start the 30-day listing notice for AAPL. Phase 2 (Launch.s.sol)
///         runs after the notice period has elapsed.
/// @dev Demo actors are anvil's default accounts 1–5 (public test keys, never use with real funds).
contract Deploy is Script {
    address constant ALICE = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8; // US retail
    address constant BOB = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC; // UK retail
    address constant MM = 0x90F79bf6EB2c4f870365E785982E1f101E93b906; // market maker
    address constant AGENT = 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65; // AI agent (no KYC; mandate only)
    address constant EVE = 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc; // no credential
    uint16 constant US = 840;
    uint16 constant UK = 826;

    PoolManager manager;
    CredentialRegistry creds;
    AgentMandates mandates;
    VenueController venue;
    FairValueOracle oracle;
    RightsDistributor rights;
    ProofAnchor proof;
    StockToken aapl;
    MockERC20 dusd;
    FletcheryHook hook;
    FletcheryRouter router;
    bool stockIs0;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address op = vm.addr(pk);
        vm.startBroadcast(pk);

        manager = new PoolManager(op);
        creds = new CredentialRegistry(op);
        mandates = new AgentMandates(op);
        venue = new VenueController(op, 1);
        oracle = new FairValueOracle(op);
        rights = new RightsDistributor(op);
        proof = new ProofAnchor(op);

        creds.setRole(creds.ATTESTER(), op, true);
        uint64 exp = uint64(block.timestamp + 730 days);
        creds.issue(op, US, CredentialRegistry.InvestorClass.INSTITUTIONAL, exp, keccak256("operator"));
        creds.issue(ALICE, US, CredentialRegistry.InvestorClass.RETAIL, exp, keccak256("alice"));
        creds.issue(BOB, UK, CredentialRegistry.InvestorClass.RETAIL, exp, keccak256("bob"));
        creds.issue(MM, US, CredentialRegistry.InvestorClass.INSTITUTIONAL, exp, keccak256("mm"));

        aapl = new StockToken(op, "Apple Inc. (tokenized)", "AAPL", creds);
        dusd = new MockERC20("Demo Dollar", "dUSD", 6);

        hook = _deployHook(op);
        router = new FletcheryRouter(IPoolManager(address(manager)));

        hook.setRouter(address(router), true);
        hook.setJurisdictionBlocked(408, true); // KP
        venue.setRole(venue.METER(), address(hook), true);
        venue.setRole(venue.LISTING_ADMIN(), op, true);
        venue.setRole(venue.DATA_ORACLE(), op, true);
        venue.setRole(venue.HALT_ORACLE(), op, true);
        mandates.setRole(mandates.ENFORCER(), address(hook), true);
        oracle.setRole(oracle.REPORTER(), op, true);
        proof.setRole(proof.ANCHORER(), op, true);
        rights.setRole(rights.CORPORATE_ACTIONS(), op, true);
        rights.setBeneficiary(address(manager), op); // LP pass-through handled by the operator in the demo
        aapl.setRole(aapl.TRANSFER_AGENT(), op, true);
        aapl.setSystem(address(manager), true);
        aapl.setSystem(address(rights), true);

        venue.noticeListing("AAPL", address(aapl), op, true);

        aapl.mint(op, 100_000e18);
        aapl.mint(ALICE, 1_000e18);
        aapl.mint(BOB, 1_000e18);
        dusd.mint(op, 50_000_000e6);
        dusd.mint(ALICE, 1_000_000e6);
        dusd.mint(BOB, 1_000_000e6);
        dusd.mint(EVE, 10_000e6);

        stockIs0 = address(aapl) < address(dusd);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(stockIs0 ? address(aapl) : address(dusd)),
            currency1: Currency.wrap(stockIs0 ? address(dusd) : address(aapl)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        hook.registerPool(key, "AAPL", stockIs0, 18, 6);
        vm.stopBroadcast();
        _write(op);
    }

    function _write(address op) internal {
        string memory o = "deploy";
        vm.serializeAddress(o, "operator", op);
        vm.serializeAddress(o, "poolManager", address(manager));
        vm.serializeAddress(o, "credentials", address(creds));
        vm.serializeAddress(o, "mandates", address(mandates));
        vm.serializeAddress(o, "venue", address(venue));
        vm.serializeAddress(o, "oracle", address(oracle));
        vm.serializeAddress(o, "rights", address(rights));
        vm.serializeAddress(o, "proof", address(proof));
        vm.serializeAddress(o, "aapl", address(aapl));
        vm.serializeAddress(o, "dusd", address(dusd));
        vm.serializeAddress(o, "hook", address(hook));
        vm.serializeBool(o, "stockIsCurrency0", stockIs0);
        vm.serializeAddress(o, "alice", ALICE);
        vm.serializeAddress(o, "bob", BOB);
        vm.serializeAddress(o, "marketMaker", MM);
        vm.serializeAddress(o, "agent", AGENT);
        vm.serializeAddress(o, "eve", EVE);
        string memory json = vm.serializeAddress(o, "router", address(router));
        vm.writeJson(json, "../deployments/local.json");
        console2.log("hook", address(hook));
        console2.log("router", address(router));
    }

    /// @dev Uniswap v4 reads a hook's permissions from the low bits of its address, so mine a
    ///      CREATE2 salt that yields an address with exactly our flags.
    function _deployHook(address op) internal returns (FletcheryHook h) {
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
                | Hooks.AFTER_SWAP_FLAG
        );
        bytes memory initCode = abi.encodePacked(
            type(FletcheryHook).creationCode, abi.encode(op, IPoolManager(address(manager)), creds, mandates, venue, oracle)
        );
        bytes32 initHash = keccak256(initCode);
        bytes32 salt;
        for (uint256 i; i < 200_000; i++) {
            salt = bytes32(i);
            address a = vm.computeCreate2Address(salt, initHash, CREATE2_FACTORY);
            if (uint160(a) & Hooks.ALL_HOOK_MASK == flags && a.code.length == 0) break;
        }
        h = new FletcheryHook{salt: salt}(op, IPoolManager(address(manager)), creds, mandates, venue, oracle);
        require(uint160(address(h)) & Hooks.ALL_HOOK_MASK == flags, "hook address mining failed");
    }
}
