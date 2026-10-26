// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {LiquidityAmounts} from "@uniswap/v4-core/test/utils/LiquidityAmounts.sol";

import {VenueController} from "../src/compliance/VenueController.sol";
import {FairValueOracle} from "../src/safety/FairValueOracle.sol";
import {StockToken} from "../src/rights/StockToken.sol";
import {FletcheryRouter} from "../src/FletcheryRouter.sol";

/// @notice Phase 2: after the 30-day notice, activate AAPL, post this month's cap basis and a
///         fair value, open the pool at $200 and seed it with 10,000 shares / $2m of liquidity.
contract Launch is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        string memory json = vm.readFile("../deployments/local.json");
        VenueController venue = VenueController(vm.parseJsonAddress(json, ".venue"));
        FairValueOracle oracle = FairValueOracle(vm.parseJsonAddress(json, ".oracle"));
        IPoolManager manager = IPoolManager(vm.parseJsonAddress(json, ".poolManager"));
        FletcheryRouter router = FletcheryRouter(vm.parseJsonAddress(json, ".router"));
        StockToken aapl = StockToken(vm.parseJsonAddress(json, ".aapl"));
        MockERC20 dusd = MockERC20(vm.parseJsonAddress(json, ".dusd"));
        address hook = vm.parseJsonAddress(json, ".hook");
        bool stockIs0 = vm.parseJsonBool(json, ".stockIsCurrency0");

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(stockIs0 ? address(aapl) : address(dusd)),
            currency1: Currency.wrap(stockIs0 ? address(dusd) : address(aapl)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(hook)
        });

        vm.startBroadcast(pk);
        venue.activateListing("AAPL");
        venue.setCapBasis("AAPL", 4_000_000e18); // prior-month ADV 4m shares → cap 10,000 shares
        oracle.post("AAPL", 200e8, 10, FairValueOracle.Session.REGULAR);

        uint160 sqrtP = _sqrtPrice(200e8, stockIs0);
        manager.initialize(key, sqrtP);

        aapl.approve(address(router), type(uint256).max);
        dusd.approve(address(router), type(uint256).max);
        int24 tick = TickMath.getTickAtSqrtPrice(sqrtP);
        int24 lower = ((tick - 2000) / 60) * 60;
        int24 upper = ((tick + 2000) / 60) * 60;
        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP,
            TickMath.getSqrtPriceAtTick(lower),
            TickMath.getSqrtPriceAtTick(upper),
            stockIs0 ? 10_000e18 : 2_000_000e6,
            stockIs0 ? 2_000_000e6 : 10_000e18
        );
        router.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, int256(uint256(liq)), 0), block.timestamp + 600);
        vm.stopBroadcast();
        console2.log("AAPL pool live at $200 with liquidity", uint256(liq));
    }

    function _sqrtPrice(uint256 priceE8, bool stockIs0) internal pure returns (uint160) {
        uint256 cashPerShareRaw = priceE8 * 1e6 / 1e8;
        uint256 ratioX192 = stockIs0
            ? FullMath.mulDiv(cashPerShareRaw, 1 << 192, 1e18)
            : FullMath.mulDiv(1e18, 1 << 192, cashPerShareRaw);
        return uint160(FixedPointMathLib.sqrt(ratioX192));
    }
}
