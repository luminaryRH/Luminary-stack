// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DisclosureRegistry} from "../src/DisclosureRegistry.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {LUMI} from "../src/LUMI.sol";
import {PrintRegistry} from "../src/PrintRegistry.sol";
import {ISanctionsList, ScreeningGate} from "../src/ScreeningGate.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";

contract SanctionsList is ISanctionsList {
    mapping(address => bool) public isSanctioned;

    function set(address a, bool s) external {
        isSanctioned[a] = s;
    }
}

/// FeeVault, ScreeningGate, LUMI, PrintRegistry and DisclosureRegistry: happy paths and every owner or invalid-input
/// rejection.
contract PeripheryTest is Test {
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address treasury = makeAddr("treasury");

    // --- FeeVault ---

    function test_vault_sends_everything_to_the_treasury_while_the_share_is_off() public {
        FeeVault v = new FeeVault(address(this), treasury);
        vm.deal(address(v), 1 ether);
        (uint256 toShare, uint256 toTreasury) = v.distribute(address(0));
        assertEq(toShare, 0);
        assertEq(toTreasury, 1 ether);
        assertEq(treasury.balance, 1 ether);
        (toShare, toTreasury) = v.distribute(address(0)); // nothing left
        assertEq(toShare + toTreasury, 0);
    }

    function test_vault_splits_a_token_by_the_share() public {
        FeeVault v = new FeeVault(address(this), treasury);
        MockUSDG usdg = new MockUSDG();
        usdg.mint(address(v), 1000e6);
        v.setShare(alice, 2500);
        v.distribute(address(usdg));
        assertEq(usdg.balanceOf(alice), 250e6);
        assertEq(usdg.balanceOf(treasury), 750e6);
    }

    function testFuzz_vault_split_conserves_the_balance(uint96 amount, uint16 shareBps) public {
        shareBps = uint16(bound(shareBps, 0, 5000));
        FeeVault v = new FeeVault(address(this), treasury);
        v.setShare(alice, shareBps);
        vm.deal(address(v), amount);
        (uint256 toShare, uint256 toTreasury) = v.distribute(address(0));
        assertEq(toShare + toTreasury, amount);
        assertEq(toShare, uint256(amount) * shareBps / 10_000);
        assertEq(address(v).balance, 0);
    }

    function test_vault_owner_powers_are_owner_only_and_bounded() public {
        vm.expectRevert(FeeVault.ZeroAddress.selector);
        new FeeVault(address(0), treasury);
        FeeVault v = new FeeVault(address(this), treasury);
        vm.startPrank(alice);
        vm.expectRevert(FeeVault.NotOwner.selector);
        v.setShare(alice, 100);
        vm.expectRevert(FeeVault.NotOwner.selector);
        v.setTreasury(alice);
        vm.expectRevert(FeeVault.NotOwner.selector);
        v.transferOwnership(alice);
        vm.stopPrank();
        vm.expectRevert(FeeVault.TooHigh.selector);
        v.setShare(alice, 5001);
        vm.expectRevert(FeeVault.ZeroAddress.selector);
        v.setShare(address(0), 100);
        vm.expectRevert(FeeVault.ZeroAddress.selector);
        v.setTreasury(address(0));
        v.transferOwnership(alice);
        vm.expectRevert(FeeVault.NotPendingOwner.selector);
        v.acceptOwnership();
        vm.prank(alice);
        v.acceptOwnership();
        assertEq(v.owner(), alice);
    }

    function test_vault_fails_loudly_when_a_payout_fails() public {
        FeeVault v = new FeeVault(address(this), address(new Rejecting()));
        vm.deal(address(v), 1 ether);
        vm.expectRevert(FeeVault.TransferFailed.selector);
        v.distribute(address(0));
    }

    // --- ScreeningGate ---

    function test_gate_blocks_and_consults_the_sanctions_list() public {
        ScreeningGate g = new ScreeningGate(address(this), address(this));
        assertTrue(g.allowed(alice));
        address[] memory list = new address[](1);
        list[0] = alice;
        g.setBlocked(list, true);
        assertFalse(g.allowed(alice));
        g.setBlocked(list, false);
        SanctionsList s = new SanctionsList();
        g.setSanctions(s);
        s.set(alice, true);
        assertFalse(g.allowed(alice));
        assertTrue(g.allowed(bob));
    }

    function test_gate_keeps_the_last_eight_roots() public {
        ScreeningGate g = new ScreeningGate(address(this), bob);
        assertEq(g.latestAssociationRoot(), bytes32(0));
        assertFalse(g.isAssociationRoot(0));
        for (uint256 i = 1; i <= 9; i++) {
            vm.prank(bob);
            g.postAssociationRoot(bytes32(i));
        }
        assertFalse(g.isAssociationRoot(bytes32(uint256(1))), "the oldest root fell out");
        assertTrue(g.isAssociationRoot(bytes32(uint256(2))));
        assertTrue(g.isAssociationRoot(bytes32(uint256(9))));
        assertEq(g.latestAssociationRoot(), bytes32(uint256(9)));
    }

    function test_gate_powers_are_restricted_and_bounded() public {
        vm.expectRevert(ScreeningGate.ZeroAddress.selector);
        new ScreeningGate(address(0), bob);
        ScreeningGate g = new ScreeningGate(address(this), bob);
        address[] memory list = new address[](1);
        vm.startPrank(alice);
        vm.expectRevert(ScreeningGate.NotPoster.selector);
        g.postAssociationRoot(bytes32(uint256(1)));
        vm.expectRevert(ScreeningGate.NotOwner.selector);
        g.setBlocked(list, true);
        vm.expectRevert(ScreeningGate.NotOwner.selector);
        g.setSanctions(ISanctionsList(alice));
        vm.expectRevert(ScreeningGate.NotOwner.selector);
        g.setPoster(alice);
        vm.expectRevert(ScreeningGate.NotOwner.selector);
        g.setAssociationRequired(true);
        vm.expectRevert(ScreeningGate.NotOwner.selector);
        g.transferOwnership(alice);
        vm.stopPrank();
        vm.startPrank(bob);
        vm.expectRevert(ScreeningGate.BadRoot.selector);
        g.postAssociationRoot(0);
        vm.expectRevert(ScreeningGate.BadRoot.selector);
        g.postAssociationRoot(bytes32(type(uint256).max));
        vm.stopPrank();
        g.setPoster(alice);
        vm.prank(alice);
        g.postAssociationRoot(bytes32(uint256(5)));
        g.transferOwnership(alice);
        vm.expectRevert(ScreeningGate.NotPendingOwner.selector);
        g.acceptOwnership();
        vm.prank(alice);
        g.acceptOwnership();
        assertEq(g.owner(), alice);
    }

    // --- LUMI ---

    function test_lumi_has_a_fixed_supply_and_moves_like_an_erc20() public {
        vm.expectRevert(LUMI.ZeroAddress.selector);
        new LUMI("Luminary", "LUMI", address(0), 1);
        LUMI t = new LUMI("Luminary", "LUMI", treasury, 1_000_000e18);
        assertEq(t.totalSupply(), 1_000_000e18);
        assertEq(t.balanceOf(treasury), 1_000_000e18);
        vm.prank(treasury);
        t.transfer(alice, 100e18);
        vm.prank(alice);
        t.approve(bob, 40e18);
        vm.prank(bob);
        t.transferFrom(alice, bob, 40e18);
        assertEq(t.balanceOf(bob), 40e18);
        assertEq(t.allowance(alice, bob), 0);
        vm.prank(bob);
        vm.expectRevert(LUMI.InsufficientAllowance.selector);
        t.transferFrom(alice, bob, 1);
        vm.prank(alice);
        vm.expectRevert(LUMI.InsufficientBalance.selector);
        t.transfer(bob, 61e18);
        vm.prank(alice);
        vm.expectRevert(LUMI.ZeroAddress.selector);
        t.transfer(address(0), 1);
        vm.prank(alice);
        t.approve(bob, type(uint256).max);
        vm.prank(bob);
        t.transferFrom(alice, bob, 10e18);
        assertEq(t.allowance(alice, bob), type(uint256).max, "an infinite allowance is never decreased");
    }

    function testFuzz_lumi_transfers_conserve_supply(uint256 a, uint256 b) public {
        LUMI t = new LUMI("Luminary", "LUMI", treasury, 1_000_000e18);
        a = bound(a, 0, 1_000_000e18);
        vm.prank(treasury);
        t.transfer(alice, a);
        b = bound(b, 0, a);
        vm.prank(alice);
        t.transfer(bob, b);
        assertEq(t.balanceOf(treasury) + t.balanceOf(alice) + t.balanceOf(bob), t.totalSupply());
    }

    // --- PrintRegistry, DisclosureRegistry ---

    function test_print_registry_writer_is_set_once_and_prints_once_per_auction() public {
        PrintRegistry r = new PrintRegistry();
        vm.prank(alice);
        vm.expectRevert(PrintRegistry.AlreadySet.selector);
        r.setWriter(alice);
        r.setWriter(address(this));
        vm.expectRevert(PrintRegistry.AlreadySet.selector);
        r.setWriter(alice);
        r.record(7, alice, 250e6, 3e6);
        vm.expectRevert(PrintRegistry.AlreadyPrinted.selector);
        r.record(7, alice, 250e6, 3e6);
        assertEq(r.printOf(7), 1);
        assertEq(r.get(0).pStar, 250e6);
    }

    function test_disclosure_needs_a_grant() public {
        DisclosureRegistry d = new DisclosureRegistry();
        vm.expectRevert(DisclosureRegistry.EmptyGrant.selector);
        d.disclose(bytes32(uint256(1)), "");
        vm.expectEmit(true, true, false, true);
        emit DisclosureRegistry.Disclosed(bytes32(uint256(1)), address(this), hex"aa");
        d.disclose(bytes32(uint256(1)), hex"aa");
    }
}

contract Rejecting {
    receive() external payable {
        revert();
    }
}
