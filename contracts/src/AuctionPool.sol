// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPriceFeed, IPrintRegistry, IProofVerifier, IScreeningGate} from "./Interfaces.sol";

/// @title AuctionPool
/// @notice Custody and venue for sealed-bid, uniform-price call auctions. Balances are notes, not ledger rows, and every
/// state change is backed by a proof checked against a bb-generated verifier.
///   deposit        — DepositProof: the queued commitment holds exactly the asset and amount the pool received.
///   advanceTree    — TreeUpdateProof: the next queued commitments were appended to the root. No Poseidon runs on
///                    chain, so notes become spendable once their batch is appended (anyone may advance). A tree holds
///                    2^20 leaves; when one is full the next batch starts a new tree, and every root of the old one
///                    stays known, so its notes remain spendable.
///   transact       — TransactProof: up to two unspent notes become two new notes, releasing an amount to a recipient
///                    and a fee to a relayer (withdrawals, merging, splitting, private transfers).
///   ragequit       — TransactProof with the label public: a depositor takes value of their own deposit back to their own
///                    address with no association proof. No owner, gate or pause can stop it.
///   placeOrder     — OrderValidityProof: a note is locked into an order in a collecting auction. The order itself
///                    travels sealed to the clearing committee (the proof binds its ciphertext); a relayed order pays its
///                    relayer in ETH from a second note.
///   pin            — at the call time, pins the call block and the reference and quote prices (permissionless).
///   settleAuction  — AuctionClearProof: the auction's orders cleared at one price p* inside the band, with the volume
///                    maximized, produce exactly the fill notes, rolled orders / refunds and fee note. The print (p*,
///                    volume) is written to PrintRegistry in the same transaction.
///   reclaim        — ReclaimProof: an order's owner takes the lock back: before the call time (cancel), after its
///                    auction was voided or abandoned, or when the settlement left the order out. Never gated by the operator.
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
        bytes32 aspRoot; // association-set root both labels are proven in; 0 = none
    }

    struct Clearing {
        uint256 pStar; // micro-USD per share
        uint256 crossedQty; // share micro-units
        bytes32[64] fills;
        bytes32[64] residuals;
        bool[64] rolls;
        bytes32 feeNote;
        bool roll; // leftovers of rolling orders rest in `rollInto`; false = every leftover is refunded
        uint64 excluded; // slots left out (their order does not open); they clear to nothing and stay reclaimable
    }

    struct Market {
        address feed; // AggregatorV3-shaped USD price, 8 decimals
        uint88 unit; // token base units per micro-unit, fixed once set
        bool listed; // may be auctioned (as opposed to only quoting)
        uint16 capBps; // price band half-width around the reference
        uint32 maxAge; // a feed round older than this (seconds) is stale: the feed's heartbeat plus a margin
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
        uint16 live; // orders resting in it (cancelled slots are free again)
    }

    uint256 internal constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 internal constant BATCH = 16; // circuits/tree_update M
    uint256 public constant ORDERS = 64; // circuits/auction_clear N
    uint256 public constant RFQ_ORDERS = 2; // circuits/rfq_cross
    uint256 public constant CAPACITY = 1 << 20; // leaves per tree: circuits/lib DEPTH
    /// circuits/lib zeros()[DEPTH]
    bytes32 public constant EMPTY_ROOT = 0x01da7c268b18dfc969f3ae497fff3fef7909905d6bd3d40b212d1d1544e1be88;
    address public constant ETH = address(0);
    uint256 public constant MAX_STALENESS = 26 hours; // upper bound of a market's maxAge (Chainlink heartbeats are at most 24 h)
    uint16 public constant MAX_FEE_BPS = 100;
    uint16 public constant MAX_CAP_BPS = 2000;
    uint256 public constant SETTLE_DEADLINE = 1 hours; // after the pin; past it the auction can be abandoned
    uint256 public constant MAX_DEPOSIT_FEE = 0.001 ether;
    uint256 internal constant MAX_MIN_LOCK = 1 << 64; // circuits/order_validity MAX_LOCK
    uint256 internal constant ONE_SHARE = 1e18; // a stock token's uiMultiplier when one token is one share

    IProofVerifier public immutable depositVerifier;
    IProofVerifier public immutable treeVerifier;
    IProofVerifier public immutable transactVerifier;
    IProofVerifier public immutable orderVerifier;
    IProofVerifier public immutable clearVerifier;
    IProofVerifier public immutable reclaimVerifier;
    IPrintRegistry public immutable prints;

    address public owner;
    address public pendingOwner;
    // Stops without the owner's delay: pauses deposits or halts a market at once. Only the owner resumes either.
    address public guardian;
    bool public depositsPaused;
    IScreeningGate public gate; // deposit screening; 0 = none
    address public desk; // RfqDesk: opens and settles RFQ auctions
    mapping(address account => bool) public scheduler;
    // Deposit labels (association sets): keccak(chain, pool, depositor, nonce) mod p, so a depositor can prove before
    // sending which label their note will carry.
    mapping(address depositor => uint256) public depositNonce;
    uint256 public depositFee; // wei on top of every deposit, to feeRecipient (pays for appending it to the tree)
    address public feeRecipient;

    bytes32[] public commitments; // every queued commitment, in leaf order; leaf i sits in tree i / CAPACITY
    uint256 public treeSize; // how many of them are appended, over all trees
    bytes32 public root; // the root of the tree holding leaf treeSize - 1 (EMPTY_ROOT before the first append)
    // Trees are append-only, so every past root of every tree stays valid; nullifiers are what stop a second spend.
    mapping(bytes32 root => bool) public knownRoot;
    mapping(bytes32 nullifier => bool) public spent;

    bytes32 public feeOwner; // owner key of the fee notes
    uint16 public feeBps;
    mapping(address token => Market) public markets;
    Auction[] internal auctionList;
    mapping(uint256 id => bytes32[]) internal slots;
    mapping(uint256 id => uint256[]) internal freeSlots; // cancelled slots, reused before the list grows
    mapping(uint256 id => uint64) public excludedSlots; // per settled auction: the slots its settlement left out
    // Smallest lock an order may carry, in the token's micro-units: holding an auction's slots costs real capital.
    mapping(address token => uint256) public minLock;

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
    event AuctionSettled(uint256 indexed id, uint256 pStar, uint256 crossedQty, uint64 excluded, bytes notes);
    event AuctionVoided(uint256 indexed id);
    event OrderReclaimed(uint256 indexed id, uint256 slot, bytes32 commitment, bool cancelled);
    event MarketSet(address indexed token, address feed, uint256 unit, bool listed, uint256 capBps, uint256 maxAge);
    event MinLockSet(address indexed token, uint256 minLock);
    event FeeSet(bytes32 feeOwner, uint16 feeBps);
    event DepositsPausedSet(bool paused);
    event GuardianSet(address guardian);
    event GateSet(address gate);
    event DeskSet(address desk);
    event SchedulerSet(address indexed account, bool allowed);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotGuardian();
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
    error AlreadySet();

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
    function depositLabel(address depositor) public view returns (uint256) {
        return labelOf(depositor, depositNonce[depositor]);
    }

    /// The label of `depositor`'s deposit number `nonce`.
    function labelOf(address depositor, uint256 nonce) public view returns (uint256 label) {
        label = uint256(keccak256(abi.encode(block.chainid, address(this), depositor, nonce))) % FIELD;
        if (label < 2) label += 2;
    }

    /// @notice Append the next `count` queued commitments. Permissionless. A batch stays inside one tree: the first
    /// batch after a full tree starts the next one from the empty root.
    function advanceTree(uint256 count, bytes32 newRoot, bytes calldata proof) external {
        uint256 size = treeSize;
        uint256 index = size % CAPACITY; // the next leaf's position in its tree
        if (count == 0 || count > BATCH || size + count > commitments.length || index + count > CAPACITY) revert BadCount();

        bytes32[] memory inputs = new bytes32[](BATCH + 4);
        inputs[0] = index == 0 ? EMPTY_ROOT : root;
        inputs[1] = bytes32(index);
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
        // value leaving the pool, to a recipient or a relayer, needs an association proof where the gate requires one
        _checkAssociation(t.aspRoot, t.released != 0 || t.fee != 0);
        _transact(t, proof, memo, 0);
    }

    /// @notice Exit without an association proof: the depositor of deposit `nonce` takes value descending from it back
    /// to their own address (`t.to`). The proof shows the spent notes carry exactly that deposit's label, so this exit
    /// reveals which deposit the value came from. No relayer fee; anyone may submit it, it only pays the depositor.
    function ragequit(Transaction calldata t, uint256 nonce, bytes calldata proof, bytes calldata memo) external nonReentrant {
        if (t.aspRoot != 0 || t.fee != 0 || t.released == 0 || nonce >= depositNonce[t.to]) revert BadAmount();
        _transact(t, proof, memo, labelOf(t.to, nonce));
    }

    function _transact(Transaction calldata t, bytes calldata proof, bytes calldata memo, uint256 publicLabel) private {
        if (!knownRoot[t.root]) revert UnknownRoot();
        if (t.nullifiers[0] == t.nullifiers[1] || spent[t.nullifiers[0]] || spent[t.nullifiers[1]]) revert NoteSpent();
        if (t.released > type(uint128).max || t.fee > type(uint128).max) revert BadAmount();
        if ((t.released != 0 && t.to == address(0)) || (t.fee != 0 && t.relayer == address(0))) revert ZeroAddress();

        bytes32[] memory inputs = new bytes32[](11);
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
        inputs[10] = bytes32(publicLabel);
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

    /// Binds an order proof to this chain, this pool, its auction, relayer, fee and sealed order (keccak256 of the
    /// bytes), so nobody can replay the proof with another ciphertext.
    function placementContext(uint256 id, address relayer, uint256 fee, bytes32 sealedHash) public view returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode(block.chainid, address(this), id, relayer, fee, sealedHash))) % FIELD);
    }

    /// Every commitment queued so far (the trees hold the first `treeSize`).
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
    /// in ETH from a separate note, so the fee reveals nothing about the side. Where the gate requires association, the
    /// proof shows both notes' labels are in a current association root, so a blocked deposit can neither trade nor pay.
    function placeOrder(uint256 id, Placement calldata p, bytes calldata proof, bytes calldata sealedOrder) external nonReentrant {
        Auction storage a = _auction(id);
        if (block.timestamp >= a.callTime || a.voided) revert NotCollecting();
        if (!markets[a.asset].listed) revert MarketNotListed(); // a halted market takes no orders
        _checkAssociation(p.aspRoot, true);
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
        if (a.live >= _capacity(a)) revert AuctionFull();
        _verify(orderVerifier, proof, _placementInputs(id, a, p, keccak256(sealedOrder)));

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
    function _placementInputs(uint256 id, Auction storage a, Placement calldata p, bytes32 sealedHash) private view returns (bytes32[] memory inputs) {
        inputs = new bytes32[](15);
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
        inputs[11] = placementContext(id, p.relayer, p.fee, sealedHash);
        inputs[12] = p.aspRoot;
        inputs[13] = bytes32(minLock[a.asset]);
        inputs[14] = bytes32(minLock[a.quote]);
    }

    /// @notice At the call time, pin the call block and the reference (asset) and quote prices. Permissionless. A stale
    /// or missing price, an auction without orders, a delisted (halted) market, or a token its issuer paused or whose
    /// share multiplier is not 1 (a split or stock dividend) voids it: its orders are reclaimable at once.
    function pin(uint256 id) external {
        Auction storage a = _auction(id);
        if (block.timestamp < a.callTime) revert TooEarly();
        if (a.callBlock != 0 || a.voided) revert Voided();
        a.callBlock = uint64(block.number);
        a.pinnedAt = uint64(block.timestamp);
        (uint256 refUsd, bool refOk) = _price(a.asset);
        (uint256 quoteUsd, bool quoteOk) = _price(a.quote);
        if (!refOk || !quoteOk || a.live == 0 || !markets[a.asset].listed || !_tradable(a.asset) || !_tradable(a.quote)) {
            _void(id, a);
            return;
        }
        a.refUsd = uint64(refUsd);
        a.quoteUsd = uint64(quoteUsd);
        emit AuctionPinned(id, block.number, refUsd, quoteUsd);
    }

    /// @notice Settle a pinned auction. Permissionless; `notes` carries the outputs encrypted to their owners. With
    /// `c.roll`, rolled orders rest in `rollInto`, a collecting auction of the same pair with room for them; without it
    /// the proof refunds every leftover. Only a scheduler may leave slots out (`c.excluded`, for orders whose sealed
    /// opening does not open their commitment): those clear to nothing and their owners reclaim the lock.
    function settleAuction(uint256 id, Clearing calldata c, uint256 rollInto, bytes calldata proof, bytes calldata notes) external nonReentrant {
        Auction storage a = _auction(id);
        if (a.kind == Kind.RFQ) revert BadAuction();
        _checkSettleable(a);
        if (c.excluded != 0 && !scheduler[msg.sender]) revert NotScheduler();
        bytes32[] storage list = slots[id];
        _verify(clearVerifier, proof, _clearingInputs(a, list, c));

        a.settled = true;
        a.live = 0;
        excludedSlots[id] = c.excluded;
        uint256 n = list.length;
        for (uint256 i; i < n; i++) {
            if (list[i] == 0 || _isExcluded(c.excluded, i)) continue; // the proof fixed its outputs to 0
            _queue(c.fills[i]);
            if (c.rolls[i]) _rest(rollInto, _rollTarget(a, rollInto), c.residuals[i], "");
            else _queue(c.residuals[i]);
        }
        _queue(c.feeNote);
        prints.record(id, a.asset, c.pStar, c.crossedQty);
        emit AuctionSettled(id, c.pStar, c.crossedQty, c.excluded, notes);
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
        a.live = 0;
        for (uint256 i; i < list.length; i++) {
            if (list[i] == 0) continue;
            _queue(fills[i]);
            _queue(residuals[i]);
        }
        _queue(feeNote);
        prints.record(id, a.asset, a.refUsd, crossedQty);
        emit AuctionSettled(id, a.refUsd, crossedQty, 0, notes);
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

    /// @notice Take the lock of the order in `slot` back as a note (ReclaimProof): a cancel before the call time (once
    /// the reference price can be known, an order is committed), a reclaim once the auction was voided, or a reclaim of
    /// an order its settlement left out. Otherwise settled and pinned auctions cannot be reclaimed from.
    /// ponytail: no relayer, so the sender's address is linked to the reclaimed order; route through /api/relay later.
    function reclaim(uint256 id, uint256 slot, bytes32 orderNullifier, bytes32 refund, bytes calldata proof) external {
        Auction storage a = _auction(id);
        bool cancel = a.callBlock == 0 && !a.voided && block.timestamp < a.callTime;
        bool leftOut = a.settled && _isExcluded(excludedSlots[id], slot);
        if (!cancel && !a.voided && !leftOut) revert NotCollecting();
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
            freeSlots[id].push(slot);
            a.live--;
        }
        _queue(refund);
        emit OrderReclaimed(id, slot, commitment, cancel);
    }

    /// Auction `id`: its pair, kind, call time, pinned prices and state.
    function auctions(uint256 id) external view returns (Auction memory) {
        return auctionList[id];
    }

    /// How many auctions have been scheduled (ids are 0 to auctionCount - 1).
    function auctionCount() external view returns (uint256) {
        return auctionList.length;
    }

    /// Auction `id`'s order commitments in slot order; 0 = an empty (cancelled) slot.
    function orderList(uint256 id) external view returns (bytes32[] memory) {
        return slots[id];
    }

    // --- owner ---------------------------------------------------------------

    /// A market's unit can never change: open orders and notes are denominated in it. `maxAge` (1 s to MAX_STALENESS)
    /// follows the feed's heartbeat: a stock feed that updates every minute gets an hour, a stablecoin feed with a 24 h
    /// heartbeat about 25 hours.
    function setMarket(address token, address feed, uint88 unit, bool listed, uint16 capBps, uint32 maxAge) external onlyOwner {
        uint88 current = markets[token].unit;
        if (token == ETH || feed == address(0) || unit == 0 || (current != 0 && current != unit) || capBps > MAX_CAP_BPS) revert BadMarket();
        if (maxAge == 0 || maxAge > MAX_STALENESS) revert BadMarket();
        markets[token] = Market({feed: feed, unit: unit, listed: listed, capBps: capBps, maxAge: maxAge});
        emit MarketSet(token, feed, unit, listed, capBps, maxAge);
    }

    /// The smallest lock of an order on either side of `token`'s markets, in its micro-units (0 = none).
    function setMinLock(address token, uint256 minLock_) external onlyOwner {
        if (markets[token].unit == 0 || minLock_ >= MAX_MIN_LOCK) revert BadMarket();
        minLock[token] = minLock_;
        emit MinLockSet(token, minLock_);
    }

    /// Allow or stop `account` scheduling calendar auctions (not RFQ: only the desk opens those).
    function setScheduler(address account, bool allowed_) external onlyOwner {
        scheduler[account] = allowed_;
        emit SchedulerSet(account, allowed_);
    }

    /// Set once: the desk settles RFQ auctions with its own proof, so replacing it would let the owner write any note.
    function setDesk(address desk_) external onlyOwner {
        if (desk != address(0)) revert AlreadySet();
        if (desk_ == address(0)) revert ZeroAddress();
        desk = desk_;
        emit DeskSet(desk_);
    }

    /// The settlement fee (at most MAX_FEE_BPS) and the owner key of the fee notes; applies to auctions scheduled after.
    function setFee(bytes32 feeOwner_, uint16 feeBps_) external onlyOwner {
        _setFee(feeOwner_, feeBps_);
    }

    /// Pause or resume deposits. Only deposits: withdrawals, ragequits, cancels and reclaims stay open.
    function setDepositsPaused(bool paused_) external onlyOwner {
        depositsPaused = paused_;
        emit DepositsPausedSet(paused_);
    }

    /// Who may stop deposits or halt a market without the owner's delay (0 = nobody but the owner).
    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    /// @notice Guardian (or owner): pause deposits now. Every exit stays open; only the owner resumes deposits.
    function pauseDeposits() external {
        if (msg.sender != guardian && msg.sender != owner) revert NotGuardian();
        depositsPaused = true;
        emit DepositsPausedSet(true);
    }

    /// @notice Guardian (or owner): halt `token`'s market now. It takes no new orders and its auctions void at the pin, so
    /// every lock in them is reclaimable; only the owner lists it again (setMarket).
    function haltMarket(address token) external {
        if (msg.sender != guardian && msg.sender != owner) revert NotGuardian();
        Market storage m = markets[token];
        if (!m.listed) revert MarketNotListed();
        m.listed = false;
        emit MarketSet(token, m.feed, m.unit, false, m.capBps, m.maxAge);
    }

    /// The ETH fee on top of every deposit (at most MAX_DEPOSIT_FEE), paid to `recipient` for appending it.
    function setDepositFee(address recipient, uint256 fee) external onlyOwner {
        if (fee > MAX_DEPOSIT_FEE) revert BadFee();
        if (fee != 0 && recipient == address(0)) revert ZeroAddress();
        feeRecipient = recipient;
        depositFee = fee;
        emit DepositFeeSet(recipient, fee);
    }

    /// The screening gate for deposits and association roots (0 = none). The ragequit never consults it.
    function setGate(IScreeningGate gate_) external onlyOwner {
        gate = gate_;
        emit GateSet(address(gate_));
    }

    /// Start moving ownership to `newOwner`; it takes effect when they accept.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// Accept a pending ownership transfer.
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
        inputs = new bytes32[](13 + 4 * ORDERS);
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
            if (i < list.length && !_isExcluded(c.excluded, i)) inputs[10 + i] = list[i]; // an excluded slot proves as empty
            inputs[10 + ORDERS + i] = c.fills[i];
            inputs[10 + 2 * ORDERS + i] = c.residuals[i];
            inputs[10 + 3 * ORDERS + i] = bytes32(uint256(c.rolls[i] ? 1 : 0));
        }
        inputs[10 + 4 * ORDERS] = feeOwner;
        inputs[11 + 4 * ORDERS] = c.feeNote;
        inputs[12 + 4 * ORDERS] = bytes32(uint256(c.roll ? 1 : 0));
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

    /// A rolled order's next auction: same pair, listed, not RFQ, still collecting (_rest checks it has room).
    function _rollTarget(Auction storage from, uint256 id) private view returns (Auction storage a) {
        a = _auction(id);
        if (a.asset != from.asset || a.quote != from.quote || a.kind == Kind.RFQ || a.voided || block.timestamp >= a.callTime) revert BadAuction();
        if (!markets[a.asset].listed) revert MarketNotListed();
    }

    function _capacity(Auction storage a) private view returns (uint256) {
        return a.kind == Kind.RFQ ? RFQ_ORDERS : ORDERS;
    }

    function _isExcluded(uint64 mask, uint256 slot) private pure returns (bool) {
        return slot < ORDERS && (mask >> slot) & 1 == 1;
    }

    /// An association root must be a current one; value that moves needs one where the gate requires association.
    function _checkAssociation(bytes32 aspRoot, bool moves) private view {
        if (aspRoot != 0) {
            if (address(gate) == address(0) || !gate.isAssociationRoot(aspRoot)) revert UnknownAssociationRoot();
        } else if (moves && address(gate) != address(0) && gate.associationRequired()) {
            revert AssociationRequired();
        }
    }

    function _void(uint256 id, Auction storage a) private {
        a.voided = true;
        emit AuctionVoided(id);
    }

    function _queue(bytes32 commitment) private {
        uint256 index = commitments.length;
        commitments.push(commitment);
        emit Committed(index, commitment);
    }

    /// Rests an order in the auction's first free slot: a cancelled one, else a new one.
    function _rest(uint256 id, Auction storage a, bytes32 commitment, bytes memory sealedOrder) private {
        if (a.live >= _capacity(a)) revert AuctionFull();
        bytes32[] storage list = slots[id];
        uint256[] storage free = freeSlots[id];
        uint256 slot;
        if (free.length != 0) {
            slot = free[free.length - 1];
            free.pop();
            list[slot] = commitment;
        } else {
            slot = list.length;
            list.push(commitment);
        }
        a.live++;
        emit OrderResting(id, slot, commitment, sealedOrder);
    }

    function _setFee(bytes32 feeOwner_, uint16 feeBps_) private {
        if (uint256(feeOwner_) >= FIELD || feeBps_ > MAX_FEE_BPS) revert BadFee();
        feeOwner = feeOwner_;
        feeBps = feeBps_;
        emit FeeSet(feeOwner_, feeBps_);
    }

    /// False while the issuer has paused the token, or its share multiplier (ERC-8056 uiMultiplier: splits, stock
    /// dividends) is not one, or changes before this auction could settle: markets price one token as one share.
    /// Tokens without these functions (the quote tokens) are always tradable.
    function _tradable(address token) private view returns (bool) {
        (bool hasPause, uint256 paused) = _read(token, "paused()");
        if (hasPause && paused != 0) return false;
        (bool hasMultiplier, uint256 m) = _read(token, "uiMultiplier()");
        if (!hasMultiplier) return true;
        if (m != ONE_SHARE) return false;
        (, uint256 next) = _read(token, "newUIMultiplier()");
        (, uint256 at) = _read(token, "effectiveAt()");
        return next == 0 || next == ONE_SHARE || at > block.timestamp + SETTLE_DEADLINE;
    }

    function _read(address token, string memory signature) private view returns (bool ok, uint256 value) {
        (bool success, bytes memory ret) = token.staticcall(abi.encodeWithSignature(signature));
        if (success && ret.length >= 32) return (true, abi.decode(ret, (uint256)));
    }

    /// The token's USD price in micro-USD from its feed, or not ok when older than the market's maxAge, non-positive or
    /// failing.
    function _price(address token) private view returns (uint256 usd, bool ok) {
        Market storage m = markets[token];
        try IPriceFeed(m.feed).latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            ok = answer > 0 && updatedAt <= block.timestamp && block.timestamp - updatedAt <= m.maxAge
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
