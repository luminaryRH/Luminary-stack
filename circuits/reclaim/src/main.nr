// ReclaimProof: an order's owner takes the lock back as a note — a cancel while its auction is still collecting, or a
// reclaim once the auction was voided or abandoned. Only the owner (owner key), only once (order nullifier), only the
// lock the order committed to, under the order's label. The side stays private: the refund note hides whether it holds
// the quote token or the asset.
use luminary::{OrderTerms, PLAIN, blind, note, order, order_nullifier, owner_pub};

fn main(
    secret: Field,
    label: Field,
    buy: bool,
    qty: u128,
    has_limit: bool,
    limit_usd: u128,
    roll: bool,
    rolls_left: u32,
    lock: u128,
    salt: Field,
    asset: pub Field,
    unit: pub u128,
    quote_token: pub Field,
    quote_unit: pub u128,
    commitment: pub Field,
    spent: pub Field,
    refund: pub Field,
    terms: OrderTerms,
) {
    let owner = owner_pub(secret);
    assert(commitment == order(owner, asset, buy, qty, has_limit, limit_usd, roll, rolls_left, lock, salt, label, terms));
    assert(spent == order_nullifier(secret, commitment));
    let back = if buy {
        note(owner, quote_token, lock * quote_unit, blind(salt, 3), label)
    } else {
        note(owner, asset, lock * unit, blind(salt, 3), label)
    };
    assert(refund == back);
}

global TSLA: Field = 0xc9f9;
global TQ: Field = 0x7e;
global UNIT: u128 = 1000000000000;

#[test]
fn owner_reclaims_a_buy_lock() {
    let owner = owner_pub(42);
    let c = order(owner, TSLA, true, 3000000, false, 0, true, 11, 800000000, 5555, 7, PLAIN);
    let refund = note(owner, TQ, 800000000, blind(5555, 3), 7);
    main(42, 7, true, 3000000, false, 0, true, 11, 800000000, 5555, TSLA, UNIT, TQ, 1, c, order_nullifier(42, c), refund, PLAIN);
}

#[test]
fn owner_reclaims_a_sell_lock() {
    let owner = owner_pub(42);
    let c = order(owner, TSLA, false, 2000000, false, 0, false, 0, 2000000, 6666, 7, PLAIN);
    let refund = note(owner, TSLA, 2000000 * UNIT, blind(6666, 3), 7);
    main(42, 7, false, 2000000, false, 0, false, 0, 2000000, 6666, TSLA, UNIT, TQ, 1, c, order_nullifier(42, c), refund, PLAIN);
}

#[test(should_fail)]
fn a_buy_refund_is_in_the_quote() {
    let owner = owner_pub(42);
    let c = order(owner, TSLA, true, 3000000, false, 0, true, 11, 800000000, 5555, 7, PLAIN);
    let refund = note(owner, 0, 800000000, blind(5555, 3), 7);
    main(42, 7, true, 3000000, false, 0, true, 11, 800000000, 5555, TSLA, UNIT, TQ, 1, c, order_nullifier(42, c), refund, PLAIN);
}

#[test(should_fail)]
fn the_refund_keeps_the_label() {
    let owner = owner_pub(42);
    let c = order(owner, TSLA, false, 2000000, false, 0, false, 0, 2000000, 6666, 7, PLAIN);
    let refund = note(owner, TSLA, 2000000 * UNIT, blind(6666, 3), 8);
    main(42, 7, false, 2000000, false, 0, false, 0, 2000000, 6666, TSLA, UNIT, TQ, 1, c, order_nullifier(42, c), refund, PLAIN);
}

#[test(should_fail)]
fn another_key_cannot_reclaim() {
    let c = order(owner_pub(42), TSLA, true, 3000000, false, 0, true, 11, 800000000, 5555, 7, PLAIN);
    let refund = note(owner_pub(43), TQ, 800000000, blind(5555, 3), 7);
    main(43, 7, true, 3000000, false, 0, true, 11, 800000000, 5555, TSLA, UNIT, TQ, 1, c, order_nullifier(43, c), refund, PLAIN);
}
