// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title FeeVault
/// @notice Collects venue fees. Settlement fees are notes owned by the fee key; the operator withdraws them from the
/// pool to this vault. `distribute` splits a token (or ETH, token 0) between the LUMI fee-share recipient and the
/// treasury; the share is off until the owner turns it on.
contract FeeVault {
    uint16 public constant MAX_SHARE_BPS = 5000;

    address public owner;
    address public pendingOwner;
    address public treasury;
    address public shareRecipient; // 0 while the fee share is off
    uint16 public shareBps;

    bool private transient entered;

    event Distributed(address indexed token, uint256 toShare, uint256 toTreasury);
    event ShareSet(address recipient, uint16 shareBps);
    event TreasurySet(address treasury);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();
    error TooHigh();
    error TransferFailed();
    error Reentrancy();

    constructor(address owner_, address treasury_) {
        if (owner_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        owner = owner_;
        treasury = treasury_;
        emit OwnershipTransferred(address(0), owner_);
        emit TreasurySet(treasury_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    receive() external payable {}

    /// @notice Splits the vault's whole balance of `token` (0 = ETH). Permissionless.
    function distribute(address token) external nonReentrant returns (uint256 toShare, uint256 toTreasury) {
        uint256 balance = token == address(0) ? address(this).balance : _balanceOf(token);
        if (balance == 0) return (0, 0);
        toShare = shareRecipient == address(0) ? 0 : balance * shareBps / 10_000;
        toTreasury = balance - toShare;
        if (toShare != 0) _pay(token, shareRecipient, toShare);
        if (toTreasury != 0) _pay(token, treasury, toTreasury);
        emit Distributed(token, toShare, toTreasury);
    }

    function setShare(address recipient, uint16 shareBps_) external onlyOwner {
        if (shareBps_ > MAX_SHARE_BPS) revert TooHigh();
        if (shareBps_ != 0 && recipient == address(0)) revert ZeroAddress();
        shareRecipient = recipient;
        shareBps = shareBps_;
        emit ShareSet(recipient, shareBps_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function _pay(address token, address to, uint256 amount) private {
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
            return;
        }
        (bool ok2, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount)); // transfer
        if (!ok2 || (ret.length != 0 && (ret.length < 32 || !abi.decode(ret, (bool))))) revert TransferFailed();
    }

    function _balanceOf(address token) private view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this))); // balanceOf
        if (!ok || ret.length < 32) revert TransferFailed();
        return abi.decode(ret, (uint256));
    }
}
