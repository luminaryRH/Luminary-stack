// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AuctionPool} from "../src/AuctionPool.sol";
import {RfqDesk} from "../src/RfqDesk.sol";
import {PrintRegistry} from "../src/PrintRegistry.sol";
import {IPrintRegistry, IProofVerifier} from "../src/Interfaces.sol";
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
        assertEq(orderV.count(), 12);
        assertEq(orderV.input(5), bytes32(uint256(uint160(address(tsla)))));
        assertEq(orderV.input(6), bytes32(uint256(1e12)));
        assertEq(orderV.input(7), bytes32(uint256(uint160(address(tq)))));
        assertEq(orderV.input(8), bytes32(uint256(1)));
        assertEq(orderV.input(11), pool.placementContext(id, address(0), 0));
        assertTrue(pool.placementContext(id, address(0), 0) != pool.placementContext(id + 1, address(0), 0));
        assertEq(pool.openOrders(address(tsla)), 1);
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

    function test_open_orders_are_capped_per_asset() public {
        uint256 a = _schedule(600);
        uint256 b = _schedule(1200);
        for (uint256 i; i < 64; i++) {
            _place(i % 2 == 0 ? a : b, bytes32(i + 1), 1000 + 2 * i);
        }
        vm.expectRevert(AuctionPool.AuctionFull.selector);
        _place(b, bytes32(uint256(99)), 5000);
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
        assertEq(pool.openOrders(address(tsla)), 0);
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
        assertEq(pool.openOrders(address(tsla)), 0);
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
        assertEq(clearV.count(), 12 + 4 * 64);
        assertEq(clearV.input(0), bytes32(uint256(uint160(address(tsla)))));
        assertEq(clearV.input(4), bytes32(uint256(250e6))); // ref
        assertEq(clearV.input(5), bytes32(uint256(500))); // cap
        assertEq(clearV.input(6), bytes32(uint256(1e6))); // quote price
        assertEq(clearV.input(7), bytes32(uint256(5))); // fee bps
        assertEq(clearV.input(8), bytes32(uint256(251e6))); // p*
        assertEq(clearV.input(10), bytes32(uint256(1))); // first order
        assertEq(clearV.input(12), bytes32(0)); // empty slot
        assertEq(clearV.input(10 + 4 * 64), FEE_OWNER);
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
        assertEq(pool.openOrders(address(tsla)), 1);
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
        assertEq(pool.openOrders(address(tsla)), 0);
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
        assertEq(pool.openOrders(address(tsla)), 0);
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
        desk.settle(id, fills, refunds, bytes32(uint256(31)), 1e6, "", "");
        assertEq(rfqV.input(4), bytes32(uint256(252e6)));
        assertEq(rfqV.input(8), bytes32(uint256(1)));
        assertEq(rfqV.input(14), FEE_OWNER);
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
}
