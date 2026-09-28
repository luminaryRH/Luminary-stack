// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title MockAggregator
/// @notice Testnet price feed in the Chainlink AggregatorV3 shape (8 decimals). Robinhood Chain testnet has no Chainlink
/// feeds, so the nav-watcher mirrors the mainnet feed into this one. Every push is a new round.
contract MockAggregator {
    struct Round {
        int256 answer;
        uint64 updatedAt;
    }

    uint8 public constant decimals = 8;
    string public description;
    address public owner;
    address public pusher;
    uint80 public latestRound;
    mapping(uint80 round => Round) internal rounds;

    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);
    event PusherSet(address pusher);

    error NotPusher();
    error NotOwner();
    error BadAnswer();
    error NoRound();

    constructor(string memory description_, address pusher_, int256 initial) {
        description = description_;
        owner = msg.sender;
        pusher = pusher_;
        if (initial != 0) _push(initial);
    }

    function push(int256 answer) external {
        if (msg.sender != pusher && msg.sender != owner) revert NotPusher();
        _push(answer);
    }

    function setPusher(address pusher_) external {
        if (msg.sender != owner) revert NotOwner();
        pusher = pusher_;
        emit PusherSet(pusher_);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return getRoundData(latestRound);
    }

    function getRoundData(uint80 round) public view returns (uint80, int256, uint256, uint256, uint80) {
        Round memory r = rounds[round];
        if (r.updatedAt == 0) revert NoRound();
        return (round, r.answer, r.updatedAt, r.updatedAt, round);
    }

    function _push(int256 answer) private {
        if (answer <= 0) revert BadAnswer();
        uint80 round = latestRound + 1;
        rounds[round] = Round(answer, uint64(block.timestamp));
        latestRound = round;
        emit AnswerUpdated(answer, round, block.timestamp);
    }
}
