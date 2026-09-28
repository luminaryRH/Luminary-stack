// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "./ERC20.sol";

/// @title MockUSDG
/// @notice Testnet dollar (6 decimals). Anyone may mint up to FAUCET per call; the minter (TreasuryQuote, which backs
/// its NAV growth with it) has no cap.
contract MockUSDG is ERC20 {
    uint256 public constant FAUCET = 10_000e6;

    address public immutable deployer;
    address public minter;

    error TooMuch();
    error NotDeployer();

    constructor() ERC20("Mock USDG", "USDG", 6) {
        deployer = msg.sender;
    }

    /// Set once, by the deployer.
    function setMinter(address minter_) external {
        if (msg.sender != deployer || minter != address(0)) revert NotDeployer();
        minter = minter_;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter && amount > FAUCET) revert TooMuch();
        _mint(to, amount);
    }
}
