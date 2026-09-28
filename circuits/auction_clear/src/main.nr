// AuctionClearProof: one sealed-bid, uniform-price call auction with up to N private orders. Proves that clearing the
// auction's committed orders by the published rules (src/server/luminary/engine/clearing.ts) at the pinned reference
// creates exactly the public outputs: per order a fill note and either the rolled order or its refund note, plus one fee
// note, all at a single price p*. Owners, sizes, limits and fills stay private; the contract supplies the order
// commitments, the pinned reference and quote prices, the band cap, the fee and the fee owner.
// Rules:
//   band        [ref·(1−cap), ref·(1+cap)] (floored)
//   eligibility plain orders only; a buy's effective limit is its limit capped by what its lock affords for the whole
//               order at that price (an at-auction buy: the lock alone); a sell's is its limit (0 at-auction)
//   candidates  every effective limit inside the band, plus both band edges; p* is one of them
//   p*          maximizes V(p) = min(D(p), S(p)); ties to the smallest |D−S|, then closest to ref, then the lower price
//   fills       strictly better orders first (pro rata among them if they alone exceed the volume), then the orders
//               at p* pro rata; remainders by largest fraction, ties to the earliest slot
//   leftovers   roll into the next auction when the order rolls and has rolls left, else refunded
// Output blindings derive from each order's salt, so owners recognise their notes; fills, refunds and rolled orders
// keep the order's label, the fee note carries FEE_LABEL.
use luminary::{FEE_LABEL, OrderTerms, blind, note, order};

global N: u32 = 64;
global C: u32 = 66; // candidates: N effective limits + both band edges
global BPS: u128 = 10000;
global MAX_PRICE: u128 = 0x1000000000000; // 2^48 micro-USD (order_validity bounds limits the same way)

pub struct Order {
    owner: Field,
    salt: Field,
    buy: bool,
    qty: u128, // open quantity, asset micro-units
    has_limit: bool, // false = at-auction
    limit_usd: u128,
    roll: bool,
    rolls_left: u32,
    lock: u128, // quote micro-units for a buy, asset micro-units (= qty) for a sell
    label: Field,
    min_qty: u128, // reserved terms: an order carrying any does not take part
    display: u128,
    peg: u128,
    rfq: Field,
}

fn terms(o: Order) -> OrderTerms {
    OrderTerms { min_qty: o.min_qty, display: o.display, peg: o.peg, rfq: o.rfq }
}

fn plain(o: Order) -> bool {
    (o.min_qty == 0) & (o.display == 0) & (o.peg == 0) & (o.rfq == 0)
}

fn ceil_div(a: u128, b: u128) -> u128 {
    (a + b - 1) / b
}

fn min(a: u128, b: u128) -> u128 {
    if a < b { a } else { b }
}

fn nonzero(x: u128) -> u128 {
    if x == 0 { 1 } else { x }
}

fn gap(a: u128, b: u128) -> u128 {
    if a > b { a - b } else { b - a }
}

/// D(p) and S(p): buys whose effective limit is at or above p, sells whose limit is at or below p.
fn depth(p: u128, buy: [bool; N], eff: [u128; N], size: [u128; N]) -> (u128, u128) {
    let mut d: u128 = 0;
    let mut s: u128 = 0;
    for i in 0..N {
        if buy[i] {
            if eff[i] >= p {
                d += size[i];
            }
        } else if eff[i] <= p {
            s += size[i];
        }
    }
    (d, s)
}

/// Largest-remainder ordering: remainder descending, then earliest slot.
fn ranks_above(rem_a: u128, a: u32, rem_b: u128, b: u32) -> bool {
    (rem_a > rem_b) | ((rem_a == rem_b) & (a < b))
}

/// Splits `buy_target` over the buy side and `sell_target` over the sell side (each at most its total): everything on
/// a side whose total equals its target, pro rata + largest remainder otherwise. The prover supplies the rounding units
/// and, per side ([buy, sell]), the cut: the remainder and slot of the lowest-ranked order holding a unit (max when none).
fn allocate(
    qty: [u128; N],
    buy: [bool; N],
    buy_total: u128,
    sell_total: u128,
    buy_target: u128,
    sell_target: u128,
    bonus: [bool; N],
    cut_rem: [u128; 2],
    cut_idx: [u32; 2],
) -> [u128; N] {
    let mut filled: [u128; N] = [0; N];
    let mut rems: [u128; N] = [0; N];
    let mut buy_sum: u128 = 0;
    let mut sell_sum: u128 = 0;
    for i in 0..N {
        let total = if buy[i] { buy_total } else { sell_total };
        let target = if buy[i] { buy_target } else { sell_target };
        let pro_rata = target < total;
        let scaled = qty[i] * target;
        let floor = if pro_rata { scaled / nonzero(total) } else { qty[i] };
        let rem = if pro_rata { scaled % nonzero(total) } else { 0 };
        if bonus[i] {
            assert(rem > 0); // a unit only where the exact share has a fractional part, so a fill stays <= its quantity
        }
        filled[i] = floor + (if bonus[i] { 1 } else { 0 });
        rems[i] = rem;
        if buy[i] {
            buy_sum += filled[i];
        } else {
            sell_sum += filled[i];
        }
    }
    assert(buy_sum == buy_target);
    assert(sell_sum == sell_target);
    // the units went to the top of each side: an order with a unit ranks at or above the cut, one without ranks below it.
    // The sums above fix how many units each side has, so this set is exactly the largest remainders.
    for i in 0..N {
        let side = if buy[i] { 0 } else { 1 };
        let (t_rem, t_idx) = (cut_rem[side], cut_idx[side]);
        if bonus[i] {
            assert(ranks_above(rems[i], i, t_rem, t_idx) | ((rems[i] == t_rem) & (i == t_idx)));
        } else {
            assert(ranks_above(t_rem, t_idx, rems[i], i));
        }
    }
    filled
}

fn main(
    orders: [Order; N],
    p_idx: u32, // which candidate p* is: an order's effective limit (< N), the lower (N) or the upper (N + 1) band edge
    bonus1: [bool; N], // rounding units among the strictly better orders
    cut1_rem: [u128; 2],
    cut1_idx: [u32; 2],
    bonus2: [bool; N], // rounding units among the orders at p*
    cut2_rem: [u128; 2],
    cut2_idx: [u32; 2],
    fee_blinding: Field,
    asset: pub Field,
    unit: pub u128, // asset base units per micro-unit
    quote_token: pub Field,
    quote_unit: pub u128,
    ref_usd: pub u128, // pinned reference, micro-USD per asset token
    cap_bps: pub u128, // band half-width
    quote_usd: pub u128, // pinned quote price, micro-USD per quote token
    fee_bps: pub u128,
    p_star: pub u128,
    crossed_qty: pub u128,
    commitments: pub [Field; N], // the auction's orders in slot order; 0 = empty or cancelled slot
    fills: pub [Field; N],
    residuals: pub [Field; N],
    rolls: pub [bool; N],
    fee_owner: pub Field,
    fee_note: pub Field,
) {
    assert(fee_bps < BPS);
    assert(cap_bps < BPS);
    assert((ref_usd > 0) & (ref_usd < MAX_PRICE));
    assert((quote_usd > 0) & (quote_usd < MAX_PRICE));
    let lo = ref_usd * (BPS - cap_bps) / BPS;
    let hi = ref_usd * (BPS + cap_bps) / BPS;

    // 0. every slot is empty or exactly its committed order; each plain order's size and effective limit
    let mut active: [bool; N] = [false; N];
    let mut buy: [bool; N] = [false; N];
    let mut eff: [u128; N] = [0; N];
    let mut size: [u128; N] = [0; N]; // 0 = takes no part
    for i in 0..N {
        let o = orders[i];
        active[i] = commitments[i] != 0;
        buy[i] = o.buy;
        if active[i] {
            assert(
                commitments[i]
                    == order(o.owner, asset, o.buy, o.qty, o.has_limit, o.limit_usd, o.roll, o.rolls_left, o.lock, o.salt, o.label, terms(o)),
            );
            if plain(o) {
                if o.buy {
                    // the highest price at which the lock pays for the whole order plus its fee
                    let budget = o.lock * BPS / (BPS + fee_bps);
                    let afford = budget * quote_usd / nonzero(o.qty);
                    eff[i] = if o.has_limit { min(o.limit_usd, afford) } else { afford };
                    size[i] = o.qty;
                } else {
                    eff[i] = if o.has_limit { o.limit_usd } else { 0 };
                    size[i] = min(o.qty, o.lock);
                }
            }
        }
    }

    // 1. p* is a candidate inside the band
    assert(p_idx < C);
    let k = if p_idx < N { p_idx } else { 0 };
    let named = if p_idx == N {
        lo
    } else if p_idx == N + 1 {
        hi
    } else {
        assert(size[k] > 0);
        eff[k]
    };
    assert(named == p_star);
    assert((lo <= p_star) & (p_star <= hi));

    // 2. p* maximizes the volume over every candidate, and wins the tie-breaks
    let (d_star, s_star) = depth(p_star, buy, eff, size);
    let volume = min(d_star, s_star);
    let imbalance = gap(d_star, s_star);
    let distance = gap(p_star, ref_usd);
    for c in 0..C {
        let (price, is_candidate) = if c < N {
            (eff[c], (size[c] > 0) & (eff[c] >= lo) & (eff[c] <= hi))
        } else if c == N {
            (lo, true)
        } else {
            (hi, true)
        };
        if is_candidate {
            let (d, s) = depth(price, buy, eff, size);
            let v = min(d, s);
            assert(v <= volume);
            if v == volume {
                let im = gap(d, s);
                assert(imbalance <= im);
                if im == imbalance {
                    let dist = gap(price, ref_usd);
                    assert(distance <= dist);
                    if dist == distance {
                        assert(p_star <= price);
                    }
                }
            }
        }
    }
    assert(crossed_qty == volume);

    // 3. fills: strictly better orders first, then the orders at p*
    let mut better: [u128; N] = [0; N];
    let mut at: [u128; N] = [0; N];
    let mut buy_better: u128 = 0;
    let mut buy_at: u128 = 0;
    let mut sell_better: u128 = 0;
    let mut sell_at: u128 = 0;
    for i in 0..N {
        if buy[i] {
            if eff[i] > p_star {
                better[i] = size[i];
                buy_better += size[i];
            } else if eff[i] == p_star {
                at[i] = size[i];
                buy_at += size[i];
            }
        } else if eff[i] < p_star {
            better[i] = size[i];
            sell_better += size[i];
        } else if eff[i] == p_star {
            at[i] = size[i];
            sell_at += size[i];
        }
    }
    let buy_first = min(buy_better, volume);
    let sell_first = min(sell_better, volume);
    let f1 = allocate(better, buy, buy_better, sell_better, buy_first, sell_first, bonus1, cut1_rem, cut1_idx);
    let f2 = allocate(at, buy, buy_at, sell_at, volume - buy_first, volume - sell_first, bonus2, cut2_rem, cut2_idx);

    // 4. outputs, fees, roll or refund
    let mut fee_sum: u128 = 0;
    let mut paid: u128 = 0; // buyers' quote, rounded up
    let mut received: u128 = 0; // sellers' quote, rounded down
    for i in 0..N {
        let o = orders[i];
        let q = f1[i] + f2[i];
        let rest = o.qty - q;
        let roll = active[i] & (rest > 0) & o.roll & (o.rolls_left > 0);
        assert(rolls[i] == roll);
        if active[i] {
            let value = q * p_star;
            let (fill, left) = if o.buy {
                let pay = ceil_div(value, quote_usd);
                let fee = ceil_div(pay * fee_bps, BPS);
                paid += pay;
                fee_sum += fee;
                (note(o.owner, asset, q * unit, blind(o.salt, 0), o.label), o.lock - pay - fee)
            } else {
                let proceeds = value / quote_usd;
                let fee = ceil_div(proceeds * fee_bps, BPS);
                received += proceeds;
                fee_sum += fee;
                (note(o.owner, quote_token, (proceeds - fee) * quote_unit, blind(o.salt, 0), o.label), o.lock - q)
            };
            assert(fills[i] == fill);

            let residual = if roll {
                order(o.owner, asset, o.buy, rest, o.has_limit, o.limit_usd, o.roll, o.rolls_left - 1, left, blind(o.salt, 2), o.label, terms(o))
            } else if o.buy {
                note(o.owner, quote_token, left * quote_unit, blind(o.salt, 1), o.label)
            } else {
                note(o.owner, asset, left * unit, blind(o.salt, 1), o.label)
            };
            assert(residuals[i] == residual);
        } else {
            assert(fills[i] == 0);
            assert(residuals[i] == 0);
        }
    }

    // fees plus the buyer-ceil / seller-floor dust
    // ponytail: fee_blinding is the prover's; a third-party prover must hand it to the fee owner off chain.
    let fees = fee_sum + paid - received;
    assert(fee_note == note(fee_owner, quote_token, fees * quote_unit, fee_blinding, FEE_LABEL));
}

// --- tests: TSLA at ref $250, cap 5% (band $237.50–$262.50), quote TQ at $1.00, fee 5 bps ---

global TSLA: Field = 0xc9f9;
global TQ: Field = 0x7e;
global UNIT: u128 = 1000000000000;
global REF: u128 = 250000000;
global FEE_OWNER: Field = 424242;
global MAX: u128 = 0xffffffffffffffffffffffffffffffff;
global EMPTY: Order = Order {
    owner: 0, salt: 0, buy: false, qty: 0, has_limit: false, limit_usd: 0, roll: false, rolls_left: 0, lock: 0, label: 0,
    min_qty: 0, display: 0, peg: 0, rfq: 0,
};

fn limit(owner: Field, salt: Field, buy: bool, qty: u128, limit_usd: u128, roll: bool, rolls_left: u32, lock: u128) -> Order {
    Order {
        owner, salt, buy, qty, has_limit: limit_usd != 0, limit_usd, roll, rolls_left, lock, label: salt + 100, min_qty: 0,
        display: 0, peg: 0, rfq: 0,
    }
}

fn commit(o: Order) -> Field {
    order(o.owner, TSLA, o.buy, o.qty, o.has_limit, o.limit_usd, o.roll, o.rolls_left, o.lock, o.salt, o.label, terms(o))
}

/// Buy 3 @ $255 (lock $900), sell 2 @ $245 rolling, sell 2 at-auction. V is 3 at $245 and $255 with the same imbalance
/// and distance to ref, so p* = $245 (the lower). The at-auction sell fills 2, the $245 sell 1 and rolls 1.
fn scenario() -> ([Order; N], [Field; N], [Field; N], [Field; N], [bool; N], Field) {
    let mut orders = [EMPTY; N];
    orders[0] = limit(11, 1, true, 3000000, 255000000, false, 0, 900000000);
    orders[1] = limit(12, 2, false, 2000000, 245000000, true, 3, 2000000);
    orders[2] = limit(13, 3, false, 2000000, 0, false, 0, 2000000);
    let mut commitments = [0; N];
    for i in 0..3 {
        commitments[i] = commit(orders[i]);
    }
    let mut fills = [0; N];
    let mut residuals = [0; N];
    let mut rolls = [false; N];
    // buyer: 3 at $245 = 735 TQ + 0.3675 fee from 900
    fills[0] = note(11, TSLA, 3000000 * UNIT, blind(1, 0), 101);
    residuals[0] = note(11, TQ, 164632500, blind(1, 1), 101);
    // $245 seller: 1 filled for 245 − 0.1225, 1 rolls with one roll fewer
    fills[1] = note(12, TQ, 244877500, blind(2, 0), 102);
    residuals[1] = order(12, TSLA, false, 1000000, true, 245000000, true, 2, 1000000, blind(2, 2), 102, terms(orders[1]));
    rolls[1] = true;
    // at-auction seller: 2 filled for 490 − 0.245
    fills[2] = note(13, TQ, 489755000, blind(3, 0), 103);
    residuals[2] = note(13, TSLA, 0, blind(3, 1), 103);
    let fee_note = note(FEE_OWNER, TQ, 735000, 777, 1);
    (orders, commitments, fills, residuals, rolls, fee_note)
}

fn run(p_idx: u32, p_star: u128, crossed: u128) {
    let (orders, commitments, fills, residuals, rolls, fee_note) = scenario();
    main(
        orders, p_idx, [false; N], [MAX, MAX], [0, 0], [false; N], [MAX, MAX], [0, 0], 777, TSLA, UNIT, TQ, 1, REF, 500,
        1000000, 5, p_star, crossed, commitments, fills, residuals, rolls, FEE_OWNER, fee_note,
    );
}

#[test]
fn clears_at_the_volume_maximizing_lower_price() {
    run(1, 245000000, 3000000);
}

#[test(should_fail)]
fn the_higher_tied_price_loses_the_tie_break() {
    run(0, 255000000, 3000000);
}

#[test(should_fail)]
fn a_band_edge_with_less_volume_is_not_p_star() {
    run(64, 237500000, 2000000);
}

#[test(should_fail)]
fn the_crossed_volume_must_be_the_maximum() {
    run(1, 245000000, 2000000);
}

#[test(should_fail)]
fn p_star_must_be_a_candidate() {
    run(1, 250000000, 3000000);
}

#[test]
fn nothing_crosses_without_overlap() {
    // a buy at $240 and a sell at $260: V = 0 everywhere, every order is refunded in full
    let mut orders = [EMPTY; N];
    orders[0] = limit(11, 1, true, 3000000, 240000000, false, 0, 900000000);
    orders[1] = limit(12, 2, false, 3000000, 260000000, false, 0, 3000000);
    let mut commitments = [0; N];
    let mut fills = [0; N];
    let mut residuals = [0; N];
    for i in 0..2 {
        commitments[i] = commit(orders[i]);
    }
    fills[0] = note(11, TSLA, 0, blind(1, 0), 101);
    residuals[0] = note(11, TQ, 900000000, blind(1, 1), 101);
    fills[1] = note(12, TQ, 0, blind(2, 0), 102);
    residuals[1] = note(12, TSLA, 3000000 * UNIT, blind(2, 1), 102);
    // candidates: 237.5 (D3 S0), 240 (D3 S0), 260 (D0 S3), 262.5 (D0 S3): all imbalance 3; 240 and 260 are 10 from ref
    // but 237.5 / 262.5 are 12.5 away, so p* = 240 (lower of the two closest)
    main(
        orders, 0, [false; N], [MAX, MAX], [0, 0], [false; N], [MAX, MAX], [0, 0], 777, TSLA, UNIT, TQ, 1, REF, 500, 1000000, 5,
        240000000, 0, commitments, fills, residuals, [false; N], FEE_OWNER, note(FEE_OWNER, TQ, 0, 777, 1),
    );
}
