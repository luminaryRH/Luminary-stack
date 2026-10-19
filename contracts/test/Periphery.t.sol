// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DisclosureRegistry} from "../src/DisclosureRegistry.sol";
import {PrintRegistry} from "../src/PrintRegistry.sol";
import {ISanctionsList, ScreeningGate} from "../src/ScreeningGate.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";

contract SanctionsList is ISanctionsList {
    mapping(address => bool) public isSanctioned;

    function set(address a, bool s) external {
        isSanctioned[a] = s;
    }
}

/// ScreeningGate, PrintRegistry and DisclosureRegistry: happy paths and every owner or invalid-input
/// rejection.
contract PeripheryTest is Test {
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address treasury = makeAddr("treasury");

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
