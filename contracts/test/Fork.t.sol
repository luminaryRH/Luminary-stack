// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {PostDeployCheck} from "../script/PostDeployCheck.s.sol";
import {AuctionPool} from "../src/AuctionPool.sol";
import {IPriceFeed, IPrintRegistry} from "../src/Interfaces.sol";
import {PrintRegistry} from "../src/PrintRegistry.sol";
import {RecordingVerifier} from "./AuctionPool.t.sol";

interface IStock {
    function uiMultiplier() external view returns (uint256);
    function paused() external view returns (bool);
    function decimals() external view returns (uint8);
}

/// Against Robinhood Chain mainnet (4663): the real stock tokens and USDG, the real Chainlink feeds, the real Safe
/// factory. Runs when FORK_RPC_URL is set (CI sets it to the public mainnet RPC); skipped otherwise.
contract ForkTest is Test {
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address constant FEED_TSLA = 0x4A1166a659A55625345e9515b32adECea5547C38;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant FEED_USDG = 0x61B7e5650328764B076A108EFF5fa7282a1B9aD2;
    address[4] stocks = [TSLA, 0x12f190a9F9d7D37a250758b26824B97CE941bF54, 0x86923f96303D656E4aa86D9d42D1e57ad2023fdC, 0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A];

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
    }

    function test_the_live_tokens_are_one_share_per_token_and_unpaused() public {
        if (block.chainid != 4663) vm.skip(true);
        for (uint256 i; i < stocks.length; i++) {
            IStock s = IStock(stocks[i]);
            assertEq(s.decimals(), 18, "the market unit assumes 18 decimals");
            assertEq(s.uiMultiplier(), 1e18);
            assertFalse(s.paused());
        }
        assertEq(IStock(USDG).decimals(), 6);
    }

    /// The pin reads the real feeds: it pins at the Chainlink answer when each round is inside its market's limit
    /// (25 hours: the feeds' 24-hour heartbeat) and voids otherwise (stock feeds pause over the weekend). An issuer pause
    /// voids.
    function test_an_auction_of_the_live_token_pins_at_the_chainlink_price() public {
        if (block.chainid != 4663) vm.skip(true);
        RecordingVerifier v = new RecordingVerifier();
        PrintRegistry registry = new PrintRegistry();
        AuctionPool pool = new AuctionPool(address(this), AuctionPool.Verifiers(v, v, v, v, v, v), IPrintRegistry(address(registry)), bytes32(uint256(1)), 5);
        registry.setWriter(address(pool));
        pool.setScheduler(address(this), true);
        pool.setMarket(TSLA, FEED_TSLA, 1e12, true, 500, 25 hours);
        pool.setMarket(USDG, FEED_USDG, 1, false, 0, 25 hours);

        uint256 a = pool.schedule(TSLA, USDG, AuctionPool.Kind.CLOSE, uint64(block.timestamp + 1));
        uint256 b = pool.schedule(TSLA, USDG, AuctionPool.Kind.CLOSE, uint64(block.timestamp + 1));
        for (uint256 id = a; id <= b; id++) {
            AuctionPool.Placement memory p;
            p.root = pool.EMPTY_ROOT();
            p.nullifier = bytes32(100 + id);
            p.change = bytes32(200 + id);
            p.commitment = bytes32(300 + id);
            pool.placeOrder(id, p, "", "");
        }
        vm.warp(block.timestamp + 1);
        (, int256 ref,, uint256 refAt,) = IPriceFeed(FEED_TSLA).latestRoundData();
        (, int256 quote,, uint256 quoteAt,) = IPriceFeed(FEED_USDG).latestRoundData();
        bool fresh = block.timestamp - refAt <= 25 hours && block.timestamp - quoteAt <= 25 hours;
        pool.pin(a);
        assertEq(pool.auctions(a).voided, !fresh, "pins exactly when both rounds are inside their limits");
        if (fresh) {
            assertEq(pool.auctions(a).refUsd, uint256(ref) / 100);
            assertEq(pool.auctions(a).quoteUsd, uint256(quote) / 100);
        }

        vm.mockCall(TSLA, abi.encodeWithSignature("paused()"), abi.encode(true));
        pool.pin(b);
        assertTrue(pool.auctions(b).voided, "an issuer pause voids");
    }

    /// Deploy.s.sol end to end on a fork: the real Safe factory makes the 2-of-3 Safe, the timelock takes ownership,
    /// and the post-deploy check passes against the manifest it writes.
    function test_the_deploy_script_passes_the_post_deploy_check_on_mainnet() public {
        if (block.chainid != 4663) vm.skip(true);
        Deploy deployer = new Deploy();
        PostDeployCheck checker = new PostDeployCheck();
        Deploy.Config memory c;
        c.deployer = address(deployer);
        c.operator = makeAddr("operator");
        c.feeOwner = bytes32(uint256(1));
        c.signers = new address[](3);
        c.signers[0] = makeAddr("signer1");
        c.signers[1] = makeAddr("signer2");
        c.signers[2] = makeAddr("signer3");
        Deploy.Deployed memory d = deployer.deploy(c);
        checker.check(deployer.manifest(c, d, block.number));
        assertEq(d.pool.owner(), address(d.timelock));
    }
}
