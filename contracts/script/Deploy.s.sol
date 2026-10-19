// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {AuctionPool} from "../src/AuctionPool.sol";
import {DisclosureRegistry} from "../src/DisclosureRegistry.sol";
import {IPrintRegistry, IProofVerifier, IScreeningGate} from "../src/Interfaces.sol";
import {PrintRegistry} from "../src/PrintRegistry.sol";
import {RfqDesk} from "../src/RfqDesk.sol";
import {ScreeningGate} from "../src/ScreeningGate.sol";
// Every bb-generated verifier is named HonkVerifier; aliases keep them apart.
import {HonkVerifier as DepositHonk} from "../src/verifiers/DepositVerifier.sol";
import {HonkVerifier as TreeUpdateHonk} from "../src/verifiers/TreeUpdateVerifier.sol";
import {HonkVerifier as TransactHonk} from "../src/verifiers/TransactVerifier.sol";
import {HonkVerifier as OrderValidityHonk} from "../src/verifiers/OrderValidityVerifier.sol";
import {HonkVerifier as AuctionClearHonk} from "../src/verifiers/AuctionClearVerifier.sol";
import {HonkVerifier as ReclaimHonk} from "../src/verifiers/ReclaimVerifier.sol";
import {HonkVerifier as RfqCrossHonk} from "../src/verifiers/RfqCrossVerifier.sol";

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce) external returns (address proxy);
}

/// Arbitrum's ArbSys precompile: on an Orbit chain block.number is the parent chain's block, arbBlockNumber the L2's.
interface IArbSys {
    function arbBlockNumber() external view returns (uint256);
}

interface ISafeOwners {
    function getOwners() external view returns (address[] memory);
}

/// @title Deploy
/// @notice Deploys Luminary to Robinhood Chain mainnet (4663) and hands every owner power to a 48-hour timelock that a
/// Safe controls. Writes every address to deployments/4663.json. From contracts/:
///   forge script script/Deploy.s.sol --rpc-url robinhood --broadcast --slow
/// Environment:
///   DEPLOYER_PRIVATE_KEY   fresh key; it pays the gas and holds no role or ownership afterwards
///   OPERATOR_ADDRESS       hot operator: AuctionPool scheduler and ScreeningGate poster, nothing else
///   FEE_OWNER              owner key of settlement fee notes (ownerPub of the fee secret)
///   SAFE_SIGNERS           comma-separated owners of the new 2-of-N Safe (or SAFE: an existing Safe to use instead)
///   DEPOSIT_FEE_WEI        optional ETH fee per deposit, paid to the operator for appending it (default 0)
/// Steps: (1) the Safe (official v1.4.1 SafeL2 through the official factory), (2) a TimelockController with no delay
/// and the deployer as its temporary proposer, executor and admin, (3) the contracts with the deployer as owner,
/// (4) wiring, markets and the Safe as guardian (it can pause deposits or halt a market at once), (5) ownership of the pool and the gate moved to the timelock and accepted through it, the
/// delay raised to 48 hours through it, the Safe made its only proposer, canceller and executor, and every role of
/// the deployer renounced. PostDeployCheck.s.sol verifies all of it against the chain.
contract Deploy is Script {
    // Robinhood Chain mainnet stock tokens (Robinhood's StockFactory 0x4783C67b…C046), 18 decimals, and their Chainlink
    // USD feeds (8 decimals, 0.5% deviation, 24 h heartbeat). NFLX has no Chainlink feed on 4663, so it is not listed.
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address constant AMZN = 0x12f190a9F9d7D37a250758b26824B97CE941bF54;
    address constant AMD = 0x86923f96303D656E4aa86D9d42D1e57ad2023fdC;
    address constant PLTR = 0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A;
    address constant FEED_TSLA = 0x4A1166a659A55625345e9515b32adECea5547C38;
    address constant FEED_AMZN = 0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C;
    address constant FEED_AMD = 0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72;
    address constant FEED_PLTR = 0x820ABedFF239034956B7A9d2F0a331f9F075eB4c;
    // Paxos USDG (6 decimals), the quote token, and its Chainlink USD feed (24 h heartbeat)
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant FEED_USDG = 0x61B7e5650328764B076A108EFF5fa7282a1B9aD2;
    address constant FEED_ETH = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9; // dashboard marks only
    // Safe v1.4.1 on 4663
    address constant SAFE_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant SAFE_L2_SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address constant SAFE_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;

    uint88 constant STOCK_UNIT = 1e12; // 18 decimals → micro-units
    uint16 constant STOCK_CAP_BPS = 500;
    // Every feed used here updates on a 0.5% move and at least every 24 hours (Chainlink: threshold 0.5, heartbeat
    // 86400; stock feeds on us_equities_24/5 hours), so a round inside its heartbeat is within 0.5% of the market
    uint32 constant STOCK_MAX_AGE = 25 hours;
    uint32 constant QUOTE_MAX_AGE = 25 hours;
    uint16 constant FEE_BPS = 5;
    // smallest order lock, so holding an auction's 64 slots costs real capital: 0.05 share, or 25 USDG
    uint256 constant STOCK_MIN_LOCK = 50_000;
    uint256 constant QUOTE_MIN_LOCK = 25e6;
    uint256 constant TIMELOCK_DELAY = 48 hours;
    uint256 constant SAFE_THRESHOLD = 2;

    struct Config {
        address deployer;
        address operator;
        bytes32 feeOwner;
        address safe; // 0: create one owned by `signers`
        address[] signers;
        uint256 depositFee;
    }

    struct Deployed {
        address safe;
        TimelockController timelock;
        AuctionPool pool;
        PrintRegistry prints;
        RfqDesk desk;
        ScreeningGate gate;
        DisclosureRegistry disclosure;
    }

    address[4] stocks = [TSLA, AMZN, AMD, PLTR];
    address[4] stockFeeds = [FEED_TSLA, FEED_AMZN, FEED_AMD, FEED_PLTR];
    string[4] symbols = ["TSLA", "AMZN", "AMD", "PLTR"];

    function run() external {
        require(block.chainid == 4663, "Deploy.s.sol is for Robinhood Chain mainnet (4663)");
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        Config memory c;
        c.deployer = vm.addr(key);
        c.operator = vm.envAddress("OPERATOR_ADDRESS");
        c.feeOwner = vm.envBytes32("FEE_OWNER");
        c.safe = vm.envOr("SAFE", address(0));
        if (c.safe == address(0)) c.signers = vm.envAddress("SAFE_SIGNERS", ",");
        c.depositFee = vm.envOr("DEPOSIT_FEE_WEI", uint256(0));
        uint256 deployBlock = IArbSys(address(100)).arbBlockNumber(); // the L2 block the indexer starts from
        vm.startBroadcast(key);
        Deployed memory d = deploy(c);
        vm.stopBroadcast();
        vm.writeJson(manifest(c, d, deployBlock), string.concat("deployments/", vm.toString(block.chainid), ".json"));
        console.log("AuctionPool", address(d.pool));
        console.log("Timelock", address(d.timelock));
        console.log("Safe", d.safe);
    }

    /// Everything after the key. Under broadcast every call comes from the deployer; a test calls it on a Deploy instance,
    /// which then plays the deployer (pass its address as `c.deployer`).
    function deploy(Config memory c) public returns (Deployed memory d) {
        require(c.operator != address(0) && c.operator != c.deployer, "operator must be its own address");
        d.safe = c.safe != address(0) ? c.safe : _createSafe(c.signers);

        address[] memory me = new address[](1);
        me[0] = c.deployer;
        d.timelock = new TimelockController(0, me, me, c.deployer);

        AuctionPool.Verifiers memory v = AuctionPool.Verifiers(
            IProofVerifier(address(new DepositHonk())),
            IProofVerifier(address(new TreeUpdateHonk())),
            IProofVerifier(address(new TransactHonk())),
            IProofVerifier(address(new OrderValidityHonk())),
            IProofVerifier(address(new AuctionClearHonk())),
            IProofVerifier(address(new ReclaimHonk()))
        );
        d.prints = new PrintRegistry();
        d.pool = new AuctionPool(c.deployer, v, IPrintRegistry(address(d.prints)), c.feeOwner, FEE_BPS);
        d.prints.setWriter(address(d.pool));
        d.desk = new RfqDesk(d.pool, IProofVerifier(address(new RfqCrossHonk())));
        d.pool.setDesk(address(d.desk));
        d.pool.setScheduler(c.operator, true);
        d.gate = new ScreeningGate(c.deployer, c.operator);
        d.gate.setAssociationRequired(true); // withdrawals prove their deposit is in the screened set
        d.pool.setGate(IScreeningGate(address(d.gate)));
        d.disclosure = new DisclosureRegistry();
        if (c.depositFee != 0) d.pool.setDepositFee(c.operator, c.depositFee);

        for (uint256 i; i < stocks.length; i++) {
            d.pool.setMarket(stocks[i], stockFeeds[i], STOCK_UNIT, true, STOCK_CAP_BPS, STOCK_MAX_AGE);
            d.pool.setMinLock(stocks[i], STOCK_MIN_LOCK);
        }
        d.pool.setMarket(USDG, FEED_USDG, 1, false, 0, QUOTE_MAX_AGE);
        d.pool.setMinLock(USDG, QUOTE_MIN_LOCK);
        d.pool.setGuardian(d.safe); // the Safe stops deposits or a market at once; resuming waits for the timelock

        _handOff(c.deployer, d);
    }

    /// Pool and gate ownership to the timelock (accepted through it), the 48-hour delay set through it, the Safe as its
    /// only proposer, canceller and executor, and every deployer role renounced.
    function _handOff(address deployer, Deployed memory d) internal {
        TimelockController t = d.timelock;
        d.pool.transferOwnership(address(t));
        d.gate.transferOwnership(address(t));
        address[] memory targets = new address[](3);
        uint256[] memory values = new uint256[](3);
        bytes[] memory calls = new bytes[](3);
        (targets[0], calls[0]) = (address(d.pool), abi.encodeCall(AuctionPool.acceptOwnership, ()));
        (targets[1], calls[1]) = (address(d.gate), abi.encodeCall(ScreeningGate.acceptOwnership, ()));
        (targets[2], calls[2]) = (address(t), abi.encodeCall(TimelockController.updateDelay, (TIMELOCK_DELAY)));
        t.scheduleBatch(targets, values, calls, bytes32(0), bytes32(0), 0);
        t.executeBatch(targets, values, calls, bytes32(0), bytes32(0));

        t.grantRole(t.PROPOSER_ROLE(), d.safe);
        t.grantRole(t.CANCELLER_ROLE(), d.safe);
        t.grantRole(t.EXECUTOR_ROLE(), d.safe);
        t.renounceRole(t.PROPOSER_ROLE(), deployer);
        t.renounceRole(t.CANCELLER_ROLE(), deployer);
        t.renounceRole(t.EXECUTOR_ROLE(), deployer);
        t.renounceRole(t.DEFAULT_ADMIN_ROLE(), deployer); // the timelock stays its own admin: role changes take 48 h
    }

    function _createSafe(address[] memory signers) internal returns (address) {
        require(signers.length >= SAFE_THRESHOLD, "SAFE_SIGNERS: at least two signers");
        bytes memory setup = abi.encodeWithSignature(
            "setup(address[],uint256,address,bytes,address,address,uint256,address)",
            signers, SAFE_THRESHOLD, address(0), bytes(""), SAFE_FALLBACK_HANDLER, address(0), uint256(0), payable(address(0))
        );
        return ISafeProxyFactory(SAFE_FACTORY).createProxyWithNonce(SAFE_L2_SINGLETON, setup, uint256(keccak256(abi.encode(signers))));
    }

    /// The deployment manifest (deployments/<chain>.json) the app bundles and PostDeployCheck reads.
    function manifest(Config memory c, Deployed memory d, uint256 deployBlock) public returns (string memory) {
        string memory feeds;
        string memory tokens;
        for (uint256 i; i < stocks.length; i++) {
            feeds = vm.serializeAddress("feeds", symbols[i], stockFeeds[i]);
            tokens = vm.serializeAddress("tokens", symbols[i], stocks[i]);
        }
        vm.serializeAddress("feeds", "ETH", FEED_ETH);
        feeds = vm.serializeAddress("feeds", "USDG", FEED_USDG);
        tokens = vm.serializeAddress("tokens", "USDG", USDG);
        vm.serializeUint("deployment", "chainId", block.chainid);
        vm.serializeUint("deployment", "deployBlock", deployBlock);
        vm.serializeAddress("deployment", "operator", c.operator);
        vm.serializeAddress("deployment", "deployer", c.deployer);
        vm.serializeAddress("deployment", "owner", address(d.timelock));
        vm.serializeAddress("deployment", "safe", d.safe);
        vm.serializeAddress("deployment", "safeSigners", ISafeOwners(d.safe).getOwners());
        vm.serializeAddress("deployment", "AuctionPool", address(d.pool));
        vm.serializeAddress("deployment", "PrintRegistry", address(d.prints));
        vm.serializeAddress("deployment", "RfqDesk", address(d.desk));
        vm.serializeAddress("deployment", "ScreeningGate", address(d.gate));
        vm.serializeAddress("deployment", "DisclosureRegistry", address(d.disclosure));
        vm.serializeString("deployment", "feeds", feeds);
        return vm.serializeString("deployment", "tokens", tokens);
    }
}
