// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {Roles} from "./Roles.sol";

/// @title CredentialRegistry  (Fletchery · Access module)
/// @notice Non-transferable investor credentials written by brokers and KYC providers ("attesters").
///         One broker's KYC is reusable at every venue that trusts that attester. This is the piece
///         that lets a broker's customer reach an SEC Tokenized Securities Venue (TSV) pool without
///         the venue running its own onboarding, and without minting a soulbound NFT per venue.
/// @dev No personal data is stored on-chain: only a jurisdiction code, an investor class, an expiry
///      and a hash pointing to the attester's off-chain KYC record.
contract CredentialRegistry is Roles {
    bytes32 public constant ATTESTER = keccak256("ATTESTER");

    enum InvestorClass {
        NONE,
        RETAIL,
        ACCREDITED,
        INSTITUTIONAL
    }

    struct Credential {
        uint64 expiry; // unix seconds
        uint16 jurisdiction; // ISO 3166-1 numeric (840 = US, 826 = UK, 276 = DE ...)
        InvestorClass class;
        bool revoked;
        address attester;
        bytes32 kycRef; // hash of the attester's off-chain record
    }

    mapping(address account => Credential) internal _credentials;

    event CredentialIssued(
        address indexed account,
        address indexed attester,
        uint16 jurisdiction,
        InvestorClass class,
        uint64 expiry,
        bytes32 kycRef
    );
    event CredentialRevoked(address indexed account, address indexed by, bytes32 reason);

    error InvalidCredential();
    error NotIssuingAttester();

    constructor(address initialOwner) Roles(initialOwner) {}

    /// @notice Issue or refresh a credential. Any trusted attester may refresh any credential;
    ///         the latest attester becomes responsible for it.
    function issue(address account, uint16 jurisdiction, InvestorClass class, uint64 expiry, bytes32 kycRef)
        external
        onlyRole(ATTESTER)
    {
        if (account == address(0)) revert ZeroAddress();
        if (class == InvestorClass.NONE || expiry <= block.timestamp || jurisdiction == 0) {
            revert InvalidCredential();
        }
        _credentials[account] = Credential({
            expiry: expiry,
            jurisdiction: jurisdiction,
            class: class,
            revoked: false,
            attester: msg.sender,
            kycRef: kycRef
        });
        emit CredentialIssued(account, msg.sender, jurisdiction, class, expiry, kycRef);
    }

    /// @notice The issuing attester, or the registry owner (e.g. on a regulator request), can revoke.
    function revoke(address account, bytes32 reason) external {
        Credential storage c = _credentials[account];
        if (msg.sender != owner && msg.sender != c.attester) revert NotIssuingAttester();
        c.revoked = true;
        emit CredentialRevoked(account, msg.sender, reason);
    }

    function credentialOf(address account) external view returns (Credential memory) {
        return _credentials[account];
    }

    /// @notice True when the account holds a live credential from a currently-trusted attester.
    function isValid(address account) public view returns (bool) {
        Credential storage c = _credentials[account];
        return !c.revoked && c.expiry > block.timestamp && c.class != InvestorClass.NONE
            && hasRole[ATTESTER][c.attester];
    }

    /// @notice Returns (valid, jurisdiction, class) in one call for the hook's hot path.
    function check(address account) external view returns (bool valid, uint16 jurisdiction, InvestorClass class) {
        Credential storage c = _credentials[account];
        return (isValid(account), c.jurisdiction, c.class);
    }
}
