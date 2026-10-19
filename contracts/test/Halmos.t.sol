// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AuctionPool} from "../src/AuctionPool.sol";
import {IPrintRegistry, IProofVerifier} from "../src/Interfaces.sol";

/// Symbolic checks of the contracts' own math, for Halmos 0.3.3. Forge skips `check_` functions. Run from contracts/:
///   FOUNDRY_OUT=out-halmos halmos --forge-build-out out-halmos --contract HalmosChecks --loop 32
/// (--loop 32: the default bound of 2 cuts the pool's 11-input loop and leaves paths unexplored; out-halmos: Halmos
/// builds with extra outputs, and in out/ that build makes the PostDeployCheck tests compare the wrong artifacts.) Proofs are out of scope here (every proof is accepted): the circuits carry the clearing math and have
/// their own tests. Each check proves its property for every value of its arguments.
contract AcceptAll is IProofVerifier {
    function verify(bytes calldata, bytes32[] calldata) external pure returns (bool) {
        return true;
    }
}

contract SymFeed {
    int256 internal answer;
    uint256 internal updatedAt;

    function set(int256 a, uint256 u) external {
        answer = a;
        updatedAt = u;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, 0, updatedAt, 1);
    }
}

contract HalmosChecks is Test {
    uint256 internal constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    address internal constant ASSET = address(0x1001);
    address internal constant QUOTE = address(0x1002);
    address internal constant ALICE = address(0xA11CE);
    address internal constant RELAYER = address(0xB0B);
    address internal constant FEE_TO = address(0xFEE);

    AuctionPool internal pool;
    SymFeed internal assetFeed;
    SymFeed internal quoteFeed;

    bytes32 internal constant ROOT = bytes32(uint256(0x600D));

    function setUp() public {
        vm.warp(1_790_000_000); // a real clock, so a feed can be stale
        IProofVerifier v = new AcceptAll();
        pool = new AuctionPool(address(this), AuctionPool.Verifiers(v, v, v, v, v, v), IPrintRegistry(address(0xBEEF)), 0, 10);
        assetFeed = new SymFeed();
        quoteFeed = new SymFeed();
        pool.setMarket(ASSET, address(assetFeed), 1e12, true, 500, 1 hours);
        pool.setMarket(QUOTE, address(quoteFeed), 1, false, 0, 25 hours);
        pool.setScheduler(address(this), true);
        // 10 ETH in the pool and a known root to spend from. (A root the pool's constructor marks known does not read
        // back under Halmos, so the checks use one made the way the tree worker makes them.)
        vm.deal(address(this), 10 ether);
        pool.deposit{value: 10 ether}(address(0), 10 ether, bytes32(uint256(1)), "");
        pool.advanceTree(1, ROOT, "");
    }

    // --- notes -----------------------------------------------------------------------------------------------------

    /// A deposit of `amount` with msg.value == amount + depositFee lands whole: the pool keeps exactly `amount` and the
    /// fee recipient gets exactly the fee.
    function check_deposit_eth_takes_exactly_amount_plus_fee(uint256 amount, uint256 fee) public {
        vm.assume(fee <= pool.MAX_DEPOSIT_FEE() && amount != 0 && amount <= type(uint128).max);
        pool.setDepositFee(FEE_TO, fee);
        vm.deal(ALICE, amount + fee);
        vm.prank(ALICE);
        pool.deposit{value: amount + fee}(address(0), amount, bytes32(uint256(2)), "");
        assert(address(pool).balance == 10 ether + amount);
        assert(FEE_TO.balance == fee && ALICE.balance == 0);
    }

    /// Any other msg.value is refused.
    function check_deposit_eth_refuses_any_other_value(uint256 amount, uint256 value, uint256 fee) public {
        vm.assume(fee <= pool.MAX_DEPOSIT_FEE());
        vm.assume(value != amount + fee || amount + fee < amount); // includes the overflowing sums
        pool.setDepositFee(FEE_TO, fee);
        vm.deal(ALICE, value);
        vm.prank(ALICE);
        try pool.deposit{value: value}(address(0), amount, bytes32(uint256(2)), "") {
            assert(false);
        } catch {}
    }

    /// A transaction pays out exactly `released` to the recipient and `fee` to the relayer, takes exactly that from
    /// the pool, and its nullifiers can never be spent again.
    function check_transact_pays_exactly_and_spends_once(uint256 released, uint256 fee, bytes32 n0, bytes32 n1) public {
        vm.assume(n0 != n1 && released <= 10 ether && fee <= 10 ether - released);
        AuctionPool.Transaction memory t = AuctionPool.Transaction({
            root: ROOT,
            aspRoot: 0,
            nullifiers: [n0, n1],
            outputs: [bytes32(uint256(2)), bytes32(uint256(3))],
            asset: address(0),
            released: released,
            fee: fee,
            to: ALICE,
            relayer: RELAYER
        });
        pool.transact(t, "", "");
        assert(ALICE.balance == released && RELAYER.balance == fee);
        assert(address(pool).balance == 10 ether - released - fee);
        assert(pool.spent(n0) && pool.spent(n1));
        try pool.transact(t, "", "") {
            assert(false); // a spent note is spent for good
        } catch {}
    }

    // --- prices ----------------------------------------------------------------------------------------------------

    /// Once the call time has passed, pin never reverts. It records a price only from a fresh, positive feed answer
    /// (8 → 6 decimals, fits uint64); otherwise the auction is voided and every order is reclaimable.
    function check_pin_records_only_fresh_prices(int256 a, uint256 au, int256 q, uint256 qu) public {
        uint256 id = pool.schedule(ASSET, QUOTE, AuctionPool.Kind.OPEN, uint64(block.timestamp + 100));
        AuctionPool.Placement memory p;
        p.root = ROOT;
        p.nullifier = bytes32(uint256(7));
        p.commitment = bytes32(uint256(8));
        pool.placeOrder(id, p, "", "");
        vm.warp(block.timestamp + 100);
        assetFeed.set(a, au);
        quoteFeed.set(q, qu);

        try pool.pin(id) {} catch {
            assert(false);
        }
        AuctionPool.Auction memory x = pool.auctions(id);
        assert(x.callBlock != 0);
        if (!x.voided) {
            assert(a >= 100 && uint256(a) / 100 <= type(uint64).max && x.refUsd == uint256(a) / 100);
            assert(q >= 100 && uint256(q) / 100 <= type(uint64).max && x.quoteUsd == uint256(q) / 100);
            assert(au <= block.timestamp && block.timestamp - au <= 1 hours); // the asset market's maxAge
            assert(qu <= block.timestamp && block.timestamp - qu <= 25 hours); // the quote market's maxAge
        } else {
            assert(x.refUsd == 0 && x.quoteUsd == 0);
        }
    }

    // --- owner settings stay in their bounds -------------------------------------------------------------------------

    function check_fee_stays_in_bounds(bytes32 feeOwner, uint16 bps) public {
        try pool.setFee(feeOwner, bps) {
            assert(bps <= pool.MAX_FEE_BPS() && uint256(feeOwner) < FIELD);
        } catch {
            assert(bps > pool.MAX_FEE_BPS() || uint256(feeOwner) >= FIELD);
        }
    }

    /// A market's unit is fixed once set: open orders and notes are denominated in it.
    function check_market_unit_never_changes(uint88 unit, uint16 capBps) public {
        try pool.setMarket(ASSET, address(assetFeed), unit, true, capBps, 1 hours) {
            assert(unit == 1e12 && capBps <= pool.MAX_CAP_BPS());
        } catch {}
        (, uint88 now_,,,) = pool.markets(ASSET);
        assert(now_ == 1e12);
    }

    function check_only_owner_changes_settings(address caller, uint16 bps) public {
        vm.assume(caller != address(this));
        vm.prank(caller);
        try pool.setFee(0, bps) {
            assert(false);
        } catch {}
        vm.prank(caller);
        try pool.setDepositsPaused(true) {
            assert(false);
        } catch {}
        assert(!pool.depositsPaused());
    }
}
