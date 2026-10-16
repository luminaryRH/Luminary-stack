// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AuctionPool} from "../src/AuctionPool.sol";
import {PrintRegistry} from "../src/PrintRegistry.sol";
import {IPrintRegistry} from "../src/Interfaces.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";
import {RecordingVerifier} from "./AuctionPool.t.sol";

interface IStock {
    function uiMultiplier() external view returns (uint256);
    function paused() external view returns (bool);
    function decimals() external view returns (uint8);
}

/// Against the real Robinhood Chain testnet stock token (a beacon proxy to the issuer's Stock / ERC20ScaledUI
/// implementation): the pool reads its issuer controls the way the pin expects. Runs when FORK_RPC_URL is set
/// (CI sets it to the public testnet RPC); skipped otherwise.
contract ForkTest is Test {
    address constant TSLA = 0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
    }

    function test_the_live_stock_token_is_one_share_per_token_and_unpaused() public {
        if (block.chainid != 46630) vm.skip(true);
        IStock s = IStock(TSLA);
        assertEq(s.decimals(), 18, "the market unit assumes 18 decimals");
        assertEq(s.uiMultiplier(), 1e18);
        assertFalse(s.paused());
    }

    function test_an_auction_of_the_live_token_pins_and_an_issuer_pause_voids_it() public {
        if (block.chainid != 46630) vm.skip(true);
        RecordingVerifier v = new RecordingVerifier();
        PrintRegistry registry = new PrintRegistry();
        AuctionPool pool = new AuctionPool(address(this), AuctionPool.Verifiers(v, v, v, v, v, v), IPrintRegistry(address(registry)), bytes32(uint256(1)), 5);
        registry.setWriter(address(pool));
        pool.setScheduler(address(this), true);
        MockAggregator feed = new MockAggregator("TSLA / USD", address(this), 250e8);
        MockAggregator quoteFeed = new MockAggregator("Q / USD", address(this), 1e8);
        address quote = address(new RecordingVerifier()); // any contract stands in for the quote token (never moved here)
        pool.setMarket(TSLA, address(feed), 1e12, true, 500);
        pool.setMarket(quote, address(quoteFeed), 1, false, 0);

        uint256 a = pool.schedule(TSLA, quote, AuctionPool.Kind.CLOSE, uint64(block.timestamp + 600));
        uint256 b = pool.schedule(TSLA, quote, AuctionPool.Kind.CLOSE, uint64(block.timestamp + 600));
        for (uint256 id = a; id <= b; id++) {
            AuctionPool.Placement memory p;
            p.root = pool.EMPTY_ROOT();
            p.nullifier = bytes32(100 + id);
            p.change = bytes32(200 + id);
            p.commitment = bytes32(300 + id);
            pool.placeOrder(id, p, "", "");
        }
        vm.warp(block.timestamp + 600);
        feed.push(250e8);
        quoteFeed.push(1e8);
        pool.pin(a);
        assertFalse(pool.auctions(a).voided, "the real token reads as tradable");
        assertEq(pool.auctions(a).refUsd, 250e6);

        // the issuer pauses the token: the next pin voids
        vm.mockCall(TSLA, abi.encodeWithSignature("paused()"), abi.encode(true));
        pool.pin(b);
        assertTrue(pool.auctions(b).voided);
    }
}
