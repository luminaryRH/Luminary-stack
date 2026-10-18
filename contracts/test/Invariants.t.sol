// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {AuctionPool} from "../src/AuctionPool.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {PrintRegistry} from "../src/PrintRegistry.sol";
import {IPrintRegistry} from "../src/Interfaces.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";
import {MockStock, RecordingVerifier} from "./AuctionPool.t.sol";

/// Drives AuctionPool through random sequences of deposits, withdrawals, double-spend attempts, scheduling, placing
/// (self-submitted and relayed), cancelling, pinning, settling (with rolls and left-out slots), abandoning and
/// reclaiming. Proofs are accepted (the circuits carry the value rules); what the pool itself must keep is checked
/// in AuctionPoolInvariants below.
contract PoolHandler is CommonBase, StdUtils {
    bytes32 constant EMPTY_ROOT = 0x01da7c268b18dfc969f3ae497fff3fef7909905d6bd3d40b212d1d1544e1be88;
    uint256 constant MAX_AUCTIONS = 12;

    AuctionPool public pool;
    MockAggregator tslaFeed;
    MockAggregator usdgFeed;
    address tsla;
    address usdg;
    address operator;
    address[3] actors = [address(0xA11CE), address(0xB0B), address(0xCA401)];

    // ghost state
    uint256 public deposited; // ETH in
    uint256 public paidOut; // ETH out: releases, transact fees, order relayer fees
    uint256 public queued; // commitments the pool should have queued
    uint256 public settled; // settled auctions (each prints once)
    bool public doubleSpent;
    uint256 nonce = 1000;
    bytes32[] spentNullifiers;
    mapping(uint256 id => mapping(uint256 slot => bool)) reclaimed;

    constructor(AuctionPool pool_, address tsla_, address usdg_, MockAggregator tslaFeed_, MockAggregator usdgFeed_, address operator_) {
        pool = pool_;
        tsla = tsla_;
        usdg = usdg_;
        tslaFeed = tslaFeed_;
        usdgFeed = usdgFeed_;
        operator = operator_;
    }

    function _next() internal returns (bytes32) {
        return bytes32(++nonce);
    }

    function _auction(uint256 seed) internal view returns (bool ok, uint256 id, AuctionPool.Auction memory a) {
        uint256 n = pool.auctionCount();
        if (n == 0) return (false, 0, a);
        id = seed % n;
        a = pool.auctions(id);
        ok = true;
    }

    function deposit(uint256 actorSeed, uint256 amount) external {
        amount = bound(amount, 1, 100 ether);
        address a = actors[actorSeed % actors.length];
        vm.deal(a, amount);
        vm.prank(a);
        pool.deposit{value: amount}(address(0), amount, _next(), "");
        deposited += amount;
        queued += 1;
    }

    function withdraw(uint256 releasedSeed, uint256 feeSeed) external {
        uint256 balance = address(pool).balance;
        uint256 released = bound(releasedSeed, 0, balance);
        uint256 fee = bound(feeSeed, 0, balance - released);
        AuctionPool.Transaction memory t;
        t.root = EMPTY_ROOT;
        t.nullifiers = [_next(), _next()];
        t.outputs = [_next(), _next()];
        t.released = released;
        t.fee = fee;
        t.to = actors[0];
        t.relayer = actors[1];
        pool.transact(t, "", "");
        spentNullifiers.push(t.nullifiers[0]);
        paidOut += released + fee;
        queued += 2;
    }

    function replaySpentNote(uint256 seed) external {
        if (spentNullifiers.length == 0) return;
        AuctionPool.Transaction memory t;
        t.root = EMPTY_ROOT;
        t.nullifiers = [spentNullifiers[seed % spentNullifiers.length], _next()];
        t.outputs = [_next(), _next()];
        try pool.transact(t, "", "") {
            doubleSpent = true;
        } catch {}
    }

    function schedule(uint256 delaySeed) external {
        if (pool.auctionCount() >= MAX_AUCTIONS) return;
        vm.prank(operator);
        pool.schedule(tsla, usdg, AuctionPool.Kind.CLOSE, uint64(block.timestamp + bound(delaySeed, 60, 2 hours)));
    }

    function place(uint256 seed, bool relayed) external {
        (bool ok, uint256 id, AuctionPool.Auction memory a) = _auction(seed);
        if (!ok || block.timestamp >= a.callTime || a.voided || a.live >= pool.ORDERS()) return;
        AuctionPool.Placement memory p;
        p.root = EMPTY_ROOT;
        p.nullifier = _next();
        p.change = _next();
        p.commitment = _next();
        relayed = relayed && address(pool).balance >= 1e15;
        if (relayed) {
            p.fee = 1e15;
            p.relayer = actors[2];
            p.feeNullifier = _next();
            p.feeChange = _next();
        }
        pool.placeOrder(id, p, "", "sealed");
        spentNullifiers.push(p.nullifier);
        paidOut += p.fee;
        queued += relayed ? 2 : 1;
    }

    function cancel(uint256 seed, uint256 slotSeed) external {
        (bool ok, uint256 id, AuctionPool.Auction memory a) = _auction(seed);
        if (!ok || a.callBlock != 0 || a.voided || block.timestamp >= a.callTime) return;
        bytes32[] memory list = pool.orderList(id);
        if (list.length == 0) return;
        uint256 slot = slotSeed % list.length;
        if (list[slot] == 0) return;
        pool.reclaim(id, slot, _next(), _next(), "");
        queued += 1;
    }

    function warp(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1, 90 minutes));
    }

    function pin(uint256 seed) external {
        (bool ok, uint256 id, AuctionPool.Auction memory a) = _auction(seed);
        if (!ok || block.timestamp < a.callTime || a.callBlock != 0 || a.voided) return;
        vm.startPrank(operator);
        tslaFeed.push(250e8);
        usdgFeed.push(1e8);
        vm.stopPrank();
        pool.pin(id);
    }

    function settle(uint256 seed, uint64 excluded, bool roll, uint256 targetSeed) external {
        (bool ok, uint256 id, AuctionPool.Auction memory a) = _auction(seed);
        if (!ok || a.callBlock == 0 || a.settled || a.voided) return;
        uint256 target = targetSeed % pool.auctionCount();
        AuctionPool.Auction memory t = pool.auctions(target);
        roll = roll && target != id && !t.voided && t.callBlock == 0 && block.timestamp < t.callTime;
        bytes32[] memory list = pool.orderList(id);
        AuctionPool.Clearing memory c;
        c.pStar = 250e6;
        c.feeNote = _next();
        c.excluded = excluded;
        c.roll = roll;
        uint256 rolled;
        uint256 outputs = 1; // the fee note
        for (uint256 i; i < list.length; i++) {
            if (list[i] == 0 || (excluded >> i) & 1 == 1) continue;
            c.fills[i] = _next();
            c.residuals[i] = _next();
            outputs += 1;
            if (roll && i % 2 == 0 && t.live + rolled < pool.ORDERS()) {
                c.rolls[i] = true;
                rolled++;
            } else {
                outputs += 1;
            }
        }
        vm.prank(operator);
        pool.settleAuction(id, c, target, "", "");
        queued += outputs;
        settled += 1;
    }

    function abandon(uint256 seed) external {
        (bool ok, uint256 id, AuctionPool.Auction memory a) = _auction(seed);
        if (!ok || a.callBlock == 0 || a.settled || a.voided || block.timestamp < a.pinnedAt + pool.SETTLE_DEADLINE()) return;
        pool.abandon(id);
    }

    function reclaimLeftOrVoided(uint256 seed, uint256 slotSeed) external {
        (bool ok, uint256 id, AuctionPool.Auction memory a) = _auction(seed);
        if (!ok) return;
        bytes32[] memory list = pool.orderList(id);
        if (list.length == 0) return;
        uint256 slot = slotSeed % list.length;
        bool leftOut = a.settled && (pool.excludedSlots(id) >> slot) & 1 == 1;
        if (list[slot] == 0 || reclaimed[id][slot] || !(a.voided || leftOut)) return;
        reclaimed[id][slot] = true; // the real ReclaimProof ties the order nullifier to the order: once per order
        pool.reclaim(id, slot, _next(), _next(), "");
        queued += 1;
    }
}

contract AuctionPoolInvariants is Test {
    AuctionPool pool;
    PrintRegistry registry;
    PoolHandler handler;

    function setUp() public {
        vm.warp(1_790_000_000);
        address operator = makeAddr("operator");
        RecordingVerifier v = new RecordingVerifier();
        registry = new PrintRegistry();
        pool = new AuctionPool(address(this), AuctionPool.Verifiers(v, v, v, v, v, v), IPrintRegistry(address(registry)), bytes32(uint256(424242)), 5);
        registry.setWriter(address(pool));
        pool.setScheduler(operator, true);
        MockStock tsla = new MockStock();
        MockStock usdg = new MockStock();
        MockAggregator tslaFeed = new MockAggregator("TSLA / USD", operator, 250e8);
        MockAggregator usdgFeed = new MockAggregator("USDG / USD", operator, 1e8);
        pool.setMarket(address(tsla), address(tslaFeed), 1e12, true, 500);
        pool.setMarket(address(usdg), address(usdgFeed), 1, false, 0);
        handler = new PoolHandler(pool, address(tsla), address(usdg), tslaFeed, usdgFeed, operator);
        targetContract(address(handler));
    }

    /// Solvency: the pool holds exactly the ETH that came in minus what left (releases and relayer fees).
    function invariant_eth_is_conserved() public view {
        assertEq(address(pool).balance, handler.deposited() - handler.paidOut());
    }

    /// Every deposit, output, change, refund, fill and fee note is queued exactly once, in order.
    function invariant_every_note_is_queued_once() public view {
        assertEq(pool.commitmentCount(), handler.queued());
        assertLe(pool.treeSize(), pool.commitmentCount());
    }

    /// A nullifier spends once.
    function invariant_no_double_spend() public view {
        assertFalse(handler.doubleSpent());
    }

    /// Auctions: never both settled and voided; at most ORDERS slots (RFQ: 2); while unsettled, `live` is exactly the
    /// occupied slots (a cancel frees one); a settled auction holds nothing live; one print per settled auction.
    function invariant_auction_slots_are_consistent() public view {
        uint256 n = pool.auctionCount();
        for (uint256 id; id < n; id++) {
            AuctionPool.Auction memory a = pool.auctions(id);
            assertFalse(a.settled && a.voided);
            bytes32[] memory list = pool.orderList(id);
            assertLe(list.length, pool.ORDERS());
            uint256 occupied;
            for (uint256 i; i < list.length; i++) {
                if (list[i] != 0) occupied++;
            }
            if (a.settled) assertEq(a.live, 0);
            else assertEq(a.live, occupied);
            if (a.callBlock == 0) assertEq(pool.excludedSlots(id), 0);
        }
        assertEq(registry.count(), handler.settled());
    }
}

/// Drives FeeVault through random fee inflows (ETH and a token), share changes and distributions.
contract VaultHandler is CommonBase, StdUtils {
    FeeVault public vault;
    MockStock public token;
    address public treasury;
    address public share = address(0x5A4E);
    address public owner;
    uint256 public ethIn;
    uint256 public tokenIn;

    constructor(FeeVault vault_, MockStock token_, address treasury_, address owner_) {
        vault = vault_;
        token = token_;
        treasury = treasury_;
        owner = owner_;
    }

    function feeEth(uint256 amount) external {
        amount = bound(amount, 0, 100 ether);
        vm.deal(address(this), amount);
        (bool ok,) = address(vault).call{value: amount}("");
        require(ok);
        ethIn += amount;
    }

    function feeToken(uint256 amount) external {
        amount = bound(amount, 0, 1e30);
        token.mint(address(vault), amount);
        tokenIn += amount;
    }

    function setShare(uint256 bps) external {
        vm.prank(owner);
        vault.setShare(share, uint16(bound(bps, 0, vault.MAX_SHARE_BPS())));
    }

    function distribute(bool eth) external {
        vault.distribute(eth ? address(0) : address(token));
    }
}

contract FeeVaultInvariants is Test {
    FeeVault vault;
    MockStock token;
    VaultHandler handler;
    address treasury = makeAddr("treasury");

    function setUp() public {
        vault = new FeeVault(address(this), treasury);
        token = new MockStock();
        handler = new VaultHandler(vault, token, treasury, address(this));
        vault.transferOwnership(address(handler));
        vm.prank(address(handler));
        vault.acceptOwnership();
        targetContract(address(handler));
    }

    /// Conservation: every fee that came in sits in the vault or was paid to the treasury or the share recipient.
    function invariant_fees_are_conserved() public view {
        assertEq(address(vault).balance + treasury.balance + handler.share().balance, handler.ethIn());
        assertEq(token.balanceOf(address(vault)) + token.balanceOf(treasury) + token.balanceOf(handler.share()), handler.tokenIn());
    }

    /// The share recipient never gets more than MAX_SHARE_BPS of what was distributed.
    function invariant_share_is_bounded() public view {
        uint256 paidEth = treasury.balance + handler.share().balance;
        assertLe(handler.share().balance * 10_000, paidEth * vault.MAX_SHARE_BPS());
    }
}
