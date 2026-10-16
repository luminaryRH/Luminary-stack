// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// The bb-generated UltraHonk verifiers (contracts/src/verifiers) all expose this.
interface IProofVerifier {
    /// True when `proof` proves the circuit with these public inputs (bb verifiers revert on malformed proofs).
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external returns (bool);
}

/// ScreeningGate
interface IScreeningGate {
    /// Whether `account` may deposit.
    function allowed(address account) external view returns (bool);
    /// Whether value leaving the pool must prove an association root.
    function associationRequired() external view returns (bool);
    /// Whether `root` is a current association root.
    function isAssociationRoot(bytes32 root) external view returns (bool);
}

/// Chainlink AggregatorV3 shape (8 decimals): MockAggregator, and TreasuryQuote for its NAV.
interface IPriceFeed {
    /// (roundId, answer, startedAt, updatedAt, answeredInRound); answer has 8 decimals.
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// PrintRegistry
interface IPrintRegistry {
    /// Append the print of a settled auction (AuctionPool only).
    function record(uint256 auctionId, address asset, uint256 pStar, uint256 crossedQty) external;
}
