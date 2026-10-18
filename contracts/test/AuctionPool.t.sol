// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AuctionPool} from "../src/AuctionPool.sol";
import {RfqDesk} from "../src/RfqDesk.sol";
import {PrintRegistry} from "../src/PrintRegistry.sol";
import {IPrintRegistry, IProofVerifier, IScreeningGate} from "../src/Interfaces.sol";
import {ScreeningGate} from "../src/ScreeningGate.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {TreasuryQuote} from "../src/mocks/TreasuryQuote.sol";
import {ERC20} from "../src/mocks/ERC20.sol";

/// Accepts (or rejects) every proof and records the public inputs it was asked to check. The real verifiers and proof
/// fixtures are covered in the circuit tests.
contract RecordingVerifier is IProofVerifier {
    bool public accept = true;
    bytes32[] public last;

    function setAccept(bool a) external {
        accept = a;
    }

    function verify(bytes calldata, bytes32[] calldata inputs) external returns (bool) {
        last = inputs;
        return accept;
    }

    function input(uint256 i) external view returns (bytes32) {
        return last[i];
    }

    function count() external view returns (uint256) {
        return last.length;
    }
}

contract MockStock is ERC20 {
    constructor() ERC20("Tesla", "TSLA", 18) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// A Robinhood Chain stock token's issuer controls (ERC-8056 scaled UI amount): pause and the share multiplier.
contract MockScaledStock is ERC20 {
    bool public paused;
    uint256 public uiMultiplier = 1e18;
    uint256 public newUIMultiplier = 1e18;
    uint256 public effectiveAt;

    constructor() ERC20("Scaled", "SCL", 18) {}

    function setPaused(bool p) external {
        paused = p;
    }

    function updateMultiplier(uint256 m, uint256 at) external {
        newUIMultiplier = m;
        effectiveAt = at;
        if (at <= block.timestamp) uiMultiplier = m;
    }
}

/// A gate that fails every call: the ragequit never consults it.
contract RevertingGate is IScreeningGate {
    function allowed(address) external pure returns (bool) {
        revert();
    }

    function associationRequired() external pure returns (bool) {
        revert();
    }

    function isAssociationRoot(bytes32) external pure returns (bool) {
        revert();
    }
}

contract AuctionPoolTest is Test {
    AuctionPool pool;
    RfqDesk desk;
    PrintRegistry registry;
    RecordingVerifier depositV;
    RecordingVerifier treeV;
    RecordingVerifier transactV;
    RecordingVerifier orderV;
    RecordingVerifier clearV;
    RecordingVerifier reclaimV;
    RecordingVerifier rfqV;
    MockStock tsla;
    MockUSDG usdg;
    TreasuryQuote tq;
    MockAggregator tslaFeed;
    MockAggregator usdgFeed;

    address operator = makeAddr("operator");
    address alice = makeAddr("alice");
    bytes32 constant FEE_OWNER = bytes32(uint256(424242));
    bytes32 constant EMPTY_ROOT = 0x01da7c268b18dfc969f3ae497fff3fef7909905d6bd3d40b212d1d1544e1be88;
    uint256 constant T0 = 1_790_000_000;

    function setUp() public {
        vm.warp(T0);
        depositV = new RecordingVerifier();
        treeV = new RecordingVerifier();
        transactV = new RecordingVerifier();
        orderV = new RecordingVerifier();
        clearV = new RecordingVerifier();
        reclaimV = new RecordingVerifier();
        rfqV = new RecordingVerifier();
        registry = new PrintRegistry();
        pool = new AuctionPool(
            address(this),
            AuctionPool.Verifiers(depositV, treeV, transactV, orderV, clearV, reclaimV),
            IPrintRegistry(address(registry)),
            FEE_OWNER,
            5
        );
        registry.setWriter(address(pool));
        desk = new RfqDesk(pool, rfqV);
        pool.setDesk(address(desk));
        pool.setScheduler(operator, true);

        tsla = new MockStock();
        usdg = new MockUSDG();
        tq = new TreasuryQuote(usdg, operator);
        usdg.setMinter(address(tq));
        tslaFeed = new MockAggregator("TSLA / USD", operator, 250e8);
        usdgFeed = new MockAggregator("USDG / USD", operator, 1e8);
        pool.setMarket(address(tsla), address(tslaFeed), 1e12, true, 500);
        pool.setMarket(address(tq), address(tq), 1, true, 100);
        pool.setMarket(address(usdg), address(usdgFeed), 1, false, 0);
    }

    // --- helpers ---

    function _schedule(uint64 inSeconds) internal returns (uint256) {
        vm.prank(operator);
        return pool.schedule(address(tsla), address(tq), AuctionPool.Kind.CLOSE, uint64(block.timestamp) + inSeconds);
    }

    function _placement(bytes32 commitment, uint256 salt) internal pure returns (AuctionPool.Placement memory p) {
        p.root = 0x01da7c268b18dfc969f3ae497fff3fef7909905d6bd3d40b212d1d1544e1be88; // EMPTY_ROOT is always known
        p.nullifier = bytes32(salt);
        p.change = bytes32(salt + 1);
        p.commitment = commitment;
    }

    function _place(uint256 id, bytes32 commitment, uint256 salt) internal {
        pool.placeOrder(id, _placement(commitment, salt), "", "sealed");
    }

    function _clearing(uint256 n, bool roll) internal pure returns (AuctionPool.Clearing memory c) {
        c.pStar = 251e6;
        c.crossedQty = 3e6;
        for (uint256 i; i < n; i++) {
            c.fills[i] = bytes32(1000 + i);
            c.residuals[i] = bytes32(2000 + i);
            c.rolls[i] = roll && i == 0;
        }
        c.feeNote = bytes32(uint256(9999));
        c.roll = roll;
    }

    function _tx() internal pure returns (AuctionPool.Transaction memory t) {
        t.root = EMPTY_ROOT;
        t.nullifiers = [bytes32(uint256(1)), bytes32(uint256(2))];
        t.outputs = [bytes32(uint256(3)), bytes32(uint256(4))];
    }

    function _gate(bool required) internal returns (ScreeningGate g) {
        g = new ScreeningGate(address(this), address(this));
        pool.setGate(IScreeningGate(address(g)));
        g.setAssociationRequired(required);
        g.postAssociationRoot(bytes32(uint256(777)));
    }

    function _depositEth(address from, uint256 amount) internal {
        vm.deal(from, amount);
        vm.prank(from);
        pool.deposit{value: amount}(address(0), amount, bytes32(uint256(77)), "");
    }

    // --- notes ---

    function test_deposit_token_queues_the_note() public {
        tsla.mint(alice, 5e18);
        vm.startPrank(alice);
        tsla.approve(address(pool), 5e18);
        uint256 label = pool.depositLabel(alice);
        pool.deposit(address(tsla), 5e18, bytes32(uint256(77)), "");
        vm.stopPrank();
        assertEq(pool.commitmentCount(), 1);
        assertEq(tsla.balanceOf(address(pool)), 5e18);
        assertEq(depositV.input(3), bytes32(label));
        assertTrue(pool.depositLabel(alice) != label, "label advances with the nonce");
    }

    function test_deposit_rejects_an_unknown_token() public {
        MockStock other = new MockStock();
        vm.expectRevert(AuctionPool.AssetNotAllowed.selector);
        pool.deposit(address(other), 1, bytes32(uint256(1)), "");
    }

    function test_deposit_rejects_a_bad_proof() public {
        depositV.setAccept(false);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(AuctionPool.InvalidProof.selector);
        pool.deposit{value: 1 ether}(address(0), 1 ether, bytes32(uint256(1)), "");
    }

    // --- scheduling and placement ---

    function test_only_schedulers_schedule_and_only_the_desk_opens_rfq() public {
        vm.expectRevert(AuctionPool.NotScheduler.selector);
        pool.schedule(address(tsla), address(tq), AuctionPool.Kind.OPEN, uint64(block.timestamp + 60));
        vm.prank(operator);
        vm.expectRevert(AuctionPool.NotScheduler.selector);
        pool.schedule(address(tsla), address(tq), AuctionPool.Kind.RFQ, uint64(block.timestamp + 60));
        vm.prank(operator);
        vm.expectRevert(AuctionPool.MarketNotListed.selector);
        pool.schedule(address(usdg), address(tq), AuctionPool.Kind.OPEN, uint64(block.timestamp + 60));
    }

    function test_placement_binds_the_auction_pair_and_context() public {
        uint256 id = _schedule(600);
        _place(id, bytes32(uint256(5)), 100);
        assertEq(orderV.count(), 15);
        assertEq(orderV.input(5), bytes32(uint256(uint160(address(tsla)))));
        assertEq(orderV.input(6), bytes32(uint256(1e12)));
        assertEq(orderV.input(7), bytes32(uint256(uint160(address(tq)))));
        assertEq(orderV.input(8), bytes32(uint256(1)));
        assertEq(orderV.input(11), pool.placementContext(id, address(0), 0, keccak256("sealed")));
        assertTrue(pool.placementContext(id, address(0), 0, keccak256("sealed")) != pool.placementContext(id + 1, address(0), 0, keccak256("sealed")));
        // the proof binds the ciphertext: replaying it with other sealed bytes changes the context
        assertTrue(pool.placementContext(id, address(0), 0, keccak256("sealed")) != pool.placementContext(id, address(0), 0, keccak256("junk")));
        assertEq(orderV.input(12), bytes32(0)); // no association root
        assertEq(pool.auctions(id).live, 1);
        assertTrue(pool.spent(bytes32(uint256(100))));
    }

    function test_no_orders_after_the_call_time() public {
        uint256 id = _schedule(600);
        vm.warp(block.timestamp + 600);
        vm.expectRevert(AuctionPool.NotCollecting.selector);
        _place(id, bytes32(uint256(5)), 100);
    }

    function test_a_spent_note_cannot_place_twice() public {
        uint256 id = _schedule(600);
        _place(id, bytes32(uint256(5)), 100);
        vm.expectRevert(AuctionPool.NoteSpent.selector);
        _place(id, bytes32(uint256(6)), 100);
    }

    function test_an_auction_holds_64_orders_and_a_cancel_frees_its_slot() public {
        uint256 a = _schedule(600);
        uint256 b = _schedule(1200);
        for (uint256 i; i < 64; i++) {
            _place(a, bytes32(i + 1), 1000 + 2 * i);
        }
        vm.expectRevert(AuctionPool.AuctionFull.selector);
        _place(a, bytes32(uint256(99)), 5000);
        _place(b, bytes32(uint256(98)), 5002); // a full auction does not hold other auctions of the asset
        pool.reclaim(a, 5, bytes32(uint256(55)), bytes32(uint256(56)), "");
        _place(a, bytes32(uint256(99)), 5004);
        assertEq(pool.orderList(a)[5], bytes32(uint256(99)), "the cancelled slot is reused");
        assertEq(pool.orderList(a).length, 64);
        assertEq(pool.auctions(a).live, 64);
    }

    function test_place_and_cancel_cannot_fill_an_rfq_block() public {
        uint256 id = desk.open(address(tsla), address(tq), 5 minutes);
        for (uint256 i; i < 5; i++) {
            _place(id, bytes32(i + 1), 100 + 2 * i);
            pool.reclaim(id, 0, bytes32(uint256(55 + i)), bytes32(uint256(56)), "");
        }
        _place(id, bytes32(uint256(7)), 200);
        _place(id, bytes32(uint256(8)), 202);
        assertEq(pool.orderList(id).length, 2);
        assertEq(pool.auctions(id).live, 2);
    }

    function test_relayed_order_pays_the_relayer_in_eth() public {
        uint256 id = _schedule(600);
        vm.deal(address(pool), 1 ether);
        AuctionPool.Placement memory p = _placement(bytes32(uint256(5)), 100);
        p.feeNullifier = bytes32(uint256(300));
        p.feeChange = bytes32(uint256(301));
        p.relayer = makeAddr("relayer");
        p.fee = 0.001 ether;
        pool.placeOrder(id, p, "", "");
        assertEq(p.relayer.balance, 0.001 ether);
        assertEq(pool.commitmentCount(), 2); // change + fee change
    }

    // --- pin ---

    function test_pin_records_block_and_prices() public {
        uint256 id = _schedule(600);
        _place(id, bytes32(uint256(5)), 100);
        vm.expectRevert(AuctionPool.TooEarly.selector);
        pool.pin(id);
        vm.warp(block.timestamp + 600);
        vm.prank(operator);
        tslaFeed.push(251e8);
        vm.roll(777);
        pool.pin(id);
        AuctionPool.Auction memory a = pool.auctions(id);
        assertEq(a.callBlock, 777);
        assertEq(a.refUsd, 251e6);
        assertEq(a.quoteUsd, 1e6);
        assertFalse(a.voided);
    }

    function test_a_stale_price_voids_the_auction() public {
        uint256 id = _schedule(600);
        _place(id, bytes32(uint256(5)), 100);
        vm.warp(block.timestamp + 2 hours); // the feed was last pushed at T0
        pool.pin(id);
        assertTrue(pool.auctions(id).voided);
    }

    function test_an_empty_auction_is_voided_at_pin() public {
        uint256 id = _schedule(600);
        vm.warp(block.timestamp + 600);
        pool.pin(id);
        assertTrue(pool.auctions(id).voided);
    }

    function test_nav_auction_uses_nav_as_reference() public {
        vm.prank(operator);
        uint256 id = pool.schedule(address(tq), address(usdg), AuctionPool.Kind.NAV, uint64(block.timestamp + 600));
        _place(id, bytes32(uint256(5)), 100);
        vm.warp(block.timestamp + 600);
        vm.prank(operator);
        usdgFeed.push(1e8);
        vm.prank(operator);
        tq.raiseNav(1_004_000);
        pool.pin(id);
        assertEq(pool.auctions(id).refUsd, 1_004_000);
        assertEq(pool.auctions(id).quoteUsd, 1e6);
    }

    // --- settle ---

    function _pinned(uint256 orders) internal returns (uint256 id) {
        id = _schedule(600);
        for (uint256 i; i < orders; i++) {
            _place(id, bytes32(i + 1), 100 + 2 * i);
        }
        vm.warp(block.timestamp + 600);
        vm.prank(operator);
        tslaFeed.push(250e8);
        pool.pin(id);
    }

    function test_settle_queues_outputs_and_prints_in_the_same_tx() public {
        uint256 id = _pinned(2);
        uint256 before = pool.commitmentCount();
        pool.settleAuction(id, _clearing(2, false), 0, "", "notes");
        assertEq(pool.commitmentCount(), before + 5); // 2 fills, 2 refunds, fee note
        assertTrue(pool.auctions(id).settled);
        assertEq(pool.auctions(id).live, 0);
        assertEq(registry.count(), 1);
        PrintRegistry.Print memory p = registry.get(0);
        assertEq(p.auctionId, id);
        assertEq(p.pStar, 251e6);
        assertEq(p.crossedQty, 3e6);
        assertEq(p.timestamp, block.timestamp);
    }

    function test_settle_binds_the_pinned_state() public {
        uint256 id = _pinned(2);
        pool.settleAuction(id, _clearing(2, false), 0, "", "");
        assertEq(clearV.count(), 13 + 4 * 64);
        assertEq(clearV.input(0), bytes32(uint256(uint160(address(tsla)))));
        assertEq(clearV.input(4), bytes32(uint256(250e6))); // ref
        assertEq(clearV.input(5), bytes32(uint256(500))); // cap
        assertEq(clearV.input(6), bytes32(uint256(1e6))); // quote price
        assertEq(clearV.input(7), bytes32(uint256(5))); // fee bps
        assertEq(clearV.input(8), bytes32(uint256(251e6))); // p*
        assertEq(clearV.input(10), bytes32(uint256(1))); // first order
        assertEq(clearV.input(12), bytes32(0)); // empty slot
        assertEq(clearV.input(10 + 4 * 64), FEE_OWNER);
        assertEq(clearV.input(12 + 4 * 64), bytes32(0)); // no roll target: every leftover is refunded
    }

    function test_settle_rejects_a_bad_proof_and_settles_once() public {
        uint256 id = _pinned(1);
        clearV.setAccept(false);
        vm.expectRevert(AuctionPool.InvalidProof.selector);
        pool.settleAuction(id, _clearing(1, false), 0, "", "");
        clearV.setAccept(true);
        pool.settleAuction(id, _clearing(1, false), 0, "", "");
        vm.expectRevert(AuctionPool.AlreadySettled.selector);
        pool.settleAuction(id, _clearing(1, false), 0, "", "");
    }

    function test_settle_needs_a_pin() public {
        uint256 id = _schedule(600);
        _place(id, bytes32(uint256(1)), 100);
        vm.expectRevert(AuctionPool.NotPinned.selector);
        pool.settleAuction(id, _clearing(1, false), 0, "", "");
    }

    function test_rolled_orders_rest_in_the_next_auction() public {
        uint256 id = _pinned(2);
        uint256 next = _schedule(600);
        pool.settleAuction(id, _clearing(2, true), next, "", "");
        bytes32[] memory list = pool.orderList(next);
        assertEq(list.length, 1);
        assertEq(list[0], bytes32(uint256(2000))); // the rolled order commitment
        assertEq(pool.auctions(next).live, 1);
        assertEq(clearV.input(12 + 4 * 64), bytes32(uint256(1)));
    }

    function test_rolls_cannot_go_into_another_pair_or_a_closed_auction() public {
        uint256 id = _pinned(1);
        vm.prank(operator);
        uint256 nav = pool.schedule(address(tq), address(usdg), AuctionPool.Kind.NAV, uint64(block.timestamp + 600));
        vm.expectRevert(AuctionPool.BadAuction.selector);
        pool.settleAuction(id, _clearing(1, true), nav, "", "");
        vm.expectRevert(AuctionPool.BadAuction.selector);
        pool.settleAuction(id, _clearing(1, true), id, "", ""); // its own call time has passed
    }

    // --- cancel, abandon, reclaim ---

    function test_cancel_while_collecting_frees_the_slot() public {
        uint256 id = _schedule(600);
        _place(id, bytes32(uint256(5)), 100);
        pool.reclaim(id, 0, bytes32(uint256(55)), bytes32(uint256(56)), "");
        assertEq(pool.orderList(id)[0], bytes32(0));
        assertEq(pool.auctions(id).live, 0);
        assertEq(reclaimV.input(4), bytes32(uint256(5)));
        vm.expectRevert(AuctionPool.NoteSpent.selector);
        pool.reclaim(id, 0, bytes32(uint256(55)), bytes32(uint256(56)), "");
    }

    function test_no_reclaim_while_pinned_or_after_settlement() public {
        uint256 id = _pinned(1);
        vm.expectRevert(AuctionPool.NotCollecting.selector);
        pool.reclaim(id, 0, bytes32(uint256(55)), bytes32(uint256(56)), "");
        pool.settleAuction(id, _clearing(1, false), 0, "", "");
        vm.expectRevert(AuctionPool.NotCollecting.selector);
        pool.reclaim(id, 0, bytes32(uint256(55)), bytes32(uint256(56)), "");
    }

    function test_abandoned_auction_orders_are_reclaimable_once() public {
        uint256 id = _pinned(2);
        vm.expectRevert(AuctionPool.TooEarly.selector);
        pool.abandon(id);
        vm.warp(block.timestamp + 1 hours);
        pool.abandon(id);
        assertTrue(pool.auctions(id).voided);
        vm.expectRevert(AuctionPool.Voided.selector);
        pool.settleAuction(id, _clearing(2, false), 0, "", "");
        pool.reclaim(id, 1, bytes32(uint256(55)), bytes32(uint256(56)), "");
        vm.expectRevert(AuctionPool.NoteSpent.selector);
        pool.reclaim(id, 1, bytes32(uint256(55)), bytes32(uint256(56)), "");
    }

    // --- RFQ ---

    function test_rfq_block_settles_at_the_reference() public {
        uint256 id = desk.open(address(tsla), address(tq), 5 minutes);
        _place(id, bytes32(uint256(1)), 100);
        _place(id, bytes32(uint256(2)), 102);
        vm.expectRevert(AuctionPool.AuctionFull.selector);
        _place(id, bytes32(uint256(3)), 104);
        vm.warp(block.timestamp + 5 minutes);
        vm.prank(operator);
        tslaFeed.push(252e8);
        pool.pin(id);

        vm.expectRevert(AuctionPool.BadAuction.selector);
        pool.settleAuction(id, _clearing(2, false), 0, "", "");
        vm.expectRevert(AuctionPool.NotDesk.selector);
        pool.settleFromDesk(id, new bytes32[](2), new bytes32[](2), 0, 0, "");

        bytes32[2] memory fills = [bytes32(uint256(11)), bytes32(uint256(12))];
        bytes32[2] memory refunds = [bytes32(uint256(21)), bytes32(uint256(22))];
        uint256 before = pool.commitmentCount();
        desk.settle(id, fills, refunds, bytes32(uint256(31)), 1e6, "", "");
        // every rfq_cross public input, in circuit order
        bytes32[16] memory want = [
            bytes32(uint256(uint160(address(tsla)))), bytes32(uint256(1e12)), bytes32(uint256(uint160(address(tq)))),
            bytes32(uint256(1)), bytes32(uint256(252e6)), bytes32(uint256(1e6)), bytes32(uint256(5)), bytes32(uint256(1e6)),
            bytes32(uint256(1)), bytes32(uint256(2)), fills[0], fills[1], refunds[0], refunds[1], FEE_OWNER, bytes32(uint256(31))
        ];
        assertEq(rfqV.count(), 16);
        for (uint256 i; i < 16; i++) {
            assertEq(rfqV.input(i), want[i]);
        }
        // the pool queues each order's fill and refund, then the fee note
        assertEq(pool.commitmentCount(), before + 5);
        bytes32[5] memory queued = [fills[0], refunds[0], fills[1], refunds[1], bytes32(uint256(31))];
        for (uint256 i; i < 5; i++) {
            assertEq(pool.commitments(before + i), queued[i]);
        }
        PrintRegistry.Print memory p = registry.get(0);
        assertEq(p.pStar, 252e6);
        assertEq(p.crossedQty, 1e6);
        assertTrue(pool.auctions(id).settled);
    }

    // --- registry, treasury quote ---

    function test_only_the_pool_prints() public {
        vm.expectRevert(PrintRegistry.NotWriter.selector);
        registry.record(0, address(tsla), 1, 1);
    }

    function test_treasury_quote_nav_rises_and_is_backed() public {
        usdg.mint(alice, 1000e6);
        vm.startPrank(alice);
        usdg.approve(address(tq), 1000e6);
        tq.deposit(1000e6, alice);
        vm.stopPrank();
        assertEq(tq.balanceOf(alice), 1000e6);

        vm.startPrank(operator);
        vm.expectRevert(TreasuryQuote.BadNav.selector);
        tq.raiseNav(1_020_000); // over the 1% step
        tq.raiseNav(1_010_000);
        vm.stopPrank();
        (, int256 answer,,,) = tq.latestRoundData();
        assertEq(answer, 1_010_000 * 100);

        vm.prank(alice);
        uint256 out = tq.redeem(1000e6, alice, alice);
        assertEq(out, 1010e6);
        assertEq(usdg.balanceOf(alice), 1010e6);
    }

    function test_usdg_faucet_is_capped() public {
        vm.expectRevert(MockUSDG.TooMuch.selector);
        usdg.mint(alice, 10_001e6);
    }

    // --- audit fixes: rolls, left-out orders, cancel cutoff ---

    function test_a_roll_into_a_full_auction_reverts_so_the_settler_refunds() public {
        uint256 id = _pinned(1);
        uint256 next = _schedule(600);
        for (uint256 i; i < 64; i++) {
            _place(next, bytes32(i + 100), 3000 + 2 * i);
        }
        vm.expectRevert(AuctionPool.AuctionFull.selector);
        pool.settleAuction(id, _clearing(1, true), next, "", "");
        pool.settleAuction(id, _clearing(1, false), 0, "", "");
        assertTrue(pool.auctions(id).settled);
    }

    function test_settlement_can_leave_an_unopenable_order_out() public {
        uint256 id = _pinned(3);
        AuctionPool.Clearing memory c = _clearing(3, false);
        c.excluded = 1 << 1;
        vm.expectRevert(AuctionPool.NotScheduler.selector);
        pool.settleAuction(id, c, 0, "", "");
        uint256 before = pool.commitmentCount();
        vm.prank(operator);
        pool.settleAuction(id, c, 0, "", "");
        assertEq(clearV.input(10), bytes32(uint256(1)));
        assertEq(clearV.input(11), bytes32(0), "the left-out slot proves as empty");
        assertEq(clearV.input(12), bytes32(uint256(3)));
        assertEq(pool.commitmentCount(), before + 5); // 2 fills, 2 refunds, fee note
        assertEq(pool.excludedSlots(id), 2);
        pool.reclaim(id, 1, bytes32(uint256(55)), bytes32(uint256(56)), "");
        vm.expectRevert(AuctionPool.NoteSpent.selector);
        pool.reclaim(id, 1, bytes32(uint256(55)), bytes32(uint256(56)), "");
        vm.expectRevert(AuctionPool.NotCollecting.selector);
        pool.reclaim(id, 0, bytes32(uint256(57)), bytes32(uint256(58)), ""); // a settled order cannot be reclaimed
    }

    function test_no_cancel_after_the_call_time() public {
        uint256 id = _schedule(600);
        _place(id, bytes32(uint256(5)), 100);
        vm.warp(block.timestamp + 600);
        vm.expectRevert(AuctionPool.NotCollecting.selector);
        pool.reclaim(id, 0, bytes32(uint256(55)), bytes32(uint256(56)), "");
    }

    // --- audit fixes: association, ragequit ---

    function test_a_relayer_fee_alone_needs_association_where_required() public {
        _gate(true);
        vm.deal(address(pool), 1 ether);
        AuctionPool.Transaction memory t = _tx();
        t.fee = 1;
        t.relayer = makeAddr("relayer");
        vm.expectRevert(AuctionPool.AssociationRequired.selector);
        pool.transact(t, "", "");
        t.aspRoot = bytes32(uint256(777));
        pool.transact(t, "", "");
        assertEq(t.relayer.balance, 1);
    }

    function test_orders_need_association_where_required() public {
        _gate(true);
        uint256 id = _schedule(600);
        vm.expectRevert(AuctionPool.AssociationRequired.selector);
        _place(id, bytes32(uint256(5)), 100);
        AuctionPool.Placement memory p = _placement(bytes32(uint256(5)), 100);
        p.aspRoot = bytes32(uint256(778));
        vm.expectRevert(AuctionPool.UnknownAssociationRoot.selector);
        pool.placeOrder(id, p, "", "sealed");
        p.aspRoot = bytes32(uint256(777));
        pool.placeOrder(id, p, "", "sealed");
        assertEq(orderV.input(12), bytes32(uint256(777)));
    }

    function test_ragequit_pays_the_depositor_whatever_the_owner_does() public {
        _depositEth(alice, 1 ether);
        uint256 label = pool.labelOf(alice, 0);
        _gate(true);
        pool.setGate(IScreeningGate(address(new RevertingGate()))); // even a broken gate cannot stop it
        pool.setDepositsPaused(true);
        AuctionPool.Transaction memory t = _tx();
        t.released = 0.4 ether;
        t.to = alice;
        vm.expectRevert();
        pool.transact(t, "", ""); // the screened path asks the gate
        pool.ragequit(t, 0, "", "");
        assertEq(alice.balance, 0.4 ether);
        assertEq(transactV.count(), 11);
        assertEq(transactV.input(10), bytes32(label));
    }

    function test_ragequit_only_pays_a_depositor_their_own_deposit() public {
        vm.deal(address(pool), 1 ether);
        AuctionPool.Transaction memory t = _tx();
        t.released = 0.4 ether;
        t.to = alice;
        vm.expectRevert(AuctionPool.BadAmount.selector);
        pool.ragequit(t, 0, "", ""); // alice never deposited
        _depositEth(alice, 1 ether);
        vm.expectRevert(AuctionPool.BadAmount.selector);
        pool.ragequit(t, 1, "", ""); // a deposit she has not made
        t.fee = 1;
        t.relayer = alice;
        vm.expectRevert(AuctionPool.BadAmount.selector);
        pool.ragequit(t, 0, "", ""); // no relayer fee
        t.fee = 0;
        t.aspRoot = bytes32(uint256(777));
        vm.expectRevert(AuctionPool.BadAmount.selector);
        pool.ragequit(t, 0, "", "");
        t.aspRoot = 0;
        t.released = 0;
        vm.expectRevert(AuctionPool.BadAmount.selector);
        pool.ragequit(t, 0, "", "");
    }

    function test_the_transact_proof_keeps_the_label_private() public {
        vm.deal(address(pool), 1 ether);
        AuctionPool.Transaction memory t = _tx();
        t.released = 1;
        t.to = alice;
        pool.transact(t, "", "");
        assertEq(transactV.input(10), bytes32(0));
        assertEq(transactV.input(9), pool.context(alice, address(0), 0));
    }

    // --- audit fixes: owner powers ---

    function test_the_desk_is_set_once() public {
        vm.expectRevert(AuctionPool.AlreadySet.selector);
        pool.setDesk(makeAddr("other desk"));
    }

    function test_min_lock_is_owner_set_bounded_and_bound_into_the_proof() public {
        vm.prank(alice);
        vm.expectRevert(AuctionPool.NotOwner.selector);
        pool.setMinLock(address(tsla), 1);
        vm.expectRevert(AuctionPool.BadMarket.selector);
        pool.setMinLock(address(tsla), 1 << 64);
        vm.expectRevert(AuctionPool.BadMarket.selector);
        pool.setMinLock(makeAddr("unknown"), 1);
        pool.setMinLock(address(tsla), 50_000);
        pool.setMinLock(address(tq), 25e6);
        uint256 id = _schedule(600);
        _place(id, bytes32(uint256(5)), 100);
        assertEq(orderV.input(13), bytes32(uint256(50_000)));
        assertEq(orderV.input(14), bytes32(uint256(25e6)));
    }

    function test_owner_setters_are_owner_only() public {
        vm.startPrank(alice);
        vm.expectRevert(AuctionPool.NotOwner.selector);
        pool.setMarket(address(tsla), address(tslaFeed), 1e12, true, 500);
        vm.expectRevert(AuctionPool.NotOwner.selector);
        pool.setScheduler(alice, true);
        vm.expectRevert(AuctionPool.NotOwner.selector);
        pool.setDesk(alice);
        vm.expectRevert(AuctionPool.NotOwner.selector);
        pool.setFee(FEE_OWNER, 5);
        vm.expectRevert(AuctionPool.NotOwner.selector);
        pool.setDepositsPaused(true);
        vm.expectRevert(AuctionPool.NotOwner.selector);
        pool.setDepositFee(alice, 1);
        vm.expectRevert(AuctionPool.NotOwner.selector);
        pool.setGate(IScreeningGate(alice));
        vm.expectRevert(AuctionPool.NotOwner.selector);
        pool.transferOwnership(alice);
        vm.stopPrank();
    }

    function test_owner_setters_are_bounded() public {
        vm.expectRevert(AuctionPool.BadMarket.selector);
        pool.setMarket(address(tsla), address(tslaFeed), 1e6, true, 500); // a unit never changes
        vm.expectRevert(AuctionPool.BadMarket.selector);
        pool.setMarket(address(tsla), address(tslaFeed), 1e12, true, 2001);
        vm.expectRevert(AuctionPool.BadMarket.selector);
        pool.setMarket(address(0), address(tslaFeed), 1e12, true, 500);
        vm.expectRevert(AuctionPool.BadMarket.selector);
        pool.setMarket(address(tsla), address(0), 1e12, true, 500);
        vm.expectRevert(AuctionPool.BadFee.selector);
        pool.setFee(FEE_OWNER, 101);
        vm.expectRevert(AuctionPool.BadFee.selector);
        pool.setFee(bytes32(type(uint256).max), 5);
        vm.expectRevert(AuctionPool.BadFee.selector);
        pool.setDepositFee(alice, 0.0011 ether);
        vm.expectRevert(AuctionPool.ZeroAddress.selector);
        pool.setDepositFee(address(0), 1);
    }

    function test_ownership_moves_in_two_steps() public {
        pool.transferOwnership(alice);
        vm.expectRevert(AuctionPool.NotPendingOwner.selector);
        pool.acceptOwnership();
        vm.prank(alice);
        pool.acceptOwnership();
        assertEq(pool.owner(), alice);
        assertEq(pool.pendingOwner(), address(0));
        vm.expectRevert(AuctionPool.NotOwner.selector);
        pool.setDepositsPaused(true);
    }

    function test_pausing_deposits_leaves_withdrawals_and_cancels_open() public {
        _depositEth(alice, 1 ether);
        pool.setDepositsPaused(true);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(AuctionPool.IsPaused.selector);
        pool.deposit{value: 1 ether}(address(0), 1 ether, bytes32(uint256(78)), "");
        AuctionPool.Transaction memory t = _tx();
        t.released = 1 ether;
        t.to = makeAddr("bob");
        pool.transact(t, "", "");
        assertEq(t.to.balance, 1 ether);
        uint256 id = _schedule(600);
        _place(id, bytes32(uint256(5)), 100);
        pool.reclaim(id, 0, bytes32(uint256(55)), bytes32(uint256(56)), "");
    }

    // --- audit fixes: issuer controls and corporate actions ---

    function _scaledAuction() internal returns (MockScaledStock s, uint256 id) {
        s = new MockScaledStock();
        MockAggregator feed = new MockAggregator("SCL / USD", operator, 100e8);
        pool.setMarket(address(s), address(feed), 1e12, true, 500);
        vm.prank(operator);
        id = pool.schedule(address(s), address(tq), AuctionPool.Kind.CLOSE, uint64(block.timestamp + 600));
        _place(id, bytes32(uint256(5)), 100);
        vm.warp(block.timestamp + 600);
        vm.prank(operator);
        feed.push(100e8);
    }

    function test_pin_runs_while_one_token_is_one_share() public {
        (, uint256 id) = _scaledAuction();
        pool.pin(id);
        assertFalse(pool.auctions(id).voided);
        assertEq(pool.auctions(id).refUsd, 100e6);
    }

    function test_an_issuer_pause_voids_the_auction_at_pin() public {
        (MockScaledStock s, uint256 id) = _scaledAuction();
        s.setPaused(true);
        pool.pin(id);
        assertTrue(pool.auctions(id).voided);
    }

    function test_a_split_voids_the_auction_at_pin() public {
        (MockScaledStock s, uint256 id) = _scaledAuction();
        s.updateMultiplier(10e18, block.timestamp);
        pool.pin(id);
        assertTrue(pool.auctions(id).voided);
    }

    function test_a_multiplier_change_due_before_settlement_voids_it() public {
        (MockScaledStock s, uint256 id) = _scaledAuction();
        s.updateMultiplier(10e18, block.timestamp + 30 minutes);
        pool.pin(id);
        assertTrue(pool.auctions(id).voided);
    }

    function test_a_multiplier_change_after_settlement_does_not_void_it() public {
        (MockScaledStock s, uint256 id) = _scaledAuction();
        s.updateMultiplier(10e18, block.timestamp + 2 days);
        pool.pin(id);
        assertFalse(pool.auctions(id).voided);
    }

    function test_a_delisted_market_takes_no_orders_and_voids_at_pin() public {
        uint256 id = _schedule(600);
        _place(id, bytes32(uint256(5)), 100);
        pool.setMarket(address(tsla), address(tslaFeed), 1e12, false, 500);
        vm.expectRevert(AuctionPool.MarketNotListed.selector);
        _place(id, bytes32(uint256(6)), 102);
        vm.warp(block.timestamp + 600);
        vm.prank(operator);
        tslaFeed.push(250e8);
        pool.pin(id);
        assertTrue(pool.auctions(id).voided);
    }

    // --- invalid input on every entry point ---

    function test_transact_rejects_unknown_roots_spent_notes_and_bad_proofs() public {
        vm.deal(address(pool), 1 ether);
        AuctionPool.Transaction memory t = _tx();
        t.root = bytes32(uint256(123));
        vm.expectRevert(AuctionPool.UnknownRoot.selector);
        pool.transact(t, "", "");
        t = _tx();
        t.nullifiers[1] = t.nullifiers[0];
        vm.expectRevert(AuctionPool.NoteSpent.selector);
        pool.transact(t, "", "");
        t = _tx();
        t.released = 1;
        vm.expectRevert(AuctionPool.ZeroAddress.selector);
        pool.transact(t, "", "");
        t = _tx();
        t.released = uint256(type(uint128).max) + 1;
        t.to = alice;
        vm.expectRevert(AuctionPool.BadAmount.selector);
        pool.transact(t, "", "");
        t = _tx();
        t.aspRoot = bytes32(uint256(5));
        vm.expectRevert(AuctionPool.UnknownAssociationRoot.selector);
        pool.transact(t, "", "");
        t = _tx();
        t.outputs[0] = bytes32(type(uint256).max);
        vm.expectRevert(AuctionPool.NotInField.selector);
        pool.transact(t, "", "");
        t = _tx();
        transactV.setAccept(false);
        vm.expectRevert(AuctionPool.InvalidProof.selector);
        pool.transact(t, "", "");
        transactV.setAccept(true);
        pool.transact(t, "", "");
        vm.expectRevert(AuctionPool.NoteSpent.selector);
        pool.transact(t, "", ""); // a nullifier spends once
    }

    function test_advance_tree_bounds_the_batch() public {
        vm.expectRevert(AuctionPool.BadCount.selector);
        pool.advanceTree(1, bytes32(uint256(5)), ""); // nothing queued
        _depositEth(alice, 1 ether);
        vm.expectRevert(AuctionPool.BadCount.selector);
        pool.advanceTree(0, bytes32(uint256(5)), "");
        vm.expectRevert(AuctionPool.BadCount.selector);
        pool.advanceTree(2, bytes32(uint256(5)), "");
        treeV.setAccept(false);
        vm.expectRevert(AuctionPool.InvalidProof.selector);
        pool.advanceTree(1, bytes32(uint256(5)), "");
        treeV.setAccept(true);
        pool.advanceTree(1, bytes32(uint256(5)), "");
        assertEq(pool.treeSize(), 1);
        assertEq(pool.root(), bytes32(uint256(5)));
        assertTrue(pool.knownRoot(bytes32(uint256(5))));
        assertEq(treeV.input(2), bytes32(uint256(77)));
    }

    function test_deposit_needs_the_exact_value_and_a_screened_sender() public {
        vm.deal(alice, 2 ether);
        vm.startPrank(alice);
        vm.expectRevert(AuctionPool.BadAmount.selector);
        pool.deposit{value: 1 ether}(address(0), 2 ether, bytes32(uint256(1)), "");
        vm.expectRevert(AuctionPool.BadAmount.selector);
        pool.deposit{value: 0}(address(0), 0, bytes32(uint256(1)), "");
        vm.stopPrank();
        ScreeningGate g = _gate(false);
        address[] memory blocked = new address[](1);
        blocked[0] = alice;
        g.setBlocked(blocked, true);
        vm.prank(alice);
        vm.expectRevert(AuctionPool.Blocked.selector);
        pool.deposit{value: 1 ether}(address(0), 1 ether, bytes32(uint256(1)), "");
        pool.setDepositFee(operator, 0.001 ether);
        address carol = makeAddr("carol");
        vm.deal(carol, 1 ether);
        vm.prank(carol);
        vm.expectRevert(AuctionPool.BadAmount.selector);
        pool.deposit{value: 1 ether}(address(0), 1 ether, bytes32(uint256(1)), ""); // the fee is on top
    }

    function test_place_order_rejects_bad_fees_roots_and_proofs() public {
        uint256 id = _schedule(600);
        AuctionPool.Placement memory p = _placement(bytes32(uint256(5)), 100);
        p.fee = 1; // relayed with no relayer
        vm.expectRevert(AuctionPool.ZeroAddress.selector);
        pool.placeOrder(id, p, "", "");
        p.relayer = alice;
        p.feeNullifier = p.nullifier;
        vm.expectRevert(AuctionPool.NoteSpent.selector);
        pool.placeOrder(id, p, "", "");
        p = _placement(bytes32(uint256(5)), 100);
        p.feeChange = bytes32(uint256(1)); // a fee change without a fee
        vm.expectRevert(AuctionPool.BadFee.selector);
        pool.placeOrder(id, p, "", "");
        p = _placement(bytes32(0), 100);
        vm.expectRevert(AuctionPool.BadCount.selector);
        pool.placeOrder(id, p, "", "");
        p = _placement(bytes32(uint256(5)), 100);
        p.root = bytes32(uint256(1));
        vm.expectRevert(AuctionPool.UnknownRoot.selector);
        pool.placeOrder(id, p, "", "");
        orderV.setAccept(false);
        vm.expectRevert(AuctionPool.InvalidProof.selector);
        _place(id, bytes32(uint256(5)), 100);
        vm.expectRevert(AuctionPool.BadAuction.selector);
        _place(id + 1, bytes32(uint256(5)), 100);
    }

    function test_reclaim_and_abandon_reject_bad_input() public {
        uint256 id = _schedule(600);
        _place(id, bytes32(uint256(5)), 100);
        pool.reclaim(id, 0, bytes32(uint256(55)), bytes32(uint256(56)), "");
        vm.expectRevert(AuctionPool.BadCount.selector);
        pool.reclaim(id, 0, bytes32(uint256(57)), bytes32(uint256(58)), ""); // the slot is empty
        _place(id, bytes32(uint256(6)), 102);
        reclaimV.setAccept(false);
        vm.expectRevert(AuctionPool.InvalidProof.selector);
        pool.reclaim(id, 0, bytes32(uint256(57)), bytes32(uint256(58)), "");
        vm.expectRevert(AuctionPool.TooEarly.selector);
        pool.abandon(id); // never pinned
        vm.warp(block.timestamp + 600);
        vm.prank(operator);
        tslaFeed.push(250e8);
        pool.pin(id);
        vm.expectRevert(AuctionPool.Voided.selector);
        pool.pin(id);
        clearV.setAccept(true);
        pool.settleAuction(id, _clearing(1, false), 0, "", "");
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(AuctionPool.AlreadySettled.selector);
        pool.abandon(id);
    }

    function test_rfq_desk_rejects_bad_delays_and_other_auctions() public {
        vm.expectRevert(RfqDesk.BadDelay.selector);
        desk.open(address(tsla), address(tq), 59);
        vm.expectRevert(RfqDesk.BadDelay.selector);
        desk.open(address(tsla), address(tq), 1 hours + 1);
        uint256 id = _schedule(600);
        bytes32[2] memory z;
        vm.expectRevert(RfqDesk.NotRfq.selector);
        desk.settle(id, z, z, 0, 0, "", "");
        uint256 rfq = desk.open(address(tsla), address(tq), 5 minutes);
        _place(rfq, bytes32(uint256(1)), 300);
        vm.expectRevert(AuctionPool.NotPinned.selector);
        desk.settle(rfq, z, z, 0, 0, "", "");
        vm.warp(block.timestamp + 5 minutes);
        vm.prank(operator);
        tslaFeed.push(250e8);
        pool.pin(rfq);
        bytes32[2] memory big = [bytes32(type(uint256).max), bytes32(0)];
        vm.expectRevert(RfqDesk.NotInField.selector);
        desk.settle(rfq, big, z, 0, 0, "", "");
        vm.expectRevert(RfqDesk.NotInField.selector);
        desk.settle(rfq, z, z, 0, type(uint256).max, "", "");
        rfqV.setAccept(false);
        vm.expectRevert(RfqDesk.InvalidProof.selector);
        desk.settle(rfq, z, z, 0, 0, "", "");
    }
}
