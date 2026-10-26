// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {Roles} from "../access/Roles.sol";

/// @title ProofAnchor  (Fletchery · Proof module)
/// @notice The Fletchery engine keeps a hash-chained log of every quote, route decision, fill and
///         report. Periodically it anchors the head of that chain here. Anyone holding the log can
///         then prove to a regulator, auditor or acquirer that nothing was edited after the fact.
contract ProofAnchor is Roles {
    bytes32 public constant ANCHORER = keccak256("ANCHORER");

    struct Anchor {
        bytes32 head; // hash of the last log entry in the batch (chain head)
        uint64 fromSeq;
        uint64 toSeq;
        uint64 at;
        string uri; // where the batch can be fetched (e.g. s3://, ipfs://)
    }

    Anchor[] public anchors;
    mapping(bytes32 head => uint256 indexPlusOne) public anchorIndex;

    event Anchored(uint256 indexed index, bytes32 indexed head, uint64 fromSeq, uint64 toSeq, string uri);

    error NonContiguous(uint64 expectedFrom, uint64 got);
    error BadRange();

    constructor(address initialOwner) Roles(initialOwner) {}

    function anchor(bytes32 head, uint64 fromSeq, uint64 toSeq, string calldata uri) external onlyRole(ANCHORER) {
        if (toSeq < fromSeq) revert BadRange();
        uint256 n = anchors.length;
        uint64 expected = n == 0 ? 0 : anchors[n - 1].toSeq + 1;
        if (fromSeq != expected) revert NonContiguous(expected, fromSeq);
        anchors.push(Anchor(head, fromSeq, toSeq, uint64(block.timestamp), uri));
        anchorIndex[head] = n + 1;
        emit Anchored(n, head, fromSeq, toSeq, uri);
    }

    function count() external view returns (uint256) {
        return anchors.length;
    }

    function isAnchored(bytes32 head) external view returns (bool) {
        return anchorIndex[head] != 0;
    }
}
