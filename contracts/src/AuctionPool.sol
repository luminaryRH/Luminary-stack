// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPriceFeed, IPrintRegistry, IProofVerifier, IScreeningGate} from "./Interfaces.sol";

/// @title AuctionPool
/// @notice Custody and venue for sealed-bid, uniform-price call auctions. Balances are notes, not ledger rows, and every
/// state change is backed by a proof checked against a bb-generated verifier.
///   deposit        — DepositProof: the queued commitment holds exactly the asset and amount the pool received.
///   advanceTree    — TreeUpdateProof: the next queued commitments were appended to the root. No Poseidon runs on
///                    chain, so notes become spendable once their batch is appended (anyone may advance).
///   transact       — TransactProof: up to two unspent notes become two new notes, releasing an amount to a recipient
///                    and a fee to a relayer (withdrawals, merging, splitting, private transfers).
///   placeOrder     — OrderValidityProof: a note is locked into an order in a collecting auction. The order itself
///                    travels sealed to the clearing committee; a relayed order pays its relayer in ETH from a second note.
///   pin            — at the call time, pins the call block and the reference and quote prices (permissionless).
///   settleAuction  — AuctionClearProof: the auction's orders cleared at one price p* inside the band, with the volume
///                    maximized, produce exactly the fill notes, rolled orders / refunds and fee note. The print (p*,
///                    volume) is written to PrintRegistry in the same transaction.
///   reclaim        — ReclaimProof: an order's owner takes the lock back: while its auction is still collecting (cancel),
///                    or after it was voided or abandoned. Never gated by the operator.
/// Auctions are scheduled by the operator (the off-chain calendar); RFQ auctions are opened by RfqDesk, which settles
/// them at the reference with its own proof.
contract AuctionPool {
    enum Kind {
        OPEN,
        CLOSE,
        MIDNIGHT,
        NAV,
        RFQ
    }

    struct Verifiers {
        IProofVerifier deposit;
        IProofVerifier tree;
        IProofVerifier transact;
        IProofVerifier order;
        IProofVerifier clear;
        IProofVerifier reclaim;
    }

    struct Transaction {
        bytes32 root;
        bytes32 aspRoot; // association-set root the input label is proven in; 0 = none
        bytes32[2] nullifiers; // a dummy input still has a (unique) nullifier
        bytes32[2] outputs;
        address asset;
        uint256 released; // paid to `to`
        uint256 fee; // paid to `relayer`
        address to;
        address relayer;
    }

    struct Placement {
        bytes32 root;
        bytes32 nullifier;
        bytes32 feeNullifier; // 0 unless relayed
        bytes32 change;
        bytes32 feeChange; // 0 unless relayed
        bytes32 commitment;
        address relayer;
        uint256 fee; // wei, from the fee note
    }

    struct Clearing {
        uint256 pStar; // micro-USD per share
        uint256 crossedQty; // share micro-units
        bytes32[64] fills;
        bytes32[64] residuals;
        bool[64] rolls;
        bytes32 feeNote;
    }

    struct Market {
        address feed; // AggregatorV3-shaped USD price, 8 decimals
        uint88 unit; // token base units per micro-unit, fixed once set
        bool listed; // may be auctioned (as opposed to only quoting)
        uint16 capBps; // price band half-width around the reference
    }

    struct Auction {
        address asset;
        uint64 callTime;
        Kind kind;
        bool settled;
        bool voided; // stale price at pin, no orders, or abandoned: every order is reclaimable
        address quote;
        uint64 callBlock; // 0 until pinned
        uint16 capBps;
        uint16 feeBps;
        uint64 refUsd; // micro-USD per asset token, pinned
        uint64 quoteUsd; // micro-USD per quote token, pinned
        uint64 pinnedAt;
        uint16 live; // orders resting in it (cancelled slots excluded)
    }

    uint256 internal constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 internal constant BATCH = 16; // circuits/tree_update M
    uint256 public constant ORDERS = 64; // circuits/auction_clear N
    uint256 public constant RFQ_ORDERS = 2; // circuits/rfq_cross
    uint256 internal constant CAPACITY = 1 << 20; // circuits/lib DEPTH
    /// circuits/lib zeros()[DEPTH]
    bytes32 public constant EMPTY_ROOT = 0x01da7c268b18dfc969f3ae497fff3fef7909905d6bd3d40b212d1d1544e1be88;
    address public constant ETH = address(0);
    uint256 public constant MAX_STALENESS = 1 hours; // the nav-watcher pushes every 5 minutes
    uint16 public constant MAX_FEE_BPS = 100;
    uint16 public constant MAX_CAP_BPS = 2000;
    uint256 public constant SETTLE_DEADLINE = 1 hours; // after the pin; past it the auction can be abandoned
    uint256 public constant MAX_DEPOSIT_FEE = 0.001 ether;

    IProofVerifier public immutable depositVerifier;
    IProofVerifier public immutable treeVerifier;
    IProofVerifier public immutable transactVerifier;
    IProofVerifier public immutable orderVerifier;
    IProofVerifier public immutable clearVerifier;
    IProofVerifier public immutable reclaimVerifier;
    IPrintRegistry public immutable prints;

    address public owner;
    address public pendingOwner;
    bool public depositsPaused;
    IScreeningGate public gate; // deposit screening; 0 = none
    address public desk; // RfqDesk: opens and settles RFQ auctions
    mapping(address account => bool) public scheduler;
    // Deposit labels (association sets): keccak(chain, pool, depositor, nonce) mod p, so a depositor can prove before
    // sending which label their note will carry.
    mapping(address depositor => uint256) public depositNonce;
    uint256 public depositFee; // wei on top of every deposit, to feeRecipient (pays for appending it to the tree)
    address public feeRecipient;

    bytes32[] public commitments; // every queued commitment, in leaf order
    uint256 public treeSize; // how many of them are in the tree
    bytes32 public root;
    // The tree is append-only, so every past root stays valid; nullifiers are what stop a second spend.
    mapping(bytes32 root => bool) public knownRoot;
    mapping(bytes32 nullifier => bool) public spent;

    bytes32 public feeOwner; // owner key of the fee notes
    uint16 public feeBps;
    mapping(address token => Market) public markets;
    Auction[] internal auctionList;
    mapping(uint256 id => bytes32[]) internal slots;
    // Orders in auctions not yet settled. Capped at ORDERS per asset, so a settlement's rolled orders always fit.
    mapping(address asset => uint256) public openOrders;

    bool private transient entered;

    event Committed(uint256 indexed index, bytes32 commitment);
    event Deposited(address indexed from, address indexed asset, uint256 amount, bytes32 commitment, uint256 label);
    event DepositFeeSet(address recipient, uint256 fee);
    event TreeAdvanced(bytes32 root, uint256 size);
    event Transacted(
        bytes32 indexed nullifier0, bytes32 indexed nullifier1, address indexed asset, address to, uint256 released, address relayer, uint256 fee, bytes memo
    );
    event AuctionScheduled(uint256 indexed id, address indexed asset, address quote, Kind kind, uint256 callTime, uint256 capBps);
    event OrderResting(uint256 indexed id, uint256 slot, bytes32 commitment, bytes sealedOrder);
    event OrderFeePaid(address indexed relayer, uint256 fee); // ETH leaving the pool for a relayed order (solvency)
    event AuctionPinned(uint256 indexed id, uint256 callBlock, uint256 refUsd, uint256 quoteUsd);
    event AuctionSettled(uint256 indexed id, uint256 pStar, uint256 crossedQty, bytes notes);
    event AuctionVoided(uint256 indexed id);
    event OrderReclaimed(uint256 indexed id, uint256 slot, bool cancelled);
    event MarketSet(address indexed token, address feed, uint256 unit, bool listed, uint256 capBps);
    event FeeSet(bytes32 feeOwner, uint16 feeBps);
    event DepositsPausedSet(bool paused);
    event GateSet(address gate);
    event DeskSet(address desk);
    event SchedulerSet(address indexed account, bool allowed);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotPendingOwner();
    error NotScheduler();
    error NotDesk();
    error IsPaused();
    error Blocked();
    error AssetNotAllowed();
    error MarketNotListed();
    error BadMarket();
    error BadFee();
    error BadAmount();
    error BadCount();
    error BadAuction();
    error ZeroAddress();
    error NotInField();
    error InvalidProof();
    error UnknownRoot();
    error NoteSpent();
    error TreeFull();
    error AuctionFull();
    error NotCollecting();
    error NotPinned();
    error AlreadySettled();
    error Voided();
    error TooEarly();
    error UnknownAssociationRoot();
    error AssociationRequired();
    error TransferFailed();
    error Reentrancy();

    constructor(address owner_, Verifiers memory v, IPrintRegistry prints_, bytes32 feeOwner_, uint16 feeBps_) {
        if (
            owner_ == address(0) || address(v.deposit) == address(0) || address(v.tree) == address(0)
                || address(v.transact) == address(0) || address(v.order) == address(0) || address(v.clear) == address(0)
                || address(v.reclaim) == address(0) || address(prints_) == address(0)
        ) revert ZeroAddress();
        owner = owner_;
        depositVerifier = v.deposit;
        treeVerifier = v.tree;
        transactVerifier = v.transact;
        orderVerifier = v.order;
        clearVerifier = v.clear;
        reclaimVerifier = v.reclaim;
        prints = prints_;
        root = EMPTY_ROOT;
        knownRoot[EMPTY_ROOT] = true;
        _setFee(feeOwner_, feeBps_);
        emit OwnershipTransferred(address(0), owner_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    // --- notes ---------------------------------------------------------------

    /// @notice Deposit ETH (asset 0, msg.value) or a market token into a new note, plus `depositFee` in ETH. The note
    /// must carry `depositLabel(msg.sender)`, the label the association set refers to.
    function deposit(address asset, uint256 amount, bytes32 commitment, bytes calldata proof) external payable nonReentrant {
        if (depositsPaused) revert IsPaused();
        if (address(gate) != address(0) && !gate.allowed(msg.sender)) revert Blocked();
        if (asset != ETH && markets[asset].unit == 0) revert AssetNotAllowed();
        if (amount == 0 || amount > type(uint128).max) revert BadAmount();
        if (msg.value != (asset == ETH ? amount : 0) + depositFee) revert BadAmount();

        uint256 label = depositLabel(msg.sender);
        depositNonce[msg.sender]++;
        bytes32[] memory inputs = new bytes32[](4);
        inputs[0] = commitment;
        inputs[1] = bytes32(uint256(uint160(asset)));
        inputs[2] = bytes32(amount);
        inputs[3] = bytes32(label);
        _verify(depositVerifier, proof, inputs);

        if (asset != ETH) {
            uint256 before = _balanceOf(asset);
            _call(asset, abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), amount)); // transferFrom
            if (_balanceOf(asset) - before != amount) revert BadAmount(); // the note must hold exactly what arrived
        }
        if (depositFee != 0) _pay(ETH, feeRecipient, depositFee);
        _queue(commitment);
        emit Deposited(msg.sender, asset, amount, commitment, label);
    }

    /// The label the next deposit from `depositor` carries. 0 and 1 are never labels (1 is the settlement fee label).
    function depositLabel(address depositor) public view returns (uint256 label) {
        label = uint256(keccak256(abi.encode(block.chainid, address(this), depositor, depositNonce[depositor]))) % FIELD;
        if (label < 2) label += 2;
    }

    /// @notice Append the next `count` queued commitments. Permissionless.
    function advanceTree(uint256 count, bytes32 newRoot, bytes calldata proof) external {
        uint256 size = treeSize;
        if (count == 0 || count > BATCH || size + count > commitments.length) revert BadCount();

        bytes32[] memory inputs = new bytes32[](BATCH + 4);
        inputs[0] = root;
        inputs[1] = bytes32(size);
        for (uint256 i; i < count; i++) {
            inputs[2 + i] = commitments[size + i];
        }
        inputs[BATCH + 2] = bytes32(count);
        inputs[BATCH + 3] = newRoot;
        _verify(treeVerifier, proof, inputs);

        root = newRoot;
        knownRoot[newRoot] = true;
        treeSize = size + count;
        emit TreeAdvanced(newRoot, size + count);
    }

    /// @notice Spend up to two notes into two new notes, releasing `released` to `to` and `fee` to `relayer`. Anyone may
    /// submit the proof; it only ever pays where it was made to pay. `memo` carries the outputs sealed to their owners.
    function transact(Transaction calldata t, bytes calldata proof, bytes calldata memo) external nonReentrant {
        if (!knownRoot[t.root]) revert UnknownRoot();
        if (t.nullifiers[0] == t.nullifiers[1] || spent[t.nullifiers[0]] || spent[t.nullifiers[1]]) revert NoteSpent();
        if (t.released > type(uint128).max || t.fee > type(uint128).max) revert BadAmount();
        if ((t.released != 0 && t.to == address(0)) || (t.fee != 0 && t.relayer == address(0))) revert ZeroAddress();
        if (t.aspRoot != 0 && (address(gate) == address(0) || !gate.isAssociationRoot(t.aspRoot))) revert UnknownAssociationRoot();
        if (t.released != 0 && t.aspRoot == 0 && address(gate) != address(0) && gate.associationRequired()) revert AssociationRequired();

        bytes32[] memory inputs = new bytes32[](10);
        inputs[0] = t.root;
        inputs[1] = t.aspRoot;
        inputs[2] = t.nullifiers[0];
        inputs[3] = t.nullifiers[1];
        inputs[4] = t.outputs[0];
        inputs[5] = t.outputs[1];
        inputs[6] = bytes32(uint256(uint160(t.asset)));
        inputs[7] = bytes32(t.released);
        inputs[8] = bytes32(t.fee);
        inputs[9] = context(t.to, t.relayer, t.fee);
        _verify(transactVerifier, proof, inputs);

        spent[t.nullifiers[0]] = true;
        spent[t.nullifiers[1]] = true;
        _queue(t.outputs[0]);
        _queue(t.outputs[1]);
        if (t.released != 0) _pay(t.asset, t.to, t.released);
        if (t.fee != 0) _pay(t.asset, t.relayer, t.fee);
        emit Transacted(t.nullifiers[0], t.nullifiers[1], t.asset, t.to, t.released, t.relayer, t.fee, memo);
    }

    /// Binds a transaction proof to this chain, this pool, its recipient, relayer and fee.
    function context(address to, address relayer, uint256 fee) public view returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode(block.chainid, address(this), to, relayer, fee))) % FIELD);
    }

    /// Binds an order proof to this chain, this pool, its auction, relayer and fee.
    function placementContext(uint256 id, address relayer, uint256 fee) public view returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode(block.chainid, address(this), id, relayer, fee))) % FIELD);
    }

    function commitmentCount() external view returns (uint256) {
        return commitments.length;
    }

    // --- auctions ------------------------------------------------------------

    /// @notice Schedule an auction of `asset` against `quote` at `callTime`. Operator (calendar) or RfqDesk (RFQ only).
    function schedule(address asset, address quote, Kind kind, uint64 callTime) external returns (uint256 id) {
        if (kind == Kind.RFQ ? msg.sender != desk : !scheduler[msg.sender]) revert NotScheduler();
        Market memory m = markets[asset];
        if (!m.listed) revert MarketNotListed();
        if (asset == quote || markets[quote].unit == 0 || callTime <= block.timestamp) revert BadAuction();
        id = auctionList.length;
        Auction storage a = auctionList.push();
        a.asset = asset;
        a.quote = quote;
        a.kind = kind;
        a.callTime = callTime;
        a.capBps = m.capBps;
        a.feeBps = feeBps;
        emit AuctionScheduled(id, asset, quote, kind, callTime, m.capBps);
    }

    /// @notice Lock part of a note into an order in collecting auction `id`. The pool only sees the order commitment;
    /// the order itself travels encrypted to the committee in `sealedOrder`. A relayed order (fee > 0) pays its relayer
    /// in ETH from a separate note, so the fee reveals nothing about the side.
    function placeOrder(uint256 id, Placement calldata p, bytes calldata proof, bytes calldata sealedOrder) external nonReentrant {
        Auction storage a = _auction(id);
        if (block.timestamp >= a.callTime || a.voided) revert NotCollecting();
        if (!knownRoot[p.root]) revert UnknownRoot();
        if (spent[p.nullifier]) revert NoteSpent();
        if (p.fee > type(uint128).max) revert BadAmount();
        if (p.fee != 0) {
            if (p.relayer == address(0)) revert ZeroAddress();
            if (p.feeNullifier == p.nullifier || spent[p.feeNullifier]) revert NoteSpent();
        } else if (p.feeNullifier != 0 || p.feeChange != 0) {
            revert BadFee();
        }
        if (p.commitment == 0) revert BadCount(); // 0 marks an empty slot
        if (slots[id].length >= (a.kind == Kind.RFQ ? RFQ_ORDERS : ORDERS) || openOrders[a.asset] >= ORDERS) revert AuctionFull();
        _verify(orderVerifier, proof, _placementInputs(id, a, p));

        spent[p.nullifier] = true;
        _queue(p.change);
        if (p.fee != 0) {
            spent[p.feeNullifier] = true;
            _queue(p.feeChange);
            _pay(ETH, p.relayer, p.fee);
            emit OrderFeePaid(p.relayer, p.fee);
        }
        _rest(id, a, p.commitment, sealedOrder);
    }

    /// order_validity public inputs, in circuit order.
    function _placementInputs(uint256 id, Auction storage a, Placement calldata p) private view returns (bytes32[] memory inputs) {
        inputs = new bytes32[](12);
        inputs[0] = p.root;
        inputs[1] = p.nullifier;
        inputs[2] = p.feeNullifier;
        inputs[3] = p.change;
        inputs[4] = p.feeChange;
        inputs[5] = bytes32(uint256(uint160(a.asset)));
        inputs[6] = bytes32(uint256(markets[a.asset].unit));
        inputs[7] = bytes32(uint256(uint160(a.quote)));
        inputs[8] = bytes32(uint256(markets[a.quote].unit));
        inputs[9] = p.commitment;
        inputs[10] = bytes32(p.fee);
        inputs[11] = placementContext(id, p.relayer, p.fee);
    }

    /// @notice At the call time, pin the call block and the reference (asset) and quote prices. Permissionless. A stale
    /// or missing price, or an auction without orders, voids it: its orders are reclaimable at once.
    function pin(uint256 id) external {
        Auction storage a = _auction(id);
        if (block.timestamp < a.callTime) revert TooEarly();
        if (a.callBlock != 0 || a.voided) revert Voided();
        a.callBlock = uint64(block.number);
        a.pinnedAt = uint64(block.timestamp);
        (uint256 refUsd, bool refOk) = _price(a.asset);
        (uint256 quoteUsd, bool quoteOk) = _price(a.quote);
        if (!refOk || !quoteOk || a.live == 0) {
            _void(id, a);
            return;
        }
        a.refUsd = uint64(refUsd);
        a.quoteUsd = uint64(quoteUsd);
        emit AuctionPinned(id, block.number, refUsd, quoteUsd);
    }

    /// @notice Settle a pinned auction. Permissionless; `notes` carries the outputs encrypted to their owners. Rolled
    /// orders rest in `rollInto`, a collecting auction of the same pair (ignored when nothing rolls).
    function settleAuction(uint256 id, Clearing calldata c, uint256 rollInto, bytes calldata proof, bytes calldata notes) external nonReentrant {
        Auction storage a = _auction(id);
        if (a.kind == Kind.RFQ) revert BadAuction();
        _checkSettleable(a);
        bytes32[] storage list = slots[id];
        _verify(clearVerifier, proof, _clearingInputs(a, list, c));

        a.settled = true;
        openOrders[a.asset] -= a.live;
        a.live = 0;
        uint256 n = list.length;
        for (uint256 i; i < n; i++) {
            if (list[i] == 0) continue; // cancelled: the proof fixed its outputs to 0
            _queue(c.fills[i]);
            if (c.rolls[i]) _rest(rollInto, _rollTarget(a, rollInto), c.residuals[i], "");
            else _queue(c.residuals[i]);
        }
        _queue(c.feeNote);
        prints.record(id, a.asset, c.pStar, c.crossedQty);
        emit AuctionSettled(id, c.pStar, c.crossedQty, notes);
    }

    /// @notice RfqDesk's settlement of an RFQ auction it verified: fills and refunds, the fee note, the print at the
    /// reference.
    function settleFromDesk(uint256 id, bytes32[] calldata fills, bytes32[] calldata residuals, bytes32 feeNote, uint256 crossedQty, bytes calldata notes)
        external
        nonReentrant
    {
        if (msg.sender != desk) revert NotDesk();
        Auction storage a = _auction(id);
        if (a.kind != Kind.RFQ) revert BadAuction();
        _checkSettleable(a);
        bytes32[] storage list = slots[id];
        if (fills.length != list.length || residuals.length != list.length) revert BadCount();

        a.settled = true;
        openOrders[a.asset] -= a.live;
        a.live = 0;
        for (uint256 i; i < list.length; i++) {
            if (list[i] == 0) continue;
            _queue(fills[i]);
            _queue(residuals[i]);
        }
        _queue(feeNote);
        prints.record(id, a.asset, a.refUsd, crossedQty);
        emit AuctionSettled(id, a.refUsd, crossedQty, notes);
    }

    /// @notice Void a pinned auction nobody settled within SETTLE_DEADLINE. Its orders become reclaimable and it can
    /// never be settled. Permissionless, so the operator cannot hold locks hostage.
    function abandon(uint256 id) external {
        Auction storage a = _auction(id);
        if (a.callBlock == 0 || block.timestamp < a.pinnedAt + SETTLE_DEADLINE) revert TooEarly();
        if (a.settled) revert AlreadySettled();
        if (a.voided) revert Voided();
        _void(id, a);
    }

    /// @notice Take the lock of the order in `slot` back as a note (ReclaimProof): a cancel while the auction is still
    /// collecting (before its pin), or a reclaim once it was voided. Settled and pinned auctions cannot be reclaimed from.
    /// ponytail: no relayer, so the sender's address is linked to the reclaimed order; route through /api/relay later.
    function reclaim(uint256 id, uint256 slot, bytes32 orderNullifier, bytes32 refund, bytes calldata proof) external {
        Auction storage a = _auction(id);
        bool cancel = a.callBlock == 0 && !a.voided;
        if (!cancel && !a.voided) revert NotCollecting();
        if (spent[orderNullifier]) revert NoteSpent();
        bytes32 commitment = slots[id][slot];
        if (commitment == 0) revert BadCount();

        bytes32[] memory inputs = new bytes32[](7);
        inputs[0] = bytes32(uint256(uint160(a.asset)));
        inputs[1] = bytes32(uint256(markets[a.asset].unit));
        inputs[2] = bytes32(uint256(uint160(a.quote)));
        inputs[3] = bytes32(uint256(markets[a.quote].unit));
        inputs[4] = commitment;
        inputs[5] = orderNullifier;
        inputs[6] = refund;
        _verify(reclaimVerifier, proof, inputs);

        spent[orderNullifier] = true;
        if (cancel) {
            slots[id][slot] = 0;
            a.live--;
            openOrders[a.asset]--;
        }
        _queue(refund);
        emit OrderReclaimed(id, slot, cancel);
    }

    function auctions(uint256 id) external view returns (Auction memory) {
        return auctionList[id];
    }

    function auctionCount() external view returns (uint256) {
        return auctionList.length;
    }

    function orderList(uint256 id) external view returns (bytes32[] memory) {
        return slots[id];
    }

    // --- owner ---------------------------------------------------------------

    /// A market's unit can never change: open orders and notes are denominated in it.
    function setMarket(address token, address feed, uint88 unit, bool listed, uint16 capBps) external onlyOwner {
        uint88 current = markets[token].unit;
        if (token == ETH || feed == address(0) || unit == 0 || (current != 0 && current != unit) || capBps > MAX_CAP_BPS) revert BadMarket();
        markets[token] = Market({feed: feed, unit: unit, listed: listed, capBps: capBps});
        emit MarketSet(token, feed, unit, listed, capBps);
    }

    function setScheduler(address account, bool allowed_) external onlyOwner {
        scheduler[account] = allowed_;
        emit SchedulerSet(account, allowed_);
    }

    function setDesk(address desk_) external onlyOwner {
        desk = desk_;
        emit DeskSet(desk_);
    }

    function setFee(bytes32 feeOwner_, uint16 feeBps_) external onlyOwner {
        _setFee(feeOwner_, feeBps_);
    }

    function setDepositsPaused(bool paused_) external onlyOwner {
        depositsPaused = paused_;
        emit DepositsPausedSet(paused_);
    }

    function setDepositFee(address recipient, uint256 fee) external onlyOwner {
        if (fee > MAX_DEPOSIT_FEE) revert BadFee();
        if (fee != 0 && recipient == address(0)) revert ZeroAddress();
        feeRecipient = recipient;
        depositFee = fee;
        emit DepositFeeSet(recipient, fee);
    }

    function setGate(IScreeningGate gate_) external onlyOwner {
        gate = gate_;
        emit GateSet(address(gate_));
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // --- internal ------------------------------------------------------------

    /// Inputs must be canonical field elements, or one nullifier could be spent twice as x and x + p. The bb verifier
    /// also rejects them (ValueGeFieldOrder); checked here so the pool does not depend on that.
    function _verify(IProofVerifier verifier, bytes calldata proof, bytes32[] memory inputs) private {
        for (uint256 i; i < inputs.length; i++) {
            if (uint256(inputs[i]) >= FIELD) revert NotInField();
        }
        if (!verifier.verify(proof, inputs)) revert InvalidProof();
    }

    /// auction_clear public inputs, in circuit order.
    function _clearingInputs(Auction storage a, bytes32[] storage list, Clearing calldata c) private view returns (bytes32[] memory inputs) {
        inputs = new bytes32[](12 + 4 * ORDERS);
        inputs[0] = bytes32(uint256(uint160(a.asset)));
        inputs[1] = bytes32(uint256(markets[a.asset].unit));
        inputs[2] = bytes32(uint256(uint160(a.quote)));
        inputs[3] = bytes32(uint256(markets[a.quote].unit));
        inputs[4] = bytes32(uint256(a.refUsd));
        inputs[5] = bytes32(uint256(a.capBps));
        inputs[6] = bytes32(uint256(a.quoteUsd));
        inputs[7] = bytes32(uint256(a.feeBps));
        inputs[8] = bytes32(c.pStar);
        inputs[9] = bytes32(c.crossedQty);
        for (uint256 i; i < ORDERS; i++) {
            if (i < list.length) inputs[10 + i] = list[i];
            inputs[10 + ORDERS + i] = c.fills[i];
            inputs[10 + 2 * ORDERS + i] = c.residuals[i];
            inputs[10 + 3 * ORDERS + i] = bytes32(uint256(c.rolls[i] ? 1 : 0));
        }
        inputs[10 + 4 * ORDERS] = feeOwner;
        inputs[11 + 4 * ORDERS] = c.feeNote;
    }

    function _auction(uint256 id) private view returns (Auction storage a) {
        if (id >= auctionList.length) revert BadAuction();
        a = auctionList[id];
    }

    function _checkSettleable(Auction storage a) private view {
        if (a.callBlock == 0) revert NotPinned();
        if (a.settled) revert AlreadySettled();
        if (a.voided) revert Voided();
    }

    /// A rolled order's next auction: same pair, not RFQ, still collecting.
    function _rollTarget(Auction storage from, uint256 id) private view returns (Auction storage a) {
        a = _auction(id);
        if (a.asset != from.asset || a.quote != from.quote || a.kind == Kind.RFQ || a.voided || block.timestamp >= a.callTime) revert BadAuction();
        if (slots[id].length >= ORDERS) revert AuctionFull();
    }

    function _void(uint256 id, Auction storage a) private {
        a.voided = true;
        openOrders[a.asset] -= a.live;
        emit AuctionVoided(id);
    }

    function _queue(bytes32 commitment) private {
        uint256 index = commitments.length;
        if (index == CAPACITY) revert TreeFull();
        commitments.push(commitment);
        emit Committed(index, commitment);
    }

    function _rest(uint256 id, Auction storage a, bytes32 commitment, bytes memory sealedOrder) private {
        slots[id].push(commitment);
        a.live++;
        openOrders[a.asset]++;
        emit OrderResting(id, slots[id].length - 1, commitment, sealedOrder);
    }

    function _setFee(bytes32 feeOwner_, uint16 feeBps_) private {
        if (uint256(feeOwner_) >= FIELD || feeBps_ > MAX_FEE_BPS) revert BadFee();
        feeOwner = feeOwner_;
        feeBps = feeBps_;
        emit FeeSet(feeOwner_, feeBps_);
    }

    /// The token's USD price in micro-USD from its feed, or not ok when stale, non-positive or failing.
    function _price(address token) private view returns (uint256 usd, bool ok) {
        try IPriceFeed(markets[token].feed).latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            ok = answer > 0 && updatedAt <= block.timestamp && block.timestamp - updatedAt <= MAX_STALENESS
                && uint256(answer) / 100 <= type(uint64).max && uint256(answer) >= 100;
            if (ok) usd = uint256(answer) / 100; // 8 → 6 decimals
        } catch {
            ok = false;
        }
    }

    function _pay(address asset, address to, uint256 amount) private {
        if (asset == ETH) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            _call(asset, abi.encodeWithSelector(0xa9059cbb, to, amount)); // transfer
        }
    }

    /// Tolerates tokens that return nothing; rejects false returns and non-contracts.
    function _call(address token, bytes memory data) private {
        if (token.code.length == 0) revert TransferFailed();
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && (ret.length < 32 || !abi.decode(ret, (bool))))) revert TransferFailed();
    }

    function _balanceOf(address token) private view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this))); // balanceOf
        if (!ok || ret.length < 32) revert TransferFailed();
        return abi.decode(ret, (uint256));
    }
}
