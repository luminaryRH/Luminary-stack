// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AuctionPool} from "../src/AuctionPool.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {PrintRegistry} from "../src/PrintRegistry.sol";
import {RfqDesk} from "../src/RfqDesk.sol";
import {ScreeningGate} from "../src/ScreeningGate.sol";

/// @title PostDeployCheck
/// @notice Read-only check that a live deployment is this build, owned and wired as intended. It never broadcasts.
///   forge build && forge script script/PostDeployCheck.s.sol --rpc-url robinhood_testnet
/// Reads deployments/<chainId>.json (written by Deploy.s.sol). Every failed check is logged; any failure reverts.
///   1. bytecode: every contract and verifier matches this build (immutable values masked)
///   2. ownership: the pool, gate and vault are owned by `owner` (the operator until the multisig handoff), with no
///      pending transfer
///   3. wiring: desk (set once), print writer, gate, verifiers, scheduler, RfqDesk → pool
///   4. markets: five listed stocks (unit 1e12, ±5% band, feed from the manifest, a minimum lock) and the quote tokens
///   5. state: deposits not paused, fee and deposit fee inside their bounds
contract PostDeployCheck is Script {
    struct ImmutableRef {
        uint256 length;
        uint256 start;
    }

    string[5] internal STOCKS = ["TSLA", "AMZN", "AMD", "PLTR", "NFLX"];
    uint256 internal failures;

    function run() external {
        check(vm.readFile(string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json")));
    }

    /// Runs every check against the manifest `json`; reverts naming the count when any fails.
    function check(string memory json) public {
        failures = 0;
        AuctionPool pool = AuctionPool(vm.parseJsonAddress(json, ".AuctionPool"));
        RfqDesk desk = RfqDesk(vm.parseJsonAddress(json, ".RfqDesk"));
        ScreeningGate gate = ScreeningGate(vm.parseJsonAddress(json, ".ScreeningGate"));
        PrintRegistry prints = PrintRegistry(vm.parseJsonAddress(json, ".PrintRegistry"));
        FeeVault vault = FeeVault(payable(vm.parseJsonAddress(json, ".FeeVault")));
        address operator = vm.parseJsonAddress(json, ".operator");
        address owner = vm.keyExistsJson(json, ".owner") ? vm.parseJsonAddress(json, ".owner") : operator;

        // 1. bytecode
        _same(address(pool), "AuctionPool.sol", "AuctionPool");
        _same(address(desk), "RfqDesk.sol", "RfqDesk");
        _same(address(gate), "ScreeningGate.sol", "ScreeningGate");
        _same(address(prints), "PrintRegistry.sol", "PrintRegistry");
        _same(address(vault), "FeeVault.sol", "FeeVault");
        _same(vm.parseJsonAddress(json, ".LUMI"), "LUMI.sol", "LUMI");
        _same(vm.parseJsonAddress(json, ".DisclosureRegistry"), "DisclosureRegistry.sol", "DisclosureRegistry");
        _same(address(pool.depositVerifier()), "DepositVerifier.sol", "HonkVerifier");
        _same(address(pool.treeVerifier()), "TreeUpdateVerifier.sol", "HonkVerifier");
        _same(address(pool.transactVerifier()), "TransactVerifier.sol", "HonkVerifier");
        _same(address(pool.orderVerifier()), "OrderValidityVerifier.sol", "HonkVerifier");
        _same(address(pool.clearVerifier()), "AuctionClearVerifier.sol", "HonkVerifier");
        _same(address(pool.reclaimVerifier()), "ReclaimVerifier.sol", "HonkVerifier");
        _same(address(desk.rfqVerifier()), "RfqCrossVerifier.sol", "HonkVerifier");

        // 2. ownership
        _check(pool.owner() == owner && pool.pendingOwner() == address(0), "AuctionPool owner", address(pool));
        _check(gate.owner() == owner && gate.pendingOwner() == address(0), "ScreeningGate owner", address(gate));
        _check(vault.owner() == owner && vault.pendingOwner() == address(0), "FeeVault owner", address(vault));

        // 3. wiring
        _check(pool.desk() == address(desk), "pool.desk is the RfqDesk", address(pool));
        _check(address(desk.pool()) == address(pool), "RfqDesk.pool is the pool", address(desk));
        _check(address(pool.prints()) == address(prints) && prints.writer() == address(pool), "PrintRegistry wiring", address(prints));
        _check(address(pool.gate()) == address(gate), "pool.gate is the ScreeningGate", address(pool));
        _check(pool.scheduler(operator), "operator schedules auctions", address(pool));
        _check(gate.poster() == operator, "operator posts association roots", address(gate));

        // 4. markets
        for (uint256 i; i < STOCKS.length; i++) {
            address token = vm.parseJsonAddress(json, string.concat(".tokens.", STOCKS[i]));
            address feed = vm.parseJsonAddress(json, string.concat(".feeds.", STOCKS[i]));
            (address f, uint88 unit, bool listed, uint16 capBps) = pool.markets(token);
            _check(f == feed && unit == 1e12 && listed && capBps == 500, string.concat(STOCKS[i], " market"), token);
            _check(pool.minLock(token) > 0, string.concat(STOCKS[i], " minimum lock"), token);
        }
        address usdg = vm.parseJsonAddress(json, ".tokens.USDG");
        (address usdgFeed, uint88 usdgUnit, bool usdgListed,) = pool.markets(usdg);
        _check(usdgFeed == vm.parseJsonAddress(json, ".feeds.USDG") && usdgUnit == 1 && !usdgListed, "USDG quote market", usdg);
        _check(pool.minLock(usdg) > 0, "USDG minimum lock", usdg);

        // 5. state
        _check(!pool.depositsPaused(), "deposits open", address(pool));
        _check(pool.feeBps() <= pool.MAX_FEE_BPS() && pool.depositFee() <= pool.MAX_DEPOSIT_FEE(), "fees in bounds", address(pool));

        if (failures > 0) revert(string.concat("post-deploy check FAILED: ", vm.toString(failures), " problem(s)"));
        console2.log("post-deploy check PASSED on chain", block.chainid);
    }

    /// The live runtime code equals this build's, with the immutable values (constructor arguments) masked out.
    function _same(address a, string memory file, string memory name) internal {
        bytes memory live = a.code;
        if (live.length == 0) return _fail(string.concat(name, ": no code"), a);
        string memory art = vm.readFile(string.concat(vm.projectRoot(), "/out/", file, "/", name, ".json"));
        // linked library addresses (the Honk verifiers') are placeholders in the artifact: zero them, mask them below
        string memory object = vm.parseJsonString(art, ".deployedBytecode.object");
        for (uint256 at = vm.indexOf(object, "__$"); at != type(uint256).max; at = vm.indexOf(object, "__$")) {
            object = vm.replace(object, _slice(object, at, 40), "0000000000000000000000000000000000000000");
        }
        bytes memory local = vm.parseBytes(object);
        if (local.length != live.length) return _fail(string.concat(file, ": runtime size differs from this build"), a);
        _mask(art, ".deployedBytecode.immutableReferences", live, local);
        string[] memory files = _keys(art, ".deployedBytecode.linkReferences");
        for (uint256 i; i < files.length; i++) {
            _mask(art, string.concat(".deployedBytecode.linkReferences['", files[i], "']"), live, local); // keys are file paths
        }
        _check(keccak256(live) == keccak256(local), string.concat(file, ": bytecode differs from this build"), a);
    }

    /// Zeroes, in both codes, every {start, length} range listed under each key of the object at `path`.
    function _mask(string memory art, string memory path, bytes memory live, bytes memory local) internal view {
        string[] memory ids = _keys(art, path);
        for (uint256 i; i < ids.length; i++) {
            ImmutableRef[] memory refs = abi.decode(vm.parseJson(art, string.concat(path, ".", ids[i])), (ImmutableRef[]));
            for (uint256 j; j < refs.length; j++) {
                for (uint256 k = refs[j].start; k < refs[j].start + refs[j].length; k++) {
                    live[k] = 0;
                    local[k] = 0;
                }
            }
        }
    }

    function _keys(string memory art, string memory path) internal view returns (string[] memory keys) {
        try vm.parseJsonKeys(art, path) returns (string[] memory k) {
            keys = k;
        } catch {} // an empty or absent object
    }

    function _slice(string memory s, uint256 from, uint256 length) internal pure returns (string memory) {
        bytes memory out = new bytes(length);
        for (uint256 i; i < length; i++) {
            out[i] = bytes(s)[from + i];
        }
        return string(out);
    }

    function _check(bool ok, string memory what, address where) internal {
        if (!ok) _fail(what, where);
    }

    function _fail(string memory what, address where) internal {
        failures++;
        console2.log(string.concat("FAIL: ", what, " @ ", vm.toString(where)));
    }
}
