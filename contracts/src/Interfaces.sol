// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// The bb-generated UltraHonk verifiers (contracts/src/verifiers) all expose this.
interface IProofVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external returns (bool);
}

/// ScreeningGate
interface IScreeningGate {
    function allowed(address account) external view returns (bool);
    function associationRequired() external view returns (bool);
    function isAssociationRoot(bytes32 root) external view returns (bool);
}

/// Chainlink AggregatorV3 shape (8 decimals): MockAggregator, and TreasuryQuote for its NAV.
interface IPriceFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// PrintRegistry
interface IPrintRegistry {
    function record(uint256 auctionId, address asset, uint256 pStar, uint256 crossedQty) external;
}
