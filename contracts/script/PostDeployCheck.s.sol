// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {AuctionPool} from "../src/AuctionPool.sol";
import {IPriceFeed} from "../src/Interfaces.sol";
import {PrintRegistry} from "../src/PrintRegistry.sol";
import {RfqDesk} from "../src/RfqDesk.sol";
import {ScreeningGate} from "../src/ScreeningGate.sol";

interface ISafe {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
}

interface IDecimals {
    function decimals() external view returns (uint8);
}

/// @title PostDeployCheck
/// @notice Read-only check that a live deployment is this build, owned and wired as intended. It never broadcasts.
///   forge build && forge script script/PostDeployCheck.s.sol --rpc-url robinhood
/// Reads deployments/<chainId>.json (written by Deploy.s.sol). Every failed check is logged; any failure reverts.
///   1. bytecode: every contract, verifier (and each verifier's linked libraries) and the timelock match this build
///      (immutable values and library addresses masked; the libraries are checked at the addresses linked in)
///   2. ownership: the pool and the gate are owned by the timelock, with no pending transfer; the timelock waits
///      48 hours, the Safe is its only proposer, canceller and executor, the deployer holds no role; the Safe is the
///      official SafeL2 with the manifest's signers and a threshold of 2
///   3. wiring: desk (set once), print writer, gate (association required), verifiers, scheduler and poster (the
///      operator; never the deployer), the Safe as guardian, RfqDesk → pool
///   4. markets: four listed stocks (unit 1e12, ±5% band, 25-hour staleness for the feeds' 24-hour heartbeat, the
///      manifest's feed, a minimum lock at least Deploy.s.sol's) and USDG as quote (25-hour staleness, minimum lock at
///      least Deploy.s.sol's); tokens and feeds answer with their expected decimals
///   5. state: deposits open; the fee is Deploy.s.sol's and its notes go to the manifest's feeOwner; a deposit fee, if
///      any, is in bounds and paid to the operator
///   6. gate: no sanctions oracle, or one with code; the operator, the Safe and the pool are not blocked
contract PostDeployCheck is Script {
    struct ImmutableRef {
        uint256 length;
        uint256 start;
    }

    string[4] internal STOCKS = ["TSLA", "AMZN", "AMD", "PLTR"];
    address internal constant SAFE_L2_SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    uint256 internal constant TIMELOCK_DELAY = 48 hours;
    // Deploy.s.sol's values: the fee, and the minimum locks (raising them is fine, lowering them is not)
    uint16 internal constant FEE_BPS = 5;
    uint256 internal constant STOCK_MIN_LOCK = 50_000;
    uint256 internal constant QUOTE_MIN_LOCK = 25e6;
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
        TimelockController timelock = TimelockController(payable(vm.parseJsonAddress(json, ".owner")));
        address operator = vm.parseJsonAddress(json, ".operator");
        address deployer = vm.parseJsonAddress(json, ".deployer");

        // 1. bytecode
        _same(address(pool), "AuctionPool.sol", "AuctionPool");
        _same(address(desk), "RfqDesk.sol", "RfqDesk");
        _same(address(gate), "ScreeningGate.sol", "ScreeningGate");
        _same(address(prints), "PrintRegistry.sol", "PrintRegistry");
        _same(vm.parseJsonAddress(json, ".DisclosureRegistry"), "DisclosureRegistry.sol", "DisclosureRegistry");
        _same(address(timelock), "TimelockController.sol", "TimelockController");
        _same(address(pool.depositVerifier()), "DepositVerifier.sol", "HonkVerifier");
        _same(address(pool.treeVerifier()), "TreeUpdateVerifier.sol", "HonkVerifier");
        _same(address(pool.transactVerifier()), "TransactVerifier.sol", "HonkVerifier");
        _same(address(pool.orderVerifier()), "OrderValidityVerifier.sol", "HonkVerifier");
        _same(address(pool.clearVerifier()), "AuctionClearVerifier.sol", "HonkVerifier");
        _same(address(pool.reclaimVerifier()), "ReclaimVerifier.sol", "HonkVerifier");
        _same(address(desk.rfqVerifier()), "RfqCrossVerifier.sol", "HonkVerifier");

        // 2. ownership
        _checkOwnership(json, pool, gate, timelock);

        // 3. wiring
        _check(pool.desk() == address(desk), "pool.desk is the RfqDesk", address(pool));
        _check(address(desk.pool()) == address(pool), "RfqDesk.pool is the pool", address(desk));
        _check(address(pool.prints()) == address(prints) && prints.writer() == address(pool), "PrintRegistry wiring", address(prints));
        _check(address(pool.gate()) == address(gate) && gate.associationRequired(), "gate set, association required", address(pool));
        _check(pool.scheduler(operator) && !pool.scheduler(deployer), "operator (not the deployer) schedules auctions", address(pool));
        _check(pool.guardian() == vm.parseJsonAddress(json, ".safe"), "the Safe is the guardian", address(pool));
        _check(gate.poster() == operator, "operator posts association roots", address(gate));

        // 4. markets
        _checkMarkets(json, pool);

        // 5. state
        _check(!pool.depositsPaused(), "deposits open", address(pool));
        _check(pool.feeBps() == FEE_BPS, "settlement fee is Deploy.s.sol's", address(pool));
        _check(pool.feeOwner() == vm.parseJsonBytes32(json, ".feeOwner"), "fee notes go to the manifest's feeOwner", address(pool));
        uint256 depositFee = pool.depositFee();
        _check(
            depositFee <= pool.MAX_DEPOSIT_FEE() && (depositFee == 0 || pool.feeRecipient() == operator),
            "deposit fee in bounds and paid to the operator",
            address(pool)
        );

        // 6. gate
        address sanctions = address(gate.sanctions());
        _check(sanctions == address(0) || sanctions.code.length > 0, "sanctions oracle unset or has code", address(gate));
        _check(
            !gate.blocked(operator) && !gate.blocked(vm.parseJsonAddress(json, ".safe")) && !gate.blocked(address(pool)),
            "operator, Safe and pool not blocked",
            address(gate)
        );

        if (failures > 0) revert(string.concat("post-deploy check FAILED: ", vm.toString(failures), " problem(s)"));
        console2.log("post-deploy check PASSED on chain", block.chainid);
    }

    function _checkOwnership(string memory json, AuctionPool pool, ScreeningGate gate, TimelockController timelock) internal {
        address safe = vm.parseJsonAddress(json, ".safe");
        address operator = vm.parseJsonAddress(json, ".operator");
        address deployer = vm.parseJsonAddress(json, ".deployer");
        _check(pool.owner() == address(timelock) && pool.pendingOwner() == address(0), "AuctionPool owned by the timelock", address(pool));
        _check(gate.owner() == address(timelock) && gate.pendingOwner() == address(0), "ScreeningGate owned by the timelock", address(gate));
        _check(timelock.getMinDelay() == TIMELOCK_DELAY, "timelock delay is 48 hours", address(timelock));
        bytes32[4] memory roles = [timelock.PROPOSER_ROLE(), timelock.CANCELLER_ROLE(), timelock.EXECUTOR_ROLE(), timelock.DEFAULT_ADMIN_ROLE()];
        for (uint256 i; i < 3; i++) {
            _check(timelock.hasRole(roles[i], safe), "the Safe holds every timelock role", address(timelock));
            _check(!timelock.hasRole(roles[i], operator), "the operator holds no timelock role", address(timelock));
            _check(!timelock.hasRole(roles[i], address(0)), "no open timelock role", address(timelock));
        }
        for (uint256 i; i < 4; i++) {
            _check(!timelock.hasRole(roles[i], deployer), "the deployer holds no timelock role", address(timelock));
        }
        _check(
            timelock.hasRole(roles[3], address(timelock)) && !timelock.hasRole(roles[3], safe),
            "the timelock is its own admin (role changes wait 48 hours)",
            address(timelock)
        );
        _checkSafe(json, safe);
    }

    function _checkMarkets(string memory json, AuctionPool pool) internal {
        for (uint256 i; i < STOCKS.length; i++) {
            address token = vm.parseJsonAddress(json, string.concat(".tokens.", STOCKS[i]));
            address feed = vm.parseJsonAddress(json, string.concat(".feeds.", STOCKS[i]));
            (address f, uint88 unit, bool listed, uint16 capBps, uint32 maxAge) = pool.markets(token);
            _check(f == feed && unit == 1e12 && listed && capBps == 500 && maxAge == 25 hours, string.concat(STOCKS[i], " market"), token);
            _check(pool.minLock(token) >= STOCK_MIN_LOCK, string.concat(STOCKS[i], " minimum lock"), token);
            _check(_decimals(token) == 18 && _decimals(feed) == 8 && _answers(feed), string.concat(STOCKS[i], " token and feed"), token);
        }
        address usdg = vm.parseJsonAddress(json, ".tokens.USDG");
        address usdgFeed = vm.parseJsonAddress(json, ".feeds.USDG");
        (address uf, uint88 usdgUnit, bool usdgListed,, uint32 usdgAge) = pool.markets(usdg);
        _check(uf == usdgFeed && usdgUnit == 1 && !usdgListed && usdgAge == 25 hours, "USDG quote market", usdg);
        _check(pool.minLock(usdg) >= QUOTE_MIN_LOCK, "USDG minimum lock", usdg);
        _check(_decimals(usdg) == 6 && _decimals(usdgFeed) == 8 && _answers(usdgFeed), "USDG token and feed", usdg);
    }

    /// The Safe is a proxy of the official SafeL2 singleton (slot 0), with the manifest's signers and threshold 2.
    function _checkSafe(string memory json, address safe) internal {
        if (safe.code.length == 0) return _fail("Safe: no code", safe);
        if (block.chainid == 4663) {
            _check(address(uint160(uint256(vm.load(safe, 0)))) == SAFE_L2_SINGLETON, "Safe runs the official SafeL2 v1.4.1", safe);
        }
        address[] memory want = vm.parseJsonAddressArray(json, ".safeSigners");
        try ISafe(safe).getOwners() returns (address[] memory owners) {
            bool same = owners.length == want.length;
            for (uint256 i; same && i < want.length; i++) {
                bool found;
                for (uint256 j; j < owners.length; j++) found = found || owners[j] == want[i];
                same = found;
            }
            _check(same, "Safe signers are the manifest's", safe);
            _check(ISafe(safe).getThreshold() == 2, "Safe threshold is 2", safe);
        } catch {
            _fail("Safe: getOwners failed", safe);
        }
    }

    function _decimals(address a) internal view returns (uint256) {
        try IDecimals(a).decimals() returns (uint8 d) {
            return d;
        } catch {
            return type(uint256).max;
        }
    }

    /// The feed answers a positive price (its freshness is the pool's business at each pin).
    function _answers(address feed) internal view returns (bool) {
        try IPriceFeed(feed).latestRoundData() returns (uint80, int256 answer, uint256, uint256, uint80) {
            return answer > 0;
        } catch {
            return false;
        }
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
        // a library's runtime code starts with PUSH20 <its own address> (call protection), zero in the artifact
        if (local.length > 21 && local[0] == 0x73) {
            bool placeholder = true;
            for (uint256 k = 1; k <= 20; k++) placeholder = placeholder && local[k] == 0;
            if (placeholder) for (uint256 k = 1; k <= 20; k++) live[k] = 0;
        }
        _mask(art, ".deployedBytecode.immutableReferences", live, local);
        string[] memory files = _keys(art, ".deployedBytecode.linkReferences");
        for (uint256 i; i < files.length; i++) {
            string memory path = string.concat(".deployedBytecode.linkReferences['", files[i], "']"); // keys are file paths
            _sameLibraries(live, art, path, files[i]); // the linked libraries hold verification logic too
            _mask(art, path, live, local);
        }
        _check(keccak256(live) == keccak256(local), string.concat(file, ": bytecode differs from this build"), a);
    }

    /// Each library linked into `live` (read from its first link position) has this build's code. Libraries link nothing.
    function _sameLibraries(bytes memory live, string memory art, string memory path, string memory sourcePath) internal {
        string[] memory libs = _keys(art, path);
        string memory file = _basename(sourcePath);
        for (uint256 i; i < libs.length; i++) {
            ImmutableRef[] memory refs = abi.decode(vm.parseJson(art, string.concat(path, ".", libs[i])), (ImmutableRef[]));
            uint160 at;
            for (uint256 k; k < 20; k++) at = (at << 8) | uint160(uint8(live[refs[0].start + k]));
            _same(address(at), file, libs[i]);
        }
    }

    function _basename(string memory path) internal pure returns (string memory) {
        bytes memory b = bytes(path);
        uint256 from;
        for (uint256 i; i < b.length; i++) if (b[i] == "/") from = i + 1;
        return _slice(path, from, b.length - from);
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
