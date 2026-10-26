// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {Roles} from "../access/Roles.sol";
import {CredentialRegistry} from "../access/CredentialRegistry.sol";

/// @title StockToken  (Fletchery · Rights module)
/// @notice A permissioned token representing one share of an underlying equity held by a
///         transfer agent. Only credentialed holders (or approved system contracts such as the
///         Uniswap v4 PoolManager and broker routers) can hold or receive it.
///         Balance snapshots at record dates make dividends and proxy votes exact, which the SEC
///         exemption requires ("full shareholder rights") and today's offshore stock tokens lack.
contract StockToken is Roles {
    bytes32 public constant TRANSFER_AGENT = keccak256("TRANSFER_AGENT");

    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    bytes32 public immutable ticker;
    CredentialRegistry public immutable registry;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isSystem; // PoolManager, routers, distributors

    // snapshots (record dates)
    struct Checkpoint {
        uint64 snapshotId;
        uint192 value;
    }

    uint64 public currentSnapshotId;
    mapping(uint64 id => uint64 timestamp) public snapshotTime;
    mapping(address => Checkpoint[]) internal _balanceCheckpoints;
    Checkpoint[] internal _supplyCheckpoints;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event SystemSet(address indexed account, bool enabled);
    event Snapshot(uint64 indexed id, uint64 timestamp);

    error NotEligible(address account);
    error InsufficientBalance();
    error InsufficientAllowance();
    error FutureSnapshot();

    constructor(address initialOwner, string memory _name, string memory _symbol, CredentialRegistry _registry)
        Roles(initialOwner)
    {
        name = _name;
        symbol = _symbol;
        ticker = bytes32(bytes(_symbol));
        registry = _registry;
    }

    function setSystem(address account, bool enabled) external onlyOwner {
        isSystem[account] = enabled;
        emit SystemSet(account, enabled);
    }

    function canHold(address account) public view returns (bool) {
        return isSystem[account] || registry.isValid(account);
    }

    // ───────────────────────── ERC-20 ─────────────────────────

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            if (a < amount) revert InsufficientAllowance();
            allowance[from][msg.sender] = a - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    // ───────────────────────── transfer agent ─────────────────────────

    /// @notice Mint when a share is deposited with the transfer agent (brokerage → wallet conversion).
    function mint(address to, uint256 amount) external onlyRole(TRANSFER_AGENT) {
        if (!canHold(to)) revert NotEligible(to);
        _updateSnapshot(to);
        _updateSupplySnapshot();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    /// @notice Burn when a holder redeems back into a brokerage position (wallet → brokerage).
    function burn(address from, uint256 amount) external onlyRole(TRANSFER_AGENT) {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        _updateSnapshot(from);
        _updateSupplySnapshot();
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    /// @notice Fix a record date. Returns the snapshot id used by RightsDistributor.
    function snapshot() external onlyRole(TRANSFER_AGENT) returns (uint64 id) {
        id = ++currentSnapshotId;
        snapshotTime[id] = uint64(block.timestamp);
        emit Snapshot(id, uint64(block.timestamp));
    }

    function balanceOfAt(address account, uint64 id) public view returns (uint256) {
        return _valueAt(_balanceCheckpoints[account], id, balanceOf[account]);
    }

    function totalSupplyAt(uint64 id) public view returns (uint256) {
        return _valueAt(_supplyCheckpoints, id, totalSupply);
    }

    // ───────────────────────── internals ─────────────────────────

    function _transfer(address from, address to, uint256 amount) internal {
        if (!canHold(from)) revert NotEligible(from);
        if (!canHold(to)) revert NotEligible(to);
        if (balanceOf[from] < amount) revert InsufficientBalance();
        _updateSnapshot(from);
        _updateSnapshot(to);
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    /// @dev Store the pre-change balance against the current snapshot id (lazy, OZ-style).
    function _updateSnapshot(address account) internal {
        _write(_balanceCheckpoints[account], balanceOf[account]);
    }

    function _updateSupplySnapshot() internal {
        _write(_supplyCheckpoints, totalSupply);
    }

    function _write(Checkpoint[] storage cps, uint256 value) internal {
        uint64 id = currentSnapshotId;
        if (id == 0) return;
        uint256 n = cps.length;
        if (n == 0 || cps[n - 1].snapshotId < id) cps.push(Checkpoint(id, uint192(value)));
    }

    /// @dev The first checkpoint with snapshotId >= id holds the value at that snapshot.
    function _valueAt(Checkpoint[] storage cps, uint64 id, uint256 current) internal view returns (uint256) {
        if (id == 0 || id > currentSnapshotId) revert FutureSnapshot();
        uint256 lo = 0;
        uint256 hi = cps.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (cps[mid].snapshotId < id) lo = mid + 1;
            else hi = mid;
        }
        return lo == cps.length ? current : cps[lo].value;
    }
}
