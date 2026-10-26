// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

interface IERC20Like {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title FletcheryRouter  (Fletchery · Execution module, on-chain leg)
/// @notice The broker gateway contract. Brokers (or their customers' wallets) send orders here;
///         it stamps the caller's identity into hookData so the FletcheryHook can enforce
///         credentials and agent mandates without trusting user-supplied data.
///         When `onBehalfOf` is set, the caller is an AI agent spending the principal's funds:
///         the principal pays and receives, and the hook enforces the principal's mandate.
contract FletcheryRouter is IUnlockCallback {
    using BalanceDeltaLibrary for BalanceDelta;

    IPoolManager public immutable manager;

    enum Action {
        SWAP,
        LIQUIDITY
    }

    struct CallbackData {
        Action action;
        PoolKey key;
        SwapParams swap;
        ModifyLiquidityParams liq;
        address payer;
        bytes hookData;
    }

    error Expired();
    error Slippage(uint256 out, uint256 minOut);
    error NotManager();

    event Routed(address indexed trader, address indexed principal, bool zeroForOne, uint256 amountIn, uint256 amountOut);

    constructor(IPoolManager _manager) {
        manager = _manager;
    }

    /// @notice Exact-input swap. Tokens are pulled from the payer (caller, or principal for agents)
    ///         and the output is sent to the same account.
    function swapExactIn(
        PoolKey calldata key,
        bool zeroForOne,
        uint256 amountIn,
        uint256 minOut,
        address onBehalfOf,
        uint256 deadline
    ) external returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert Expired();
        address principal = onBehalfOf == address(0) ? msg.sender : onBehalfOf;
        SwapParams memory sp = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -int256(amountIn),
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
        CallbackData memory cb;
        cb.action = Action.SWAP;
        cb.key = key;
        cb.swap = sp;
        cb.payer = principal;
        cb.hookData = abi.encode(msg.sender, principal);
        BalanceDelta d = abi.decode(manager.unlock(abi.encode(cb)), (BalanceDelta));
        int128 out = zeroForOne ? d.amount1() : d.amount0();
        amountOut = uint256(uint128(out));
        if (amountOut < minOut) revert Slippage(amountOut, minOut);
        emit Routed(msg.sender, principal, zeroForOne, amountIn, amountOut);
    }

    /// @notice Add or remove liquidity for the caller (market makers / LPs must be credentialed).
    function modifyLiquidity(PoolKey calldata key, ModifyLiquidityParams calldata params, uint256 deadline)
        external
        returns (BalanceDelta delta)
    {
        if (block.timestamp > deadline) revert Expired();
        CallbackData memory cb;
        cb.action = Action.LIQUIDITY;
        cb.key = key;
        cb.liq = params;
        cb.payer = msg.sender;
        cb.hookData = abi.encode(msg.sender, msg.sender);
        delta = abi.decode(manager.unlock(abi.encode(cb)), (BalanceDelta));
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert NotManager();
        CallbackData memory cb = abi.decode(raw, (CallbackData));
        BalanceDelta delta;
        if (cb.action == Action.SWAP) {
            delta = manager.swap(cb.key, cb.swap, cb.hookData);
        } else {
            (delta,) = manager.modifyLiquidity(cb.key, cb.liq, cb.hookData);
        }
        _settleOrTake(cb.key.currency0, delta.amount0(), cb.payer);
        _settleOrTake(cb.key.currency1, delta.amount1(), cb.payer);
        return abi.encode(delta);
    }

    function _settleOrTake(Currency currency, int128 amount, address account) internal {
        if (amount < 0) {
            manager.sync(currency);
            IERC20Like(Currency.unwrap(currency)).transferFrom(account, address(manager), uint256(uint128(-amount)));
            manager.settle();
        } else if (amount > 0) {
            manager.take(currency, account, uint256(uint128(amount)));
        }
    }
}
