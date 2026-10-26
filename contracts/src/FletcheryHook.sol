// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {Roles} from "./access/Roles.sol";
import {CredentialRegistry} from "./access/CredentialRegistry.sol";
import {AgentMandates} from "./access/AgentMandates.sol";
import {VenueController} from "./compliance/VenueController.sol";
import {FairValueOracle} from "./safety/FairValueOracle.sol";

/// @title FletcheryHook
/// @notice A Uniswap v4 hook that turns an ordinary AMM pool into a compliant, permissioned
///         Tokenized Securities Venue pool. On every swap it checks, in order:
///           1. the order came through an approved broker gateway (router)
///           2. the trader holds a live credential, from an allowed jurisdiction and class
///           3. the symbol is listed, not halted and not stopped           (VenueController)
///           4. if an AI agent is trading for a customer, the agent's mandate allows it
///           5. the fill stays inside the venue's monthly volume cap      (VenueController)
///           6. the post-trade price is inside the fair-value band, or moves back toward it
///         then emits a CAT-style Fill event that the off-chain reporter turns into regulatory files.
///         Brokers plug in once; any venue running this hook accepts their customers.
contract FletcheryHook is IHooks, Roles {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using BalanceDeltaLibrary for BalanceDelta;

    struct PoolConfig {
        bytes32 symbol;
        bool stockIsCurrency0;
        uint8 stockDecimals;
        uint8 cashDecimals;
        bool registered;
    }

    IPoolManager public immutable manager;
    CredentialRegistry public immutable credentials;
    AgentMandates public immutable mandates;
    VenueController public immutable venue;
    FairValueOracle public immutable oracle;

    mapping(PoolId => PoolConfig) public pools;
    mapping(address router => bool) public approvedRouter;
    mapping(uint16 jurisdiction => bool) public blockedJurisdiction;
    CredentialRegistry.InvestorClass public minClass = CredentialRegistry.InvestorClass.RETAIL;

    /// @dev transient slot holding the pre-swap sqrtPrice for the band check
    bytes32 private constant PRE_PRICE_SLOT = keccak256("fletchery.prePrice");

    event PoolRegistered(PoolId indexed id, bytes32 indexed symbol, bool stockIsCurrency0);
    event RouterApproved(address indexed router, bool approved);
    event JurisdictionBlocked(uint16 indexed jurisdiction, bool blocked);
    event MinClassSet(CredentialRegistry.InvestorClass minClass);
    /// @notice One event per fill; the off-chain reporter builds CAT / best-ex files from these.
    event Fill(
        PoolId indexed id,
        bytes32 indexed symbol,
        address indexed trader,
        address principal,
        address router,
        bool isSell,
        uint256 stockAmount,
        uint256 cashAmount,
        uint256 priceE8,
        uint256 fairValueE8
    );

    error NotPoolManager();
    error HookNotImplemented();
    error PoolNotRegistered();
    error RouterNotApproved(address router);
    error NoCredential(address account);
    error JurisdictionNotAllowed(uint16 jurisdiction);
    error InvestorClassTooLow();
    error PriceOutOfBand(uint256 priceE8, uint256 lowE8, uint256 highE8);
    error NotOperator();

    constructor(
        address initialOwner,
        IPoolManager _manager,
        CredentialRegistry _credentials,
        AgentMandates _mandates,
        VenueController _venue,
        FairValueOracle _oracle
    ) Roles(initialOwner) {
        manager = _manager;
        credentials = _credentials;
        mandates = _mandates;
        venue = _venue;
        oracle = _oracle;
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    modifier onlyManager() {
        if (msg.sender != address(manager)) revert NotPoolManager();
        _;
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeAddLiquidity = true;
        p.beforeSwap = true;
        p.afterSwap = true;
    }

    // ───────────────────────────── admin ─────────────────────────────

    function registerPool(PoolKey calldata key, bytes32 symbol, bool stockIsCurrency0, uint8 stockDec, uint8 cashDec)
        external
        onlyOwner
    {
        PoolId id = key.toId();
        pools[id] = PoolConfig(symbol, stockIsCurrency0, stockDec, cashDec, true);
        emit PoolRegistered(id, symbol, stockIsCurrency0);
    }

    function setRouter(address router, bool approved) external onlyOwner {
        approvedRouter[router] = approved;
        emit RouterApproved(router, approved);
    }

    function setJurisdictionBlocked(uint16 jurisdiction, bool blocked) external onlyOwner {
        blockedJurisdiction[jurisdiction] = blocked;
        emit JurisdictionBlocked(jurisdiction, blocked);
    }

    function setMinClass(CredentialRegistry.InvestorClass c) external onlyOwner {
        minClass = c;
        emit MinClassSet(c);
    }

    // ───────────────────────────── hooks ─────────────────────────────

    function beforeInitialize(address sender, PoolKey calldata key, uint160) external view onlyManager returns (bytes4) {
        if (sender != owner) revert NotOperator();
        if (!pools[key.toId()].registered) revert PoolNotRegistered();
        return IHooks.beforeInitialize.selector;
    }

    function beforeAddLiquidity(address sender, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata hookData)
        external
        view
        onlyManager
        returns (bytes4)
    {
        (address actor,) = _actors(sender, hookData);
        _requireEligible(actor);
        return IHooks.beforeAddLiquidity.selector;
    }

    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata, bytes calldata hookData)
        external
        onlyManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolConfig memory cfg = pools[key.toId()];
        if (!cfg.registered) revert PoolNotRegistered();
        // The beneficial owner must be credentialed. An AI agent trading for them needs no KYC of
        // its own; it is authorised by the owner's mandate, checked in afterSwap.
        (, address principal) = _actors(sender, hookData);
        _requireEligible(principal);
        venue.requireTradable(cfg.symbol);

        (uint160 sqrtP,,,) = manager.getSlot0(key.toId());
        bytes32 slot = PRE_PRICE_SLOT;
        assembly {
            tstore(slot, sqrtP)
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata,
        BalanceDelta delta,
        bytes calldata hookData
    ) external onlyManager returns (bytes4, int128) {
        FillData memory f;
        f.id = key.toId();
        PoolConfig memory cfg = pools[f.id];
        f.router = sender;
        (f.trader, f.principal) = _actors(sender, hookData);

        int128 s = cfg.stockIsCurrency0 ? delta.amount0() : delta.amount1();
        int128 c = cfg.stockIsCurrency0 ? delta.amount1() : delta.amount0();
        f.isSell = s < 0; // trader paid stock into the pool
        f.stockAmt = _abs(s);
        f.cashAmt = _abs(c);

        // 4. agent mandate (notional only known after the swap)
        if (f.principal != f.trader) mandates.consume(f.principal, f.trader, cfg.symbol, f.isSell, f.cashAmt);

        // 5. monthly volume cap (reverts on breach → whole swap unwinds)
        venue.recordVolume(cfg.symbol, f.stockAmt);

        // 6. fair-value band
        f.fairValue = _checkBand(f.id, cfg);

        if (f.stockAmt != 0) {
            f.priceE8 = f.cashAmt * 1e8 * (10 ** cfg.stockDecimals) / f.stockAmt / (10 ** cfg.cashDecimals);
        }
        _emitFill(f, cfg.symbol);
        return (IHooks.afterSwap.selector, 0);
    }

    struct FillData {
        PoolId id;
        address trader;
        address principal;
        address router;
        bool isSell;
        uint256 stockAmt;
        uint256 cashAmt;
        uint256 priceE8;
        uint256 fairValue;
    }

    function _emitFill(FillData memory f, bytes32 symbol) internal {
        emit Fill(f.id, symbol, f.trader, f.principal, f.router, f.isSell, f.stockAmt, f.cashAmt, f.priceE8, f.fairValue);
    }

    // ───────────────────────────── views ─────────────────────────────

    /// @notice Current pool price of one whole share in cash units, 8 decimals.
    function poolPriceE8(PoolKey calldata key) external view returns (uint256) {
        PoolConfig memory cfg = pools[key.toId()];
        (uint160 sqrtP,,,) = manager.getSlot0(key.toId());
        return _priceE8(sqrtP, cfg);
    }

    // ───────────────────────────── internals ─────────────────────────────

    /// @dev Only approved routers may route; they encode (trader, principal) in hookData. A router
    ///      always sets trader = its msg.sender, so the identity cannot be spoofed.
    function _actors(address sender, bytes calldata hookData) internal view returns (address trader, address principal) {
        if (!approvedRouter[sender]) revert RouterNotApproved(sender);
        (trader, principal) = abi.decode(hookData, (address, address));
        if (principal == address(0)) principal = trader;
    }

    function _requireEligible(address account) internal view {
        (bool valid, uint16 j, CredentialRegistry.InvestorClass cls) = credentials.check(account);
        if (!valid) revert NoCredential(account);
        if (blockedJurisdiction[j]) revert JurisdictionNotAllowed(j);
        if (uint8(cls) < uint8(minClass)) revert InvestorClassTooLow();
    }

    function _checkBand(PoolId id, PoolConfig memory cfg) internal view returns (uint256 mid) {
        (uint256 lo, uint256 hi, uint256 m) = oracle.band(cfg.symbol); // reverts if stale: fail closed
        mid = m;
        uint160 preSqrt;
        bytes32 slot = PRE_PRICE_SLOT;
        assembly {
            preSqrt := tload(slot)
        }
        (uint160 postSqrt,,,) = manager.getSlot0(id);
        uint256 post = _priceE8(postSqrt, cfg);
        uint256 dPost = _outside(post, lo, hi);
        if (dPost == 0) return mid;
        // Outside the band: allow only if the trade moved the price back toward fair value
        // (arbitrage that repairs a dislocated pool must never be blocked).
        uint256 dPre = _outside(_priceE8(preSqrt, cfg), lo, hi);
        if (dPost >= dPre) revert PriceOutOfBand(post, lo, hi);
    }

    function _outside(uint256 p, uint256 lo, uint256 hi) internal pure returns (uint256) {
        if (p < lo) return lo - p;
        if (p > hi) return p - hi;
        return 0;
    }

    function _priceE8(uint160 sqrtP, PoolConfig memory cfg) internal pure returns (uint256) {
        uint256 priceX128 = FullMath.mulDiv(sqrtP, sqrtP, 1 << 64); // token1/token0 raw, Q128
        uint256 num = 1e8 * (10 ** cfg.stockDecimals);
        uint256 den = 10 ** cfg.cashDecimals;
        if (cfg.stockIsCurrency0) return FullMath.mulDiv(priceX128, num, den) >> 128;
        if (priceX128 == 0) return type(uint256).max;
        return FullMath.mulDiv(num, 1 << 128, priceX128) / den;
    }

    function _abs(int128 x) internal pure returns (uint256) {
        return uint256(uint128(x < 0 ? -x : x));
    }

    // ─────────────────────── unused hook entry points ───────────────────────

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}
