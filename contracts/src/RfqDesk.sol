// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AuctionPool} from "./AuctionPool.sol";
import {IProofVerifier} from "./Interfaces.sol";

/// @title RfqDesk
/// @notice Two-party sealed blocks between auctions. Two parties agree a block off chain (src/shielded/rfq.ts), one opens
/// an RFQ auction here, both place their orders into it through AuctionPool.placeOrder (each order carries the block's
/// rfq commitment), and after its call time the pool pins the reference. RfqCrossProof then shows the pair crosses whole
/// at the reference (opposite sides, same size, inside both limits, fully locked) or that both locks are refunded. The
/// print is (reference, block size): the block's volume is public once settled, its parties are not.
/// ponytail: anyone can place into an open RFQ auction; a stranger's order only makes the cross fail and both sides get
/// refunded. Gate placement by a per-block key if that griefing shows up.
contract RfqDesk {
    uint256 internal constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 public constant MIN_DELAY = 1 minutes;
    uint256 public constant MAX_DELAY = 1 hours;

    AuctionPool public immutable pool;
    IProofVerifier public immutable rfqVerifier;

    event BlockOpened(uint256 indexed id, address indexed asset, address quote, uint256 callTime);

    error BadDelay();
    error NotRfq();
    error InvalidProof();
    error NotInField();

    constructor(AuctionPool pool_, IProofVerifier rfqVerifier_) {
        pool = pool_;
        rfqVerifier = rfqVerifier_;
    }

    /// @notice Open an RFQ auction of `asset` against `quote`, called after `delay` seconds. Permissionless.
    function open(address asset, address quote, uint256 delay) external returns (uint256 id) {
        if (delay < MIN_DELAY || delay > MAX_DELAY) revert BadDelay();
        uint64 callTime = uint64(block.timestamp + delay);
        id = pool.schedule(asset, quote, AuctionPool.Kind.RFQ, callTime);
        emit BlockOpened(id, asset, quote, callTime);
    }

    /// @notice Settle a pinned RFQ auction. Permissionless; `notes` carries the outputs encrypted to their owners.
    function settle(uint256 id, bytes32[2] calldata fills, bytes32[2] calldata residuals, bytes32 feeNote, uint256 crossedQty, bytes calldata proof, bytes calldata notes)
        external
    {
        uint256 n = _verify(id, fills, residuals, feeNote, crossedQty, proof);
        // the pool checks the auction is pinned and unsettled, and queues only the outputs of non-empty slots
        bytes32[] memory f = new bytes32[](n);
        bytes32[] memory r = new bytes32[](n);
        for (uint256 i; i < n; i++) {
            f[i] = fills[i];
            r[i] = residuals[i];
        }
        pool.settleFromDesk(id, f, r, feeNote, crossedQty, notes);
    }

    /// Checks the RfqCrossProof against the auction's pinned state; returns its order count.
    function _verify(uint256 id, bytes32[2] calldata fills, bytes32[2] calldata residuals, bytes32 feeNote, uint256 crossedQty, bytes calldata proof)
        private
        returns (uint256)
    {
        AuctionPool.Auction memory a = pool.auctions(id);
        if (a.kind != AuctionPool.Kind.RFQ) revert NotRfq();
        bytes32[] memory list = pool.orderList(id);
        bytes32[] memory inputs = _inputs(a, list, crossedQty);
        for (uint256 i; i < 2; i++) {
            inputs[10 + i] = fills[i];
            inputs[12 + i] = residuals[i];
        }
        inputs[15] = feeNote;
        for (uint256 i; i < inputs.length; i++) {
            if (uint256(inputs[i]) >= FIELD) revert NotInField();
        }
        if (!rfqVerifier.verify(proof, inputs)) revert InvalidProof();
        return list.length;
    }

    /// rfq_cross public inputs, in circuit order (outputs and fee note filled in by the caller).
    function _inputs(AuctionPool.Auction memory a, bytes32[] memory list, uint256 crossedQty) private view returns (bytes32[] memory inputs) {
        (, uint88 unit,,) = pool.markets(a.asset);
        (, uint88 quoteUnit,,) = pool.markets(a.quote);
        inputs = new bytes32[](16);
        inputs[0] = bytes32(uint256(uint160(a.asset)));
        inputs[1] = bytes32(uint256(unit));
        inputs[2] = bytes32(uint256(uint160(a.quote)));
        inputs[3] = bytes32(uint256(quoteUnit));
        inputs[4] = bytes32(uint256(a.refUsd));
        inputs[5] = bytes32(uint256(a.quoteUsd));
        inputs[6] = bytes32(uint256(a.feeBps));
        inputs[7] = bytes32(crossedQty);
        for (uint256 i; i < list.length; i++) {
            inputs[8 + i] = list[i];
        }
        inputs[14] = pool.feeOwner();
    }
}
