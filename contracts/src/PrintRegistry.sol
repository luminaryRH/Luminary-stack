// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title PrintRegistry
/// @notice Append-only public tape of auction results. AuctionPool writes one print per settled auction in the same
/// transaction that settles it: the clearing price and the crossed volume, never an order.
contract PrintRegistry {
    struct Print {
        uint64 auctionId;
        address asset;
        uint128 pStar; // micro-USD per share
        uint128 crossedQty; // share micro-units
        uint64 timestamp;
    }

    address public immutable deployer;
    address public writer; // AuctionPool, set once

    Print[] internal prints;
    mapping(uint256 auctionId => uint256) public printOf; // index + 1; 0 = none

    event Printed(uint256 indexed auctionId, address indexed asset, uint256 pStar, uint256 crossedQty, uint256 index);

    error NotWriter();
    error AlreadySet();
    error AlreadyPrinted();

    constructor() {
        deployer = msg.sender;
    }

    function setWriter(address writer_) external {
        if (msg.sender != deployer || writer != address(0)) revert AlreadySet();
        writer = writer_;
    }

    function record(uint256 auctionId, address asset, uint256 pStar, uint256 crossedQty) external {
        if (msg.sender != writer) revert NotWriter();
        if (printOf[auctionId] != 0) revert AlreadyPrinted();
        prints.push(Print(uint64(auctionId), asset, uint128(pStar), uint128(crossedQty), uint64(block.timestamp)));
        printOf[auctionId] = prints.length;
        emit Printed(auctionId, asset, pStar, crossedQty, prints.length - 1);
    }

    function count() external view returns (uint256) {
        return prints.length;
    }

    function get(uint256 index) external view returns (Print memory) {
        return prints[index];
    }
}
