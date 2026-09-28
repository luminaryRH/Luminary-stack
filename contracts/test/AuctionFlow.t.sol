// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AuctionPool} from "../src/AuctionPool.sol";
import {PrintRegistry} from "../src/PrintRegistry.sol";
import {IPrintRegistry, IProofVerifier} from "../src/Interfaces.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {TreasuryQuote} from "../src/mocks/TreasuryQuote.sol";
import {MockStock} from "./AuctionPool.t.sol";
// Every bb-generated verifier is named HonkVerifier; aliases keep them apart.
import {HonkVerifier as DepositHonk} from "../src/verifiers/DepositVerifier.sol";
import {HonkVerifier as TreeUpdateHonk} from "../src/verifiers/TreeUpdateVerifier.sol";
import {HonkVerifier as TransactHonk} from "../src/verifiers/TransactVerifier.sol";
import {HonkVerifier as OrderValidityHonk} from "../src/verifiers/OrderValidityVerifier.sol";
import {HonkVerifier as AuctionClearHonk} from "../src/verifiers/AuctionClearVerifier.sol";
import {HonkVerifier as ReclaimHonk} from "../src/verifiers/ReclaimVerifier.sol";

/// The whole auction path against the real verifiers, with the proofs from `bun circuits/tests/auction.fixture.ts`
/// (skipped when they are absent): deposit, append, place three orders, pin at $250, settle at p* = $245 with the
/// AuctionClearProof, append the outputs, withdraw a fill, cancel the rolled remainder.
contract AuctionFlowTest is Test {
    string constant DIR = "../circuits/target/fixtures/";
    address constant POOL = 0x00000000000000000000000000000000000A0C71;
    address constant TSLA = 0x000000000000000000000000000000000000c9F9;
    address constant TQ = 0x0000000000000000000000000000000000007e7E;
    address constant DEPOSITOR = 0x000000000000000000000000000000000000d0D0;
    address constant TO = 0x000000000000000000000000000000000000a11c;

    AuctionPool pool;
    PrintRegistry registry;
    MockAggregator tslaFeed;
    MockUSDG usdg;
    string fx;

    function setUp() public {
        if (!vm.exists(string.concat(DIR, "flow.json"))) return;
        fx = vm.readFile(string.concat(DIR, "flow.json"));
        vm.warp(1_790_000_000);
        registry = new PrintRegistry();
        AuctionPool.Verifiers memory v = AuctionPool.Verifiers(
            IProofVerifier(address(new DepositHonk())),
            IProofVerifier(address(new TreeUpdateHonk())),
            IProofVerifier(address(new TransactHonk())),
            IProofVerifier(address(new OrderValidityHonk())),
            IProofVerifier(address(new AuctionClearHonk())),
            IProofVerifier(address(new ReclaimHonk()))
        );
        deployCodeTo("AuctionPool.sol:AuctionPool", abi.encode(address(this), v, address(registry), vm.parseJsonBytes32(fx, ".feeOwner"), uint16(5)), POOL);
        pool = AuctionPool(payable(POOL));
        registry.setWriter(POOL);
        pool.setScheduler(address(this), true);

        usdg = new MockUSDG();
        deployCodeTo("TreasuryQuote.sol:TreasuryQuote", abi.encode(address(usdg), address(this)), TQ);
        usdg.setMinter(TQ);
        deployCodeTo("AuctionPool.t.sol:MockStock", "", TSLA);
        tslaFeed = new MockAggregator("TSLA / USD", address(this), 250e8);
        pool.setMarket(TSLA, address(tslaFeed), 1e12, true, 500);
        pool.setMarket(TQ, TQ, 1, true, 100);
    }

    function _proof(string memory name) internal view returns (bytes memory) {
        return vm.readFileBinary(string.concat(DIR, name, "/proof"));
    }

    function _b32(string memory key) internal view returns (bytes32) {
        return vm.parseJsonBytes32(fx, key);
    }

    function _deposits() internal {
        vm.startPrank(DEPOSITOR);
        usdg.mint(DEPOSITOR, 1000e6);
        usdg.approve(TQ, 1000e6);
        TreasuryQuote(TQ).deposit(1000e6, DEPOSITOR);
        TreasuryQuote(TQ).approve(POOL, type(uint256).max);
        MockStock(TSLA).mint(DEPOSITOR, 7e18);
        MockStock(TSLA).approve(POOL, type(uint256).max);
        for (uint256 i; i < 3; i++) {
            string memory k = string.concat(".deposits[", vm.toString(i), "]");
            address asset = address(uint160(uint256(_b32(string.concat(k, ".asset")))));
            uint256 amount = uint256(_b32(string.concat(k, ".amount")));
            pool.deposit(asset, amount, _b32(string.concat(k, ".commitment")), _proof(string.concat("flow_deposit_", vm.toString(i))));
        }
        vm.stopPrank();
        pool.advanceTree(3, _b32(".root1"), _proof("flow_advance1"));
    }

    function _placeAll() internal {
        for (uint256 i; i < 3; i++) {
            string memory k = string.concat(".placements[", vm.toString(i), "]");
            AuctionPool.Placement memory p;
            p.root = _b32(string.concat(k, ".root"));
            p.nullifier = _b32(string.concat(k, ".spent"));
            p.change = _b32(string.concat(k, ".change"));
            p.commitment = _b32(string.concat(k, ".commitment"));
            pool.placeOrder(0, p, _proof(string.concat("flow_order_", vm.toString(i))), "");
        }
    }

    function _clearing() internal view returns (AuctionPool.Clearing memory c) {
        c.pStar = uint256(_b32(".pStar"));
        c.crossedQty = uint256(_b32(".crossedQty"));
        bytes32[] memory fills = vm.parseJsonBytes32Array(fx, ".fills");
        bytes32[] memory residuals = vm.parseJsonBytes32Array(fx, ".residuals");
        bool[] memory rolls = vm.parseJsonBoolArray(fx, ".rolls");
        for (uint256 i; i < 64; i++) {
            c.fills[i] = fills[i];
            c.residuals[i] = residuals[i];
            c.rolls[i] = rolls[i];
        }
        c.feeNote = _b32(".feeNote");
    }

    function _pinned() internal {
        _deposits();
        pool.schedule(TSLA, TQ, AuctionPool.Kind.CLOSE, uint64(block.timestamp + 600)); // 0
        pool.schedule(TSLA, TQ, AuctionPool.Kind.OPEN, uint64(block.timestamp + 3600)); // 1: where rolled orders rest
        _placeAll();
        vm.warp(block.timestamp + 600);
        tslaFeed.push(250e8);
        pool.pin(0);
    }

    function test_full_auction_flow_with_real_proofs() public {
        if (bytes(fx).length == 0) vm.skip(true);
        _pinned();

        uint256 gas = gasleft();
        pool.settleAuction(0, _clearing(), 1, _proof("flow_settle"), "");
        emit log_named_uint("settleAuction gas", gas - gasleft());
        PrintRegistry.Print memory p = registry.get(0);
        assertEq(p.pStar, 245e6);
        assertEq(p.crossedQty, 3e6);
        assertEq(pool.orderList(1).length, 1, "the $245 seller's remainder rolled");

        pool.advanceTree(uint256(_b32(".advance2Count")), _b32(".root2"), _proof("flow_advance2"));

        AuctionPool.Transaction memory t;
        t.root = _b32(".root2");
        t.nullifiers = [_b32(".withdrawal.nullifier0"), _b32(".withdrawal.nullifier1")];
        t.outputs = [_b32(".withdrawal.output0"), _b32(".withdrawal.output1")];
        t.asset = TQ;
        t.released = uint256(_b32(".payout"));
        t.to = TO;
        pool.transact(t, _proof("flow_withdraw"), "");
        assertEq(TreasuryQuote(TQ).balanceOf(TO), 489_755_000, "2 TSLA at $245 less 5 bps");

        pool.reclaim(1, 0, _b32(".cancel.spent"), _b32(".cancel.refund"), _proof("flow_cancel"));
        assertEq(pool.auctions(1).live, 0);
        assertEq(pool.openOrders(TSLA), 0);
    }

    function test_a_different_p_star_is_rejected() public {
        if (bytes(fx).length == 0) vm.skip(true);
        _pinned();
        AuctionPool.Clearing memory c = _clearing();
        c.pStar = 255e6; // the other volume-maximizing price loses the tie-break
        vm.expectRevert();
        pool.settleAuction(0, c, 1, _proof("flow_settle"), "");
    }

    function test_a_different_reference_is_rejected() public {
        if (bytes(fx).length == 0) vm.skip(true);
        _deposits();
        pool.schedule(TSLA, TQ, AuctionPool.Kind.CLOSE, uint64(block.timestamp + 600));
        pool.schedule(TSLA, TQ, AuctionPool.Kind.OPEN, uint64(block.timestamp + 3600));
        _placeAll();
        vm.warp(block.timestamp + 600);
        tslaFeed.push(251e8); // the proof was made for a $250 reference
        pool.pin(0);
        vm.expectRevert();
        pool.settleAuction(0, _clearing(), 1, _proof("flow_settle"), "");
    }
}
