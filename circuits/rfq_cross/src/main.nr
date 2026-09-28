// RfqCrossProof: an RFQ auction's two orders cross whole at the pinned reference, or both are refunded. They cross when
// both slots hold orders carrying the same non-zero rfq commitment, on opposite sides, of the same size, with no other
// terms, inside both limits at the reference, the buyer's lock paying for the block plus its fee and the seller's lock
// holding it. Each order gets a fill note (empty when nothing crosses) and a refund note of what its lock still holds;
// RFQ orders never roll. The fee note collects both fees plus the rounding dust.
use luminary::{FEE_LABEL, OrderTerms, blind, note, order};

global N: u32 = 2;
global BPS: u128 = 10000;
global MAX_PRICE: u128 = 0x1000000000000; // 2^48 micro-USD

pub struct Order {
    owner: Field,
    salt: Field,
    buy: bool,
    qty: u128,
    has_limit: bool,
    limit_usd: u128,
    roll: bool,
    rolls_left: u32,
    lock: u128,
    label: Field,
    min_qty: u128,
    display: u128,
    peg: u128,
    rfq: Field,
}

fn terms(o: Order) -> OrderTerms {
    OrderTerms { min_qty: o.min_qty, display: o.display, peg: o.peg, rfq: o.rfq }
}

fn ceil_div(a: u128, b: u128) -> u128 {
    (a + b - 1) / b
}

fn in_limit(o: Order, ref_usd: u128) -> bool {
    !o.has_limit | (if o.buy { ref_usd <= o.limit_usd } else { ref_usd >= o.limit_usd })
}

fn main(
    orders: [Order; N],
    fee_blinding: Field,
    asset: pub Field,
    unit: pub u128,
    quote_token: pub Field,
    quote_unit: pub u128,
    ref_usd: pub u128,
    quote_usd: pub u128,
    fee_bps: pub u128,
    crossed_qty: pub u128,
    commitments: pub [Field; N],
    fills: pub [Field; N],
    residuals: pub [Field; N],
    fee_owner: pub Field,
    fee_note: pub Field,
) {
    assert(fee_bps < BPS);
    assert((ref_usd > 0) & (ref_usd < MAX_PRICE));
    assert((quote_usd > 0) & (quote_usd < MAX_PRICE));
    for i in 0..N {
        let o = orders[i];
        if commitments[i] != 0 {
            assert(
                commitments[i]
                    == order(o.owner, asset, o.buy, o.qty, o.has_limit, o.limit_usd, o.roll, o.rolls_left, o.lock, o.salt, o.label, terms(o)),
            );
        }
    }

    let (a, b) = (orders[0], orders[1]);
    let (buyer, seller) = if a.buy { (a, b) } else { (b, a) };
    let q = buyer.qty;
    let pay = ceil_div(q * ref_usd, quote_usd);
    let buy_fee = ceil_div(pay * fee_bps, BPS);
    let proceeds = q * ref_usd / quote_usd;
    let sell_fee = ceil_div(proceeds * fee_bps, BPS);
    let plain_block = |o: Order| (o.rfq != 0) & (o.min_qty == 0) & (o.display == 0) & (o.peg == 0);
    let cross = (commitments[0] != 0) & (commitments[1] != 0) & plain_block(a) & plain_block(b) & (a.rfq == b.rfq)
        & (a.buy != b.buy) & (a.qty == b.qty) & in_limit(a, ref_usd) & in_limit(b, ref_usd)
        & (buyer.lock >= pay + buy_fee) & (seller.lock >= q);
    assert(crossed_qty == (if cross { q } else { 0 }));

    for i in 0..N {
        let o = orders[i];
        if commitments[i] != 0 {
            let (fill, left) = if !cross {
                (note(o.owner, if o.buy { asset } else { quote_token }, 0, blind(o.salt, 0), o.label), o.lock)
            } else if o.buy {
                (note(o.owner, asset, q * unit, blind(o.salt, 0), o.label), o.lock - pay - buy_fee)
            } else {
                (note(o.owner, quote_token, (proceeds - sell_fee) * quote_unit, blind(o.salt, 0), o.label), o.lock - q)
            };
            assert(fills[i] == fill);
            let back = if o.buy { note(o.owner, quote_token, left * quote_unit, blind(o.salt, 1), o.label) } else { note(o.owner, asset, left * unit, blind(o.salt, 1), o.label) };
            assert(residuals[i] == back);
        } else {
            assert(fills[i] == 0);
            assert(residuals[i] == 0);
        }
    }

    let fees = if cross { buy_fee + sell_fee + pay - proceeds } else { 0 };
    assert(fee_note == note(fee_owner, quote_token, fees * quote_unit, fee_blinding, FEE_LABEL));
}

global TSLA: Field = 0xc9f9;
global TQ: Field = 0x7e;
global UNIT: u128 = 1000000000000;
global BLOCK: Field = 424242;

fn block_order(owner: Field, salt: Field, buy: bool, qty: u128, limit_usd: u128, lock: u128, rfq: Field) -> Order {
    Order {
        owner, salt, buy, qty, has_limit: limit_usd != 0, limit_usd, roll: false, rolls_left: 0, lock, label: salt + 100, min_qty: 0,
        display: 0, peg: 0, rfq,
    }
}

fn commit(o: Order) -> Field {
    order(o.owner, TSLA, o.buy, o.qty, o.has_limit, o.limit_usd, o.roll, o.rolls_left, o.lock, o.salt, o.label, terms(o))
}

/// A 10-share block at the $250 reference: the buyer pays 2500 TQ + 1.25 fee, the seller gets 2500 − 1.25.
fn settle(seller_rfq: Field, crossed: u128, fills: [Field; 2], residuals: [Field; 2], fee: u128) {
    let orders = [block_order(11, 1, true, 10000000, 260000000, 3000000000, BLOCK), block_order(12, 2, false, 10000000, 0, 10000000, seller_rfq)];
    main(
        orders, 9, TSLA, UNIT, TQ, 1, 250000000, 1000000, 5, crossed, [commit(orders[0]), commit(orders[1])], fills, residuals,
        424242, note(424242, TQ, fee, 9, FEE_LABEL),
    );
}

#[test]
fn a_block_crosses_whole_at_the_reference() {
    settle(
        BLOCK,
        10000000,
        [note(11, TSLA, 10000000 * UNIT, blind(1, 0), 101), note(12, TQ, 2498750000, blind(2, 0), 102)],
        [note(11, TQ, 498750000, blind(1, 1), 101), note(12, TSLA, 0, blind(2, 1), 102)],
        2500000,
    );
}

#[test]
fn a_mismatched_block_refunds_both_sides() {
    settle(
        BLOCK + 1,
        0,
        [note(11, TSLA, 0, blind(1, 0), 101), note(12, TQ, 0, blind(2, 0), 102)],
        [note(11, TQ, 3000000000, blind(1, 1), 101), note(12, TSLA, 10000000 * UNIT, blind(2, 1), 102)],
        0,
    );
}

#[test(should_fail)]
fn a_mismatched_block_cannot_claim_a_cross() {
    settle(
        BLOCK + 1,
        10000000,
        [note(11, TSLA, 10000000 * UNIT, blind(1, 0), 101), note(12, TQ, 2498750000, blind(2, 0), 102)],
        [note(11, TQ, 498750000, blind(1, 1), 101), note(12, TSLA, 0, blind(2, 1), 102)],
        2500000,
    );
}
