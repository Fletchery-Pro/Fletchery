// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {Roles} from "../access/Roles.sol";

/// @title FairValueOracle  (Fletchery · Safety module, "Weekend Guard")
/// @notice Publishes a fair value for each tokenized stock around the clock, with the session it
///         was computed in and a confidence interval. During regular hours fair value is the
///         primary-market NBBO mid; overnight and at weekends it is the last close moved by
///         proxies (index futures, ADRs, offshore venues), computed by the Fletchery engine.
///         The venue hook refuses to trade a pool whose price strays outside the allowed band,
///         which is what stops a thin pool printing a glitch price after hours.
contract FairValueOracle is Roles {
    bytes32 public constant REPORTER = keccak256("REPORTER");

    enum Session {
        CLOSED, // weekends and holidays
        OVERNIGHT, // 20:00–04:00 ET
        EXTENDED, // 04:00–09:30 and 16:00–20:00 ET
        REGULAR // 09:30–16:00 ET
    }

    struct Quote {
        uint128 priceE8; // fair value in USD, 8 decimals
        uint32 confidenceBps; // one-sided confidence half-width
        uint64 updatedAt;
        Session session;
    }

    struct BandPolicy {
        uint32 baseBps; // allowed deviation before confidence is added
        uint32 maxStaleness; // seconds; older quotes fail closed
    }

    mapping(bytes32 symbol => Quote) public quotes;
    mapping(Session => BandPolicy) public policy;

    event FairValue(bytes32 indexed symbol, uint128 priceE8, uint32 confidenceBps, Session session);
    event PolicySet(Session indexed session, uint32 baseBps, uint32 maxStaleness);

    error StaleFairValue(bytes32 symbol, uint64 updatedAt);
    error NoFairValue(bytes32 symbol);

    constructor(address initialOwner) Roles(initialOwner) {
        // Defaults: tight in regular hours, progressively wider when the primary market is shut.
        policy[Session.REGULAR] = BandPolicy(300, 120); // ±3%, 2 min
        policy[Session.EXTENDED] = BandPolicy(500, 300); // ±5%, 5 min
        policy[Session.OVERNIGHT] = BandPolicy(700, 600); // ±7%, 10 min
        policy[Session.CLOSED] = BandPolicy(1000, 1800); // ±10%, 30 min
    }

    function setPolicy(Session session, uint32 baseBps, uint32 maxStaleness) external onlyOwner {
        policy[session] = BandPolicy(baseBps, maxStaleness);
        emit PolicySet(session, baseBps, maxStaleness);
    }

    function post(bytes32 symbol, uint128 priceE8, uint32 confidenceBps, Session session)
        external
        onlyRole(REPORTER)
    {
        quotes[symbol] = Quote(priceE8, confidenceBps, uint64(block.timestamp), session);
        emit FairValue(symbol, priceE8, confidenceBps, session);
    }

    /// @notice Allowed price band [lowE8, highE8]. Reverts if no fresh quote (fail closed).
    function band(bytes32 symbol) public view returns (uint256 lowE8, uint256 highE8, uint256 midE8) {
        Quote memory q = quotes[symbol];
        if (q.updatedAt == 0) revert NoFairValue(symbol);
        BandPolicy memory p = policy[q.session];
        if (block.timestamp > uint256(q.updatedAt) + p.maxStaleness) revert StaleFairValue(symbol, q.updatedAt);
        uint256 width = uint256(p.baseBps) + q.confidenceBps;
        if (width > 9_999) width = 9_999;
        midE8 = q.priceE8;
        lowE8 = midE8 * (10_000 - width) / 10_000;
        highE8 = midE8 * (10_000 + width) / 10_000;
    }

    function isWithinBand(bytes32 symbol, uint256 priceE8) external view returns (bool) {
        (uint256 lo, uint256 hi,) = band(symbol);
        return priceE8 >= lo && priceE8 <= hi;
    }
}
