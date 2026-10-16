// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PostDeployCheck} from "../script/PostDeployCheck.s.sol";
import {AuctionPool} from "../src/AuctionPool.sol";
import {DisclosureRegistry} from "../src/DisclosureRegistry.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {IPrintRegistry, IProofVerifier, IScreeningGate} from "../src/Interfaces.sol";
import {LUMI} from "../src/LUMI.sol";
import {PrintRegistry} from "../src/PrintRegistry.sol";
import {RfqDesk} from "../src/RfqDesk.sol";
import {ScreeningGate} from "../src/ScreeningGate.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";
import {HonkVerifier as DepositHonk} from "../src/verifiers/DepositVerifier.sol";
import {HonkVerifier as TreeUpdateHonk} from "../src/verifiers/TreeUpdateVerifier.sol";
import {HonkVerifier as TransactHonk} from "../src/verifiers/TransactVerifier.sol";
import {HonkVerifier as OrderValidityHonk} from "../src/verifiers/OrderValidityVerifier.sol";
import {HonkVerifier as AuctionClearHonk} from "../src/verifiers/AuctionClearVerifier.sol";
import {HonkVerifier as ReclaimHonk} from "../src/verifiers/ReclaimVerifier.sol";
import {HonkVerifier as RfqCrossHonk} from "../src/verifiers/RfqCrossVerifier.sol";

/// The post-deploy check passes a deployment wired like Deploy.s.sol and reports planted misconfigurations.
contract PostDeployCheckTest is Test {
    PostDeployCheck checker;
    AuctionPool pool;
    ScreeningGate gate;
    string json;
    address operator = makeAddr("operator");
    string[5] symbols = ["TSLA", "AMZN", "AMD", "PLTR", "NFLX"];

    function setUp() public {
        checker = new PostDeployCheck();
        vm.startPrank(operator);
        AuctionPool.Verifiers memory v = AuctionPool.Verifiers(
            IProofVerifier(address(new DepositHonk())),
            IProofVerifier(address(new TreeUpdateHonk())),
            IProofVerifier(address(new TransactHonk())),
            IProofVerifier(address(new OrderValidityHonk())),
            IProofVerifier(address(new AuctionClearHonk())),
            IProofVerifier(address(new ReclaimHonk()))
        );
        PrintRegistry prints = new PrintRegistry();
        pool = new AuctionPool(operator, v, IPrintRegistry(address(prints)), bytes32(uint256(1)), 5);
        prints.setWriter(address(pool));
        RfqDesk desk = new RfqDesk(pool, IProofVerifier(address(new RfqCrossHonk())));
        pool.setDesk(address(desk));
        pool.setScheduler(operator, true);
        gate = new ScreeningGate(operator, operator);
        pool.setGate(IScreeningGate(address(gate)));
        FeeVault vault = new FeeVault(operator, operator);
        LUMI lumi = new LUMI("Luminary", "LUMI", operator, 1e27);
        DisclosureRegistry disclosure = new DisclosureRegistry();

        address usdg = address(new MockAggregator("token", operator, 1)); // any contract stands in for a token
        MockAggregator usdgFeed = new MockAggregator("USDG / USD", operator, 1e8);
        pool.setMarket(usdg, address(usdgFeed), 1, false, 0);
        pool.setMinLock(usdg, 25e6);
        vm.serializeAddress("feeds", "USDG", address(usdgFeed));
        string memory feeds;
        string memory tokens;
        for (uint256 i; i < 5; i++) {
            address token = address(uint160(0x5000 + i));
            MockAggregator feed = new MockAggregator("stock", operator, 100e8);
            pool.setMarket(token, address(feed), 1e12, true, 500);
            pool.setMinLock(token, 50_000);
            feeds = vm.serializeAddress("feeds", symbols[i], address(feed));
            tokens = vm.serializeAddress("tokens", symbols[i], token);
        }
        tokens = vm.serializeAddress("tokens", "USDG", usdg);
        vm.stopPrank();

        vm.serializeAddress("d", "operator", operator);
        vm.serializeAddress("d", "AuctionPool", address(pool));
        vm.serializeAddress("d", "PrintRegistry", address(prints));
        vm.serializeAddress("d", "RfqDesk", address(desk));
        vm.serializeAddress("d", "ScreeningGate", address(gate));
        vm.serializeAddress("d", "DisclosureRegistry", address(disclosure));
        vm.serializeAddress("d", "FeeVault", address(vault));
        vm.serializeAddress("d", "LUMI", address(lumi));
        vm.serializeString("d", "feeds", feeds);
        json = vm.serializeString("d", "tokens", tokens);
    }

    function test_a_correct_deployment_passes() public {
        checker.check(json);
    }

    function test_a_paused_pool_fails() public {
        vm.prank(operator);
        pool.setDepositsPaused(true);
        vm.expectRevert(bytes("post-deploy check FAILED: 1 problem(s)"));
        checker.check(json);
    }

    function test_a_pending_owner_and_a_dropped_scheduler_fail() public {
        vm.startPrank(operator);
        pool.transferOwnership(makeAddr("stranger"));
        pool.setScheduler(operator, false);
        gate.setPoster(makeAddr("stranger"));
        vm.stopPrank();
        vm.expectRevert(bytes("post-deploy check FAILED: 3 problem(s)"));
        checker.check(json);
    }

    function test_a_delisted_market_fails() public {
        address token = vm.parseJsonAddress(json, ".tokens.TSLA");
        address feed = vm.parseJsonAddress(json, ".feeds.TSLA");
        vm.prank(operator);
        pool.setMarket(token, feed, 1e12, false, 500);
        vm.expectRevert(bytes("post-deploy check FAILED: 1 problem(s)"));
        checker.check(json);
    }

    function test_other_bytecode_at_a_manifest_address_fails() public {
        vm.etch(vm.parseJsonAddress(json, ".FeeVault"), address(gate).code);
        vm.expectRevert();
        checker.check(json);
    }
}
