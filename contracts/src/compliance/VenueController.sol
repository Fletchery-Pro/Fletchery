// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {Roles} from "../access/Roles.sol";

/// @title VenueController  (Fletchery · Compliance module)
/// @notice Encodes the SEC Innovation Exemption rulebook for a Tokenized Securities Venue (TSV) as
///         code that runs before every trade:
///           - Tier 1: at most 75 symbols, monthly volume capped at 0.25% of the prior month's ADV
///           - Tier 2: at most 250 symbols, cap of 2.5%
///           - a repeat cap breach within 12 months stops the symbol for 3 months
///           - third-party listings need 30 days' notice, during which the issuer can object
///           - trading halts on the listing exchange are mirrored on-chain
///         Caps are enforced pre-trade (a trade that would breach is rejected), so a venue running
///         Fletchery should never breach in normal operation. The breach path exists for data
///         corrections, e.g. a downward ADV revision mid-month.
contract VenueController is Roles {
    bytes32 public constant LISTING_ADMIN = keccak256("LISTING_ADMIN");
    bytes32 public constant DATA_ORACLE = keccak256("DATA_ORACLE"); // posts ADV cap bases
    bytes32 public constant HALT_ORACLE = keccak256("HALT_ORACLE"); // mirrors exchange halts / LULD
    bytes32 public constant METER = keccak256("METER"); // the venue hook

    uint256 public constant NOTICE_PERIOD = 30 days;
    uint256 public constant STOP_PERIOD = 90 days;
    uint256 public constant BREACH_LOOKBACK = 365 days;

    enum ListingStatus {
        NONE,
        NOTICED,
        OBJECTED,
        ACTIVE,
        DELISTED
    }

    struct Listing {
        ListingStatus status;
        address token;
        address issuer; // issuer's registered address (can object)
        bool issuerSponsored;
        uint64 noticedAt;
    }

    struct Meter {
        uint256 capBasisMonth; // month key the basis applies to (year*12 + month0)
        uint256 priorMonthAdv; // token units (18 decimals) of prior-month consolidated ADV
        uint256 volumeMonth; // month key of the running volume
        uint256 volume; // token units traded on this venue in volumeMonth
        uint64 lastBreachAt;
        uint64 stoppedUntil;
        uint32 breaches;
    }

    struct Halt {
        bool halted;
        bytes32 reason; // e.g. "LULD", "T1" (news pending), "MWCB"
        uint64 since;
    }

    uint8 public immutable tier;
    uint16 public immutable capBps; // 25 = 0.25%, 250 = 2.5%
    uint16 public immutable maxSymbols; // 75 or 250

    uint16 public activeSymbols;
    Halt public marketWideHalt;

    mapping(bytes32 symbol => Listing) public listings;
    mapping(bytes32 symbol => Meter) public meters;
    mapping(bytes32 symbol => Halt) public halts;

    event ListingNoticed(bytes32 indexed symbol, address token, address issuer, bool issuerSponsored, uint64 at);
    event ListingObjected(bytes32 indexed symbol, address issuer);
    event ListingActivated(bytes32 indexed symbol);
    event ListingDelisted(bytes32 indexed symbol);
    event CapBasisSet(bytes32 indexed symbol, uint256 monthKey, uint256 priorMonthAdv, uint256 cap);
    event VolumeRecorded(bytes32 indexed symbol, uint256 monthKey, uint256 amount, uint256 volume, uint256 cap);
    event CapBreached(bytes32 indexed symbol, uint256 volume, uint256 cap, uint32 breaches);
    event SymbolStopped(bytes32 indexed symbol, uint64 until);
    event HaltSet(bytes32 indexed symbol, bool halted, bytes32 reason);
    event MarketWideHaltSet(bool halted, bytes32 reason);

    error BadTier();
    error ListingExists(bytes32 symbol);
    error NotNoticed(bytes32 symbol);
    error NoticePeriodRunning(uint256 activatesAt);
    error ObjectionWindowClosed();
    error IssuerSponsored();
    error NotIssuer();
    error SymbolLimit(uint16 max);
    error NotActive(bytes32 symbol);
    error Halted(bytes32 symbol, bytes32 reason);
    error Stopped(bytes32 symbol, uint64 until);
    error NoCapBasis(bytes32 symbol, uint256 monthKey);
    error CapExceeded(bytes32 symbol, uint256 wouldBe, uint256 cap);

    constructor(address initialOwner, uint8 _tier) Roles(initialOwner) {
        if (_tier == 1) {
            capBps = 25;
            maxSymbols = 75;
        } else if (_tier == 2) {
            capBps = 250;
            maxSymbols = 250;
        } else {
            revert BadTier();
        }
        tier = _tier;
    }

    // ───────────────────────────── listings ─────────────────────────────

    /// @notice Start the 30-day public notice for a symbol. For third-party (non-sponsored) tokens the
    ///         issuer may object during this window.
    function noticeListing(bytes32 symbol, address token, address issuer, bool issuerSponsored)
        external
        onlyRole(LISTING_ADMIN)
    {
        ListingStatus s = listings[symbol].status;
        if (s != ListingStatus.NONE && s != ListingStatus.DELISTED && s != ListingStatus.OBJECTED) {
            revert ListingExists(symbol);
        }
        listings[symbol] = Listing(ListingStatus.NOTICED, token, issuer, issuerSponsored, uint64(block.timestamp));
        emit ListingNoticed(symbol, token, issuer, issuerSponsored, uint64(block.timestamp));
    }

    function objectToListing(bytes32 symbol) external {
        Listing storage l = listings[symbol];
        if (l.status != ListingStatus.NOTICED) revert NotNoticed(symbol);
        if (l.issuerSponsored) revert IssuerSponsored();
        if (msg.sender != l.issuer) revert NotIssuer();
        if (block.timestamp >= l.noticedAt + NOTICE_PERIOD) revert ObjectionWindowClosed();
        l.status = ListingStatus.OBJECTED;
        emit ListingObjected(symbol, msg.sender);
    }

    function activateListing(bytes32 symbol) external onlyRole(LISTING_ADMIN) {
        Listing storage l = listings[symbol];
        if (l.status != ListingStatus.NOTICED) revert NotNoticed(symbol);
        uint256 at = l.noticedAt + NOTICE_PERIOD;
        if (block.timestamp < at) revert NoticePeriodRunning(at);
        if (activeSymbols >= maxSymbols) revert SymbolLimit(maxSymbols);
        l.status = ListingStatus.ACTIVE;
        activeSymbols += 1;
        emit ListingActivated(symbol);
    }

    function delist(bytes32 symbol) external onlyRole(LISTING_ADMIN) {
        Listing storage l = listings[symbol];
        if (l.status != ListingStatus.ACTIVE) revert NotActive(symbol);
        l.status = ListingStatus.DELISTED;
        activeSymbols -= 1;
        emit ListingDelisted(symbol);
    }

    // ───────────────────────────── caps ─────────────────────────────

    /// @notice Post the prior month's consolidated ADV, which sets this month's cap.
    ///         If the venue has already traded more than the new cap (a downward revision),
    ///         that counts as a breach.
    function setCapBasis(bytes32 symbol, uint256 priorMonthAdv) external onlyRole(DATA_ORACLE) {
        uint256 mk = monthKey(block.timestamp);
        Meter storage m = meters[symbol];
        m.capBasisMonth = mk;
        m.priorMonthAdv = priorMonthAdv;
        uint256 cap = priorMonthAdv * capBps / 10_000;
        emit CapBasisSet(symbol, mk, priorMonthAdv, cap);
        if (m.volumeMonth == mk && m.volume > cap) _breach(symbol, m, m.volume, cap);
    }

    /// @notice Pre-trade check used by the hook and by routers (view, never reverts).
    function headroom(bytes32 symbol) public view returns (uint256 remaining, uint256 cap, uint256 used) {
        Meter storage m = meters[symbol];
        uint256 mk = monthKey(block.timestamp);
        if (m.capBasisMonth != mk) return (0, 0, 0);
        cap = m.priorMonthAdv * capBps / 10_000;
        used = m.volumeMonth == mk ? m.volume : 0;
        remaining = used >= cap ? 0 : cap - used;
    }

    /// @notice Reverts with the precise reason when the symbol cannot trade right now.
    function requireTradable(bytes32 symbol) public view {
        if (listings[symbol].status != ListingStatus.ACTIVE) revert NotActive(symbol);
        if (marketWideHalt.halted) revert Halted(bytes32("*"), marketWideHalt.reason);
        Halt memory h = halts[symbol];
        if (h.halted) revert Halted(symbol, h.reason);
        uint64 until = meters[symbol].stoppedUntil;
        if (until > block.timestamp) revert Stopped(symbol, until);
    }

    /// @notice Meter a fill. Called by the venue hook in afterSwap; reverting unwinds the swap.
    function recordVolume(bytes32 symbol, uint256 amount) external onlyRole(METER) {
        requireTradable(symbol);
        Meter storage m = meters[symbol];
        uint256 mk = monthKey(block.timestamp);
        if (m.capBasisMonth != mk) revert NoCapBasis(symbol, mk);
        if (m.volumeMonth != mk) {
            m.volumeMonth = mk;
            m.volume = 0;
        }
        uint256 cap = m.priorMonthAdv * capBps / 10_000;
        uint256 wouldBe = m.volume + amount;
        if (wouldBe > cap) revert CapExceeded(symbol, wouldBe, cap);
        m.volume = wouldBe;
        emit VolumeRecorded(symbol, mk, amount, wouldBe, cap);
    }

    function _breach(bytes32 symbol, Meter storage m, uint256 volume, uint256 cap) internal {
        bool repeat = m.lastBreachAt != 0 && block.timestamp - m.lastBreachAt <= BREACH_LOOKBACK;
        m.breaches += 1;
        m.lastBreachAt = uint64(block.timestamp);
        emit CapBreached(symbol, volume, cap, m.breaches);
        if (repeat) {
            m.stoppedUntil = uint64(block.timestamp + STOP_PERIOD);
            emit SymbolStopped(symbol, m.stoppedUntil);
        }
    }

    // ───────────────────────────── halts ─────────────────────────────

    function setHalt(bytes32 symbol, bool halted, bytes32 reason) external onlyRole(HALT_ORACLE) {
        halts[symbol] = Halt(halted, reason, uint64(block.timestamp));
        emit HaltSet(symbol, halted, reason);
    }

    function setMarketWideHalt(bool halted, bytes32 reason) external onlyRole(HALT_ORACLE) {
        marketWideHalt = Halt(halted, reason, uint64(block.timestamp));
        emit MarketWideHaltSet(halted, reason);
    }

    // ───────────────────────────── utils ─────────────────────────────

    /// @notice Calendar month key (year*12 + zero-based month) in UTC. Caps reset on the 1st.
    /// @dev Howard Hinnant's civil-from-days algorithm.
    function monthKey(uint256 ts) public pure returns (uint256) {
        uint256 z = ts / 86_400 + 719_468;
        uint256 era = z / 146_097;
        uint256 doe = z - era * 146_097;
        uint256 yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        uint256 y = yoe + era * 400;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        uint256 m = mp < 10 ? mp + 3 : mp - 9;
        if (m <= 2) y += 1;
        return y * 12 + (m - 1);
    }
}
