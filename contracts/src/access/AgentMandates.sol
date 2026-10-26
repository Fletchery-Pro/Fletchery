// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {Roles} from "./Roles.sol";

/// @title AgentMandates  (Fletchery · Access module, "Leash")
/// @notice A customer (principal) grants an AI agent a spending mandate: per-trade and per-day
///         notional limits, an expiry, a symbol allowlist and whether it may sell. The venue hook
///         enforces the mandate on-chain at trade time, so a misbehaving agent cannot exceed it
///         even if the broker's off-chain checks fail.
contract AgentMandates is Roles {
    bytes32 public constant ENFORCER = keccak256("ENFORCER"); // venue hooks

    struct Mandate {
        uint128 maxPerTrade; // cash-token units (e.g. dUSD, 6 decimals)
        uint128 dailyLimit; // cash-token units per UTC day
        uint64 expiry;
        bool allowSells;
        bool anySymbol; // if false, only allowlisted symbols
        bool active;
    }

    mapping(address principal => mapping(address agent => Mandate)) public mandates;
    mapping(address principal => mapping(address agent => mapping(bytes32 symbol => bool))) public symbolAllowed;
    mapping(address principal => mapping(address agent => mapping(uint256 day => uint256))) public spentOnDay;

    event MandateSet(
        address indexed principal,
        address indexed agent,
        uint128 maxPerTrade,
        uint128 dailyLimit,
        uint64 expiry,
        bool allowSells,
        bool anySymbol
    );
    event MandateSymbol(address indexed principal, address indexed agent, bytes32 indexed symbol, bool allowed);
    event MandateRevoked(address indexed principal, address indexed agent);
    event MandateUsed(
        address indexed principal, address indexed agent, bytes32 indexed symbol, uint256 notional, uint256 spentToday
    );

    error NoMandate();
    error MandateExpired();
    error SymbolNotAllowed(bytes32 symbol);
    error SellsNotAllowed();
    error PerTradeLimit(uint256 notional, uint256 limit);
    error DailyLimit(uint256 wouldSpend, uint256 limit);

    constructor(address initialOwner) Roles(initialOwner) {}

    function setMandate(
        address agent,
        uint128 maxPerTrade,
        uint128 dailyLimit,
        uint64 expiry,
        bool allowSells,
        bool anySymbol
    ) external {
        if (agent == address(0)) revert ZeroAddress();
        mandates[msg.sender][agent] = Mandate(maxPerTrade, dailyLimit, expiry, allowSells, anySymbol, true);
        emit MandateSet(msg.sender, agent, maxPerTrade, dailyLimit, expiry, allowSells, anySymbol);
    }

    function setSymbol(address agent, bytes32 symbol, bool allowed) external {
        symbolAllowed[msg.sender][agent][symbol] = allowed;
        emit MandateSymbol(msg.sender, agent, symbol, allowed);
    }

    /// @notice Kill switch: the principal can cut an agent off instantly.
    function revoke(address agent) external {
        delete mandates[msg.sender][agent];
        emit MandateRevoked(msg.sender, agent);
    }

    /// @notice Read-only pre-check used by brokers and the off-chain router before submitting.
    function canSpend(address principal, address agent, bytes32 symbol, bool isSell, uint256 notional)
        public
        view
        returns (bool ok, bytes memory reason)
    {
        Mandate memory m = mandates[principal][agent];
        if (!m.active) return (false, abi.encodeWithSelector(NoMandate.selector));
        if (m.expiry <= block.timestamp) return (false, abi.encodeWithSelector(MandateExpired.selector));
        if (!m.anySymbol && !symbolAllowed[principal][agent][symbol]) {
            return (false, abi.encodeWithSelector(SymbolNotAllowed.selector, symbol));
        }
        if (isSell && !m.allowSells) return (false, abi.encodeWithSelector(SellsNotAllowed.selector));
        if (notional > m.maxPerTrade) {
            return (false, abi.encodeWithSelector(PerTradeLimit.selector, notional, m.maxPerTrade));
        }
        uint256 would = spentOnDay[principal][agent][block.timestamp / 1 days] + notional;
        if (would > m.dailyLimit) return (false, abi.encodeWithSelector(DailyLimit.selector, would, m.dailyLimit));
        return (true, "");
    }

    /// @notice Called by an enforcing venue hook during a swap. Reverts with the precise reason.
    function consume(address principal, address agent, bytes32 symbol, bool isSell, uint256 notional)
        external
        onlyRole(ENFORCER)
    {
        (bool ok, bytes memory reason) = canSpend(principal, agent, symbol, isSell, notional);
        if (!ok) {
            assembly {
                revert(add(reason, 32), mload(reason))
            }
        }
        uint256 day = block.timestamp / 1 days;
        uint256 spent = spentOnDay[principal][agent][day] + notional;
        spentOnDay[principal][agent][day] = spent;
        emit MandateUsed(principal, agent, symbol, notional, spent);
    }
}
