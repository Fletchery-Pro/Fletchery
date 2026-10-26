// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {Roles} from "../access/Roles.sol";
import {StockToken} from "./StockToken.sol";

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title RightsDistributor  (Fletchery · Rights module, "Rightsrail")
/// @notice Pays cash dividends and runs proxy votes for StockToken holders, using record-date
///         snapshots. Shares held by system contracts (for example the Uniswap v4 PoolManager,
///         which holds liquidity providers' shares) are paid to a designated beneficiary that
///         passes them through, so no economic right is lost because a share sat in a pool.
contract RightsDistributor is Roles {
    bytes32 public constant CORPORATE_ACTIONS = keccak256("CORPORATE_ACTIONS");

    struct Dividend {
        StockToken token;
        uint64 snapshotId;
        IERC20Min cash;
        uint256 amountPerShareE18; // cash units per 1e18 token units
        uint64 payableAt;
        uint256 funded;
        uint256 claimed;
    }

    struct Vote {
        StockToken token;
        uint64 snapshotId;
        bytes32 proposalHash; // hash of the issuer's proxy statement item
        uint64 deadline;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
    }

    Dividend[] public dividends;
    Vote[] public votes;
    mapping(uint256 divId => mapping(address => bool)) public dividendClaimed;
    mapping(uint256 voteId => mapping(address => bool)) public hasVoted;
    /// @notice Who receives entitlements of a system holder (e.g. PoolManager → LP pass-through vault).
    mapping(address systemHolder => address beneficiary) public beneficiaryOf;

    event BeneficiarySet(address indexed systemHolder, address indexed beneficiary);
    event DividendDeclared(
        uint256 indexed id, address indexed token, uint64 snapshotId, address cash, uint256 amountPerShareE18
    );
    event DividendClaimed(uint256 indexed id, address indexed holder, address indexed to, uint256 amount);
    event VoteOpened(uint256 indexed id, address indexed token, uint64 snapshotId, bytes32 proposalHash, uint64 deadline);
    event VoteCast(uint256 indexed id, address indexed voter, uint8 support, uint256 weight);

    error NotPayableYet();
    error AlreadyClaimed();
    error NothingToClaim();
    error NotBeneficiary();
    error VoteClosed();
    error AlreadyVoted();
    error BadSupport();

    constructor(address initialOwner) Roles(initialOwner) {}

    function setBeneficiary(address systemHolder, address beneficiary) external onlyOwner {
        beneficiaryOf[systemHolder] = beneficiary;
        emit BeneficiarySet(systemHolder, beneficiary);
    }

    /// @notice Declare and fully fund a dividend in one step (funds pulled from the caller).
    function declareDividend(
        StockToken token,
        uint64 snapshotId,
        IERC20Min cash,
        uint256 amountPerShareE18,
        uint64 payableAt
    ) external onlyRole(CORPORATE_ACTIONS) returns (uint256 id) {
        uint256 total = token.totalSupplyAt(snapshotId) * amountPerShareE18 / 1e18;
        require(cash.transferFrom(msg.sender, address(this), total), "fund");
        id = dividends.length;
        dividends.push(Dividend(token, snapshotId, cash, amountPerShareE18, payableAt, total, 0));
        emit DividendDeclared(id, address(token), snapshotId, address(cash), amountPerShareE18);
    }

    function entitlement(uint256 id, address holder) public view returns (uint256) {
        Dividend storage d = dividends[id];
        return d.token.balanceOfAt(holder, d.snapshotId) * d.amountPerShareE18 / 1e18;
    }

    /// @notice Holders claim for themselves; beneficiaries claim on behalf of a system holder.
    function claim(uint256 id, address holder) external returns (uint256 amount) {
        Dividend storage d = dividends[id];
        if (block.timestamp < d.payableAt) revert NotPayableYet();
        address to = holder;
        if (msg.sender != holder) {
            if (beneficiaryOf[holder] != msg.sender) revert NotBeneficiary();
            to = msg.sender;
        }
        if (dividendClaimed[id][holder]) revert AlreadyClaimed();
        amount = entitlement(id, holder);
        if (amount == 0) revert NothingToClaim();
        dividendClaimed[id][holder] = true;
        d.claimed += amount;
        require(d.cash.transfer(to, amount), "pay");
        emit DividendClaimed(id, holder, to, amount);
    }

    function openVote(StockToken token, uint64 snapshotId, bytes32 proposalHash, uint64 deadline)
        external
        onlyRole(CORPORATE_ACTIONS)
        returns (uint256 id)
    {
        id = votes.length;
        votes.push(Vote(token, snapshotId, proposalHash, deadline, 0, 0, 0));
        emit VoteOpened(id, address(token), snapshotId, proposalHash, deadline);
    }

    /// @param support 0 = against, 1 = for, 2 = abstain
    function castVote(uint256 id, uint8 support) external returns (uint256 weight) {
        Vote storage v = votes[id];
        if (block.timestamp > v.deadline) revert VoteClosed();
        if (hasVoted[id][msg.sender]) revert AlreadyVoted();
        if (support > 2) revert BadSupport();
        weight = v.token.balanceOfAt(msg.sender, v.snapshotId);
        if (weight == 0) revert NothingToClaim();
        hasVoted[id][msg.sender] = true;
        if (support == 0) v.againstVotes += weight;
        else if (support == 1) v.forVotes += weight;
        else v.abstainVotes += weight;
        emit VoteCast(id, msg.sender, support, weight);
    }

    function dividendCount() external view returns (uint256) {
        return dividends.length;
    }

    function voteCount() external view returns (uint256) {
        return votes.length;
    }
}
