// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {AuctionPool} from "../src/AuctionPool.sol";
import {DisclosureRegistry} from "../src/DisclosureRegistry.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {IPrintRegistry, IProofVerifier, IScreeningGate} from "../src/Interfaces.sol";
import {LUMI} from "../src/LUMI.sol";
import {PrintRegistry} from "../src/PrintRegistry.sol";
import {RfqDesk} from "../src/RfqDesk.sol";
import {ScreeningGate} from "../src/ScreeningGate.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {TreasuryQuote} from "../src/mocks/TreasuryQuote.sol";
// Every bb-generated verifier is named HonkVerifier; aliases keep them apart.
import {HonkVerifier as DepositHonk} from "../src/verifiers/DepositVerifier.sol";
import {HonkVerifier as TreeUpdateHonk} from "../src/verifiers/TreeUpdateVerifier.sol";
import {HonkVerifier as TransactHonk} from "../src/verifiers/TransactVerifier.sol";
import {HonkVerifier as OrderValidityHonk} from "../src/verifiers/OrderValidityVerifier.sol";
import {HonkVerifier as AuctionClearHonk} from "../src/verifiers/AuctionClearVerifier.sol";
import {HonkVerifier as ReclaimHonk} from "../src/verifiers/ReclaimVerifier.sol";
import {HonkVerifier as RfqCrossHonk} from "../src/verifiers/RfqCrossVerifier.sol";

/// Deploys Luminary to Robinhood Chain testnet (46630) with the operator key as owner, scheduler, price pusher, NAV
/// keeper and association poster, and writes every address to deployments/46630.json.
///   OPERATOR_PRIVATE_KEY  deployer and operator (testnet key only)
///   FEE_OWNER             owner key of settlement fee notes (ownerPub of the fee secret)
///   PRICE_<SYMBOL>        initial 8-decimal answers for the mock feeds (the nav-watcher takes over within minutes)
/// forge script script/Deploy.s.sol --rpc-url robinhood_testnet --broadcast --slow
contract Deploy is Script {
    // Official testnet faucet stock tokens, 18 decimals
    address constant TSLA = 0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E;
    address constant AMZN = 0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02;
    address constant AMD = 0x71178BAc73cBeb415514eB542a8995b82669778d;
    address constant PLTR = 0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0;
    address constant NFLX = 0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93;
    uint88 constant STOCK_UNIT = 1e12; // 18 decimals → micro-units
    uint16 constant STOCK_CAP_BPS = 500;
    uint16 constant NAV_CAP_BPS = 100;
    uint16 constant FEE_BPS = 5;


    address[5] stocks = [TSLA, AMZN, AMD, PLTR, NFLX];
    string[5] symbols = ["TSLA", "AMZN", "AMD", "PLTR", "NFLX"];
    address operator;
    AuctionPool pool;
    PrintRegistry prints;
    RfqDesk desk;
    ScreeningGate gate;
    DisclosureRegistry disclosure;
    FeeVault vault;
    LUMI lumi;
    MockUSDG usdg;
    TreasuryQuote tq;
    string feeds;

    function run() external {
        uint256 key = vm.envUint("OPERATOR_PRIVATE_KEY");
        operator = vm.addr(key);
        vm.startBroadcast(key);
        _core(vm.envBytes32("FEE_OWNER"));
        _markets();
        vm.stopBroadcast();
        _write();
        console.log("AuctionPool", address(pool));
    }

    function _core(bytes32 feeOwner) internal {
        AuctionPool.Verifiers memory v = AuctionPool.Verifiers(
            IProofVerifier(address(new DepositHonk())),
            IProofVerifier(address(new TreeUpdateHonk())),
            IProofVerifier(address(new TransactHonk())),
            IProofVerifier(address(new OrderValidityHonk())),
            IProofVerifier(address(new AuctionClearHonk())),
            IProofVerifier(address(new ReclaimHonk()))
        );
        prints = new PrintRegistry();
        pool = new AuctionPool(operator, v, IPrintRegistry(address(prints)), feeOwner, FEE_BPS);
        prints.setWriter(address(pool));
        desk = new RfqDesk(pool, IProofVerifier(address(new RfqCrossHonk())));
        pool.setDesk(address(desk));
        pool.setScheduler(operator, true);
        gate = new ScreeningGate(operator, operator);
        pool.setGate(IScreeningGate(address(gate)));
        disclosure = new DisclosureRegistry();
        vault = new FeeVault(operator, operator);
        lumi = new LUMI("Luminary", "LUMI", operator, 1_000_000_000e18);
    }

    function _markets() internal {
        usdg = new MockUSDG();
        tq = new TreasuryQuote(usdg, operator);
        usdg.setMinter(address(tq));
        pool.setMarket(address(tq), address(tq), 1, true, NAV_CAP_BPS);
        MockAggregator usdgFeed = new MockAggregator("USDG / USD", operator, 1e8);
        pool.setMarket(address(usdg), address(usdgFeed), 1, false, 0);
        vm.serializeAddress("feeds", "USDG", address(usdgFeed));
        MockAggregator ethFeed = new MockAggregator("ETH / USD", operator, int256(vm.envUint("PRICE_ETH")));
        vm.serializeAddress("feeds", "ETH", address(ethFeed));
        for (uint256 i; i < 5; i++) {
            string memory symbol = symbols[i];
            MockAggregator feed = new MockAggregator(string.concat(symbol, " / USD"), operator, int256(vm.envUint(string.concat("PRICE_", symbol))));
            pool.setMarket(stocks[i], address(feed), STOCK_UNIT, true, STOCK_CAP_BPS);
            feeds = vm.serializeAddress("feeds", symbol, address(feed));
        }
    }

    function _write() internal {
        for (uint256 i; i < 5; i++) {
            vm.serializeAddress("tokens", symbols[i], stocks[i]);
        }
        vm.serializeAddress("tokens", "USDG", address(usdg));
        string memory tokens = vm.serializeAddress("tokens", "TQ", address(tq));
        vm.serializeUint("deployment", "chainId", block.chainid);
        vm.serializeUint("deployment", "deployBlock", block.number);
        vm.serializeAddress("deployment", "operator", operator);
        vm.serializeAddress("deployment", "AuctionPool", address(pool));
        vm.serializeAddress("deployment", "PrintRegistry", address(prints));
        vm.serializeAddress("deployment", "RfqDesk", address(desk));
        vm.serializeAddress("deployment", "ScreeningGate", address(gate));
        vm.serializeAddress("deployment", "DisclosureRegistry", address(disclosure));
        vm.serializeAddress("deployment", "FeeVault", address(vault));
        vm.serializeAddress("deployment", "LUMI", address(lumi));
        vm.serializeString("deployment", "feeds", feeds);
        string memory out = vm.serializeString("deployment", "tokens", tokens);
        vm.writeJson(out, string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }
}
