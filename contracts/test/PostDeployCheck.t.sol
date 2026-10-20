// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {PostDeployCheck} from "../script/PostDeployCheck.s.sol";
import {AuctionPool} from "../src/AuctionPool.sol";
import {ScreeningGate} from "../src/ScreeningGate.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";
import {MockStock} from "./AuctionPool.t.sol";

/// Stands in for a Safe: its owners and threshold.
contract MockSafe {
    address[] internal owners;
    uint256 public getThreshold;

    constructor(address[] memory owners_, uint256 threshold) {
        owners = owners_;
        getThreshold = threshold;
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function execute(address to, bytes calldata data) external {
        (bool ok, bytes memory ret) = to.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}

/// Deploy.s.sol's own `deploy` (the mainnet tokens and feeds replaced by local stand-ins at the same addresses) passes
/// the post-deploy check, and planted misconfigurations fail it.
contract PostDeployCheckTest is Test {
    PostDeployCheck checker;
    Deploy deployer;
    Deploy.Deployed d;
    MockSafe safe;
    string json;
    address operator = makeAddr("operator");
    address[] signers;

    address[4] tokens = [0x322F0929c4625eD5bAd873c95208D54E1c003b2d, 0x12f190a9F9d7D37a250758b26824B97CE941bF54, 0x86923f96303D656E4aa86D9d42D1e57ad2023fdC, 0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A];
    address[4] feeds = [0x4A1166a659A55625345e9515b32adECea5547C38, 0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C, 0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72, 0x820ABedFF239034956B7A9d2F0a331f9F075eB4c];
    string[4] symbols = ["TSLA", "AMZN", "AMD", "PLTR"];
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant FEED_USDG = 0x61B7e5650328764B076A108EFF5fa7282a1B9aD2;

    function setUp() public {
        vm.warp(1_790_000_000);
        for (uint256 i; i < 4; i++) {
            deployCodeTo("AuctionPool.t.sol:MockStock", "", tokens[i]);
            deployCodeTo("MockAggregator.sol:MockAggregator", abi.encode("stock / USD", address(this), int256(100e8)), feeds[i]);
        }
        deployCodeTo("MockUSDG.sol:MockUSDG", "", USDG);
        deployCodeTo("MockAggregator.sol:MockAggregator", abi.encode("USDG / USD", address(this), int256(1e8)), FEED_USDG);
        signers = [makeAddr("signer1"), makeAddr("signer2"), makeAddr("signer3")];
        safe = new MockSafe(signers, 2);

        checker = new PostDeployCheck();
        deployer = new Deploy();
        Deploy.Config memory c;
        c.deployer = address(deployer);
        c.operator = operator;
        c.feeOwner = bytes32(uint256(1));
        c.safe = address(safe);
        d = deployer.deploy(c);

        string memory f;
        string memory t;
        for (uint256 i; i < 4; i++) {
            f = vm.serializeAddress("feeds", symbols[i], feeds[i]);
            t = vm.serializeAddress("tokens", symbols[i], tokens[i]);
        }
        f = vm.serializeAddress("feeds", "USDG", FEED_USDG);
        t = vm.serializeAddress("tokens", "USDG", USDG);
        vm.serializeAddress("d", "operator", operator);
        vm.serializeAddress("d", "deployer", address(deployer));
        vm.serializeBytes32("d", "feeOwner", c.feeOwner);
        vm.serializeAddress("d", "owner", address(d.timelock));
        vm.serializeAddress("d", "safe", address(safe));
        vm.serializeAddress("d", "safeSigners", signers);
        vm.serializeAddress("d", "AuctionPool", address(d.pool));
        vm.serializeAddress("d", "PrintRegistry", address(d.prints));
        vm.serializeAddress("d", "RfqDesk", address(d.desk));
        vm.serializeAddress("d", "ScreeningGate", address(d.gate));
        vm.serializeAddress("d", "DisclosureRegistry", address(d.disclosure));
        vm.serializeString("d", "feeds", f);
        json = vm.serializeString("d", "tokens", t);
    }

    function test_the_deploy_script_passes_the_check() public {
        checker.check(json);
        assertEq(d.pool.owner(), address(d.timelock));
        assertEq(d.timelock.getMinDelay(), 48 hours);
    }

    /// The owner powers now take 48 hours through the Safe: nobody else can queue them, and they wait out the delay.
    function test_owner_changes_go_through_the_safe_and_wait_48_hours() public {
        vm.prank(operator);
        vm.expectRevert(AuctionPool.NotOwner.selector);
        d.pool.setDepositsPaused(true);

        bytes memory call = abi.encodeCall(AuctionPool.setDepositsPaused, (true));
        bytes memory schedule = abi.encodeCall(TimelockController.schedule, (address(d.pool), 0, call, bytes32(0), bytes32(0), 48 hours));
        vm.expectRevert(); // the operator is not a proposer
        vm.prank(operator);
        d.timelock.schedule(address(d.pool), 0, call, bytes32(0), bytes32(0), 48 hours);
        vm.expectRevert(); // shorter than the delay
        safe.execute(address(d.timelock), abi.encodeCall(TimelockController.schedule, (address(d.pool), 0, call, bytes32(0), bytes32(0), 1 hours)));

        safe.execute(address(d.timelock), schedule);
        bytes memory execute = abi.encodeCall(TimelockController.execute, (address(d.pool), 0, call, bytes32(0), bytes32(0)));
        vm.expectRevert(); // not ready yet
        safe.execute(address(d.timelock), execute);
        vm.warp(block.timestamp + 48 hours);
        safe.execute(address(d.timelock), execute);
        assertTrue(d.pool.depositsPaused());
    }

    function test_a_paused_pool_fails() public {
        vm.prank(address(d.timelock));
        d.pool.setDepositsPaused(true);
        vm.expectRevert(bytes("post-deploy check FAILED: 1 problem(s)"));
        checker.check(json);
    }

    function test_a_pending_owner_and_a_dropped_scheduler_fail() public {
        vm.startPrank(address(d.timelock));
        d.pool.transferOwnership(makeAddr("stranger"));
        d.pool.setScheduler(operator, false);
        d.gate.setPoster(makeAddr("stranger"));
        vm.stopPrank();
        vm.expectRevert(bytes("post-deploy check FAILED: 3 problem(s)"));
        checker.check(json);
    }

    function test_a_shorter_delay_or_a_kept_deployer_role_fails() public {
        vm.startPrank(address(d.timelock));
        d.timelock.updateDelay(1 hours);
        d.timelock.grantRole(d.timelock.PROPOSER_ROLE(), address(deployer));
        vm.stopPrank();
        vm.expectRevert(bytes("post-deploy check FAILED: 2 problem(s)"));
        checker.check(json);
    }

    function test_a_stale_limit_or_delisted_market_fails() public {
        vm.startPrank(address(d.timelock));
        d.pool.setMarket(tokens[0], feeds[0], 1e12, false, 500, 25 hours); // delisted
        d.pool.setMarket(USDG, FEED_USDG, 1, false, 0, 1 hours); // a 24-hour-heartbeat feed under a 1-hour limit
        vm.stopPrank();
        vm.expectRevert(bytes("post-deploy check FAILED: 2 problem(s)"));
        checker.check(json);
    }

    function test_association_not_required_fails() public {
        vm.prank(address(d.timelock));
        d.gate.setAssociationRequired(false);
        vm.expectRevert(bytes("post-deploy check FAILED: 1 problem(s)"));
        checker.check(json);
    }

    function test_wrong_fee_settings_a_lowered_lock_or_a_blocked_operator_fail() public {
        vm.startPrank(address(d.timelock));
        d.pool.setFee(bytes32(uint256(2)), 5); // fee notes to another key
        d.pool.setDepositFee(makeAddr("stranger"), 1); // paid to someone other than the operator
        d.pool.setMinLock(tokens[0], 1); // below Deploy.s.sol's
        address[] memory who = new address[](1);
        who[0] = operator;
        d.gate.setBlocked(who, true);
        vm.stopPrank();
        vm.expectRevert(bytes("post-deploy check FAILED: 4 problem(s)"));
        checker.check(json);
    }

    function test_a_missing_guardian_fails() public {
        vm.prank(address(d.timelock));
        d.pool.setGuardian(address(0));
        vm.expectRevert(bytes("post-deploy check FAILED: 1 problem(s)"));
        checker.check(json);
    }

    /// The verifiers' linked libraries hold verification logic: other code at a linked address fails the check.
    function test_a_swapped_verifier_library_fails() public {
        bytes memory code = address(d.pool.depositVerifier()).code;
        string memory art = vm.readFile(string.concat(vm.projectRoot(), "/out/DepositVerifier.sol/HonkVerifier.json"));
        string[] memory files = vm.parseJsonKeys(art, ".deployedBytecode.linkReferences");
        string[] memory libs = vm.parseJsonKeys(art, string.concat(".deployedBytecode.linkReferences['", files[0], "']"));
        uint256 start = vm.parseJsonUint(art, string.concat(".deployedBytecode.linkReferences['", files[0], "'].", libs[0], "[0].start"));
        uint160 lib;
        for (uint256 k; k < 20; k++) lib = (lib << 8) | uint160(uint8(code[start + k]));
        vm.etch(address(lib), address(d.gate).code);
        vm.expectRevert();
        checker.check(json);
    }

    function test_other_bytecode_at_a_manifest_address_fails() public {
        vm.etch(vm.parseJsonAddress(json, ".DisclosureRegistry"), address(d.gate).code);
        vm.expectRevert();
        checker.check(json);
    }
}
