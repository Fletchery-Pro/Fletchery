// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

/// @title Roles
/// @notice Minimal owner + role-based access control shared by every Fletchery module.
/// @dev Kept deliberately small so each module is auditable on its own.
abstract contract Roles {
    address public owner;
    address public pendingOwner;
    mapping(bytes32 role => mapping(address account => bool)) public hasRole;

    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);
    event RoleSet(bytes32 indexed role, address indexed account, bool enabled);

    error NotOwner();
    error MissingRole(bytes32 role, address account);
    error ZeroAddress();

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyRole(bytes32 role) {
        if (!hasRole[role][msg.sender]) revert MissingRole(role, msg.sender);
        _;
    }

    function setRole(bytes32 role, address account, bool enabled) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        hasRole[role][account] = enabled;
        emit RoleSet(role, account, enabled);
    }

    /// @notice Two-step ownership transfer so a typo cannot brick a venue.
    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
