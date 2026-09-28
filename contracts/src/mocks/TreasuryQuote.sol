// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "./ERC20.sol";
import {MockUSDG} from "./MockUSDG.sol";

/// @title TreasuryQuote
/// @notice Testnet "treasury quote": an ERC-4626 vault over MockUSDG whose NAV per share only rises. Orders lock these
/// shares as quote collateral, so they keep accruing while they rest. The nav-watcher raises the NAV at a set APY and
/// mints the MockUSDG that backs the increase. It also reads as an AggregatorV3 feed of its NAV, which the auction pool
/// pins as the quote price and as the reference of NAV auctions.
contract TreasuryQuote is ERC20 {
    uint256 internal constant ONE = 1e6; // one share, and $1 in micro-USD
    uint256 public constant MAX_STEP_BPS = 100; // one raise moves NAV by at most 1%

    MockUSDG public immutable asset;
    address public owner;
    address public keeper;
    uint256 public nav = ONE; // micro-USDG per share

    event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares);
    event NavRaised(uint256 nav);
    event KeeperSet(address keeper);

    error NotKeeper();
    error NotOwner();
    error BadNav();
    error Zero();

    constructor(MockUSDG asset_, address keeper_) ERC20("Luminary Treasury Quote", "TQ", 6) {
        asset = asset_;
        owner = msg.sender;
        keeper = keeper_;
    }

    function totalAssets() external view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return assets * ONE / nav;
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return shares * nav / ONE;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        shares = convertToShares(assets);
        if (shares == 0) revert Zero();
        _pull(assets);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function redeem(uint256 shares, address receiver, address holder) external returns (uint256 assets) {
        if (msg.sender != holder) _spendAllowance(holder, shares);
        assets = convertToAssets(shares);
        if (assets == 0) revert Zero();
        _burn(holder, shares);
        _push(receiver, assets);
        emit Withdraw(msg.sender, receiver, holder, assets, shares);
    }

    /// Raise NAV per share and mint the MockUSDG that backs it.
    function raiseNav(uint256 newNav) external {
        if (msg.sender != keeper && msg.sender != owner) revert NotKeeper();
        if (newNav <= nav || newNav > nav * (10_000 + MAX_STEP_BPS) / 10_000) revert BadNav();
        uint256 backing = totalSupply * newNav / ONE;
        uint256 held = asset.balanceOf(address(this));
        if (backing > held) asset.mint(address(this), backing - held);
        nav = newNav;
        emit NavRaised(newNav);
    }

    function setKeeper(address keeper_) external {
        if (msg.sender != owner) revert NotOwner();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    /// NAV as an 8-decimal USD price (MockUSDG = $1), always current.
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, int256(nav * 100), block.timestamp, block.timestamp, 1);
    }

    function _pull(uint256 amount) private {
        if (!asset.transferFrom(msg.sender, address(this), amount)) revert Zero();
    }

    function _push(address to, uint256 amount) private {
        if (!asset.transfer(to, amount)) revert Zero();
    }
}
