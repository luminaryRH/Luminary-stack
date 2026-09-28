// OrderValidityProof: spends one note in a known root into an order lock for the auction's asset and returns the rest
// as change. A buy must spend a note of the auction's quote token, a sell a note of the asset — the side itself stays
// private (the change note hides which token it holds). A relayed order pays `fee` wei from a second, separate ETH note
// (so the fee never reveals the side); `context` binds chain, pool, auction, relayer and fee. With fee = 0 there is no
// fee note: fee_spent and fee_change are 0.
// Labels: the order and its change keep the order note's label (settlement passes it on to fills); the fee change keeps
// the fee note's label.
// Bounds keep every product in auction_clear inside u128, so no order can make an auction unprovable.
use luminary::{DEPTH, OrderTerms, PLAIN, note, nullifier, order, owner_pub, root_from_path};

global MIN_QTY: u128 = 1000;
global MAX_QTY: u128 = 0x100000000000000; // 2^56 micro-units
global MAX_PRICE: u128 = 0x1000000000000; // 2^48 micro-USD
global MAX_LOCK: u128 = 0x10000000000000000; // 2^64 micro-units
global MAX_ROLLS: u32 = 11;

fn main(
    secret: Field,
    label: Field,
    blinding: Field,
    note_amount: u128,
    leaf_index: u32,
    path: [Field; DEPTH],
    change_blinding: Field,
    fee_label: Field,
    fee_note_amount: u128,
    fee_blinding: Field,
    fee_index: u32,
    fee_path: [Field; DEPTH],
    fee_change_blinding: Field,
    buy: bool,
    qty: u128,
    has_limit: bool,
    limit_usd: u128,
    roll: bool,
    rolls_left: u32,
    lock: u128,
    salt: Field,
    root: pub Field,
    spent: pub Field,
    fee_spent: pub Field,
    change: pub Field,
    fee_change: pub Field,
    asset: pub Field, // the auction's asset
    unit: pub u128, // its base units per micro-unit
    quote_token: pub Field, // the auction's quote token
    quote_unit: pub u128,
    commitment: pub Field,
    fee: pub u128, // wei to the relayer
    context: pub Field,
    terms: OrderTerms,
) {
    let owner = owner_pub(secret);
    let note_asset = if buy { quote_token } else { asset };
    let input = note(owner, note_asset, note_amount, blinding, label);
    assert(root_from_path(input, leaf_index, path) == root);
    assert(spent == nullifier(secret, input, leaf_index));

    let locked = lock * (if buy { quote_unit } else { unit });
    assert(locked <= note_amount);
    assert(change == note(owner, note_asset, note_amount - locked, change_blinding, label));

    if fee == 0 {
        assert(fee_spent == 0);
        assert(fee_change == 0);
    } else {
        let fee_input = note(owner, 0, fee_note_amount, fee_blinding, fee_label);
        assert(root_from_path(fee_input, fee_index, fee_path) == root);
        assert(fee_spent == nullifier(secret, fee_input, fee_index));
        assert(fee_spent != spent);
        assert(fee <= fee_note_amount);
        assert(fee_change == note(owner, 0, fee_note_amount - fee, fee_change_blinding, fee_label));
    }

    assert((qty >= MIN_QTY) & (qty < MAX_QTY));
    assert((lock > 0) & (lock < MAX_LOCK));
    assert(limit_usd < MAX_PRICE);
    if !buy {
        assert(lock == qty);
    }
    assert(rolls_left <= (if roll { MAX_ROLLS } else { 0 }));
    if !has_limit {
        assert(limit_usd == 0);
    }
    // only the rfq term is in use; an rfq block order carries no other terms
    assert((terms.min_qty == 0) & (terms.display == 0) & (terms.peg == 0));
    assert(commitment == order(owner, asset, buy, qty, has_limit, limit_usd, roll, rolls_left, lock, salt, label, terms));
    let _ = context;
}

global TSLA: Field = 0xc9f9;
global TQ: Field = 0x7e;
global UNIT: u128 = 1000000000000;
global QUNIT: u128 = 1;
global L: Field = 31;
global FL: Field = 32;

/// Tree [order note (label L), ETH fee note (label FL)] for secret 42; returns root and both paths.
fn tree(asset: Field, amount: u128, fee_amount: u128) -> (Field, [Field; DEPTH], [Field; DEPTH], Field, Field) {
    let z = luminary::zeros();
    let mine = note(owner_pub(42), asset, amount, 77, L);
    let fee_note = note(owner_pub(42), 0, fee_amount, 88, FL);
    let (root, _) = luminary::append(z[DEPTH], 0, [0; DEPTH], [mine, fee_note], 2);
    let mut path = [0; DEPTH];
    let mut fee_path = [0; DEPTH];
    for i in 1..DEPTH {
        path[i] = z[i];
        fee_path[i] = z[i];
    }
    path[0] = fee_note;
    fee_path[0] = mine;
    (root, path, fee_path, mine, fee_note)
}

/// Places a buy (TQ note) or a sell (TSLA note), relayed with `fee` wei from the fee note when fee > 0.
fn place_with(buy: bool, note_asset: Field, note_amount: u128, lock: u128, qty: u128, fee: u128, fee_note_amount: u128, terms: OrderTerms) {
    let (root, path, fee_path, mine, fee_note) = tree(note_asset, note_amount, fee_note_amount);
    let owner = owner_pub(42);
    let unit = if buy { QUNIT } else { UNIT };
    let locked = lock * unit;
    let change = note(owner, note_asset, if note_amount >= locked { note_amount - locked } else { 0 }, 5, L); // failures come from main
    let (fee_spent, fee_change) = if fee == 0 {
        (0, 0)
    } else {
        (nullifier(42, fee_note, 1), note(owner, 0, if fee_note_amount >= fee { fee_note_amount - fee } else { 0 }, 6, FL))
    };
    let commitment = order(owner, TSLA, buy, qty, true, 250000000, true, 11, lock, 99, L, terms);
    main(
        42, L, 77, note_amount, 0, path, 5, FL, fee_note_amount, 88, 1, fee_path, 6, buy, qty, true, 250000000, true, 11, lock,
        99, root, nullifier(42, mine, 0), fee_spent, change, fee_change, TSLA, UNIT, TQ, QUNIT, commitment, fee, 123, terms,
    );
}

fn place(buy: bool, note_asset: Field, note_amount: u128, lock: u128, qty: u128, fee: u128, fee_note_amount: u128) {
    place_with(buy, note_asset, note_amount, lock, qty, fee, fee_note_amount, PLAIN);
}

#[test]
fn places_a_self_submitted_buy_from_a_quote_note() {
    place(true, TQ, 1000000000, 800000000, 3000000, 0, 0); // 3 TSLA, $800 of TQ locked
}

#[test]
fn places_a_relayed_sell_paying_the_fee_from_an_eth_note() {
    place(false, TSLA, 5000000000000000000, 2000000, 2000000, 400000000000000, 1000000000000000);
}

#[test]
fn places_an_rfq_block_order() {
    place_with(true, TQ, 1000000000, 800000000, 3000000, 0, 0, OrderTerms { min_qty: 0, display: 0, peg: 0, rfq: 424242 });
}

#[test(should_fail)]
fn a_buy_cannot_lock_eth() {
    place(true, 0, 1000000000, 800000000, 3000000, 0, 0);
}

#[test(should_fail)]
fn a_sell_cannot_lock_the_quote() {
    place(false, TQ, 5000000000000000000, 2000000, 2000000, 0, 0);
}

#[test(should_fail)]
fn cannot_lock_more_than_the_note() {
    place(true, TQ, 799999999, 800000000, 3000000, 0, 0);
}

#[test(should_fail)]
fn cannot_pay_more_fee_than_the_fee_note() {
    place(false, TSLA, 5000000000000000000, 2000000, 2000000, 1000000000000001, 1000000000000000);
}

#[test(should_fail)]
fn quantity_is_bounded() {
    place(false, TSLA, 0xffffffffffffffffffffffffffffffff, MAX_QTY, MAX_QTY, 0, 0);
}

#[test(should_fail)]
fn reserved_terms_stay_zero() {
    place_with(true, TQ, 1000000000, 800000000, 3000000, 0, 0, OrderTerms { min_qty: 1, display: 0, peg: 0, rfq: 0 });
}

#[test(should_fail)]
fn a_self_submitted_order_has_no_fee_note() {
    let (root, path, _, mine, fee_note) = tree(TQ, 1000000000, 1000000000000000);
    let owner = owner_pub(42);
    let change = note(owner, TQ, 200000000, 5, L);
    let commitment = order(owner, TSLA, true, 3000000, true, 250000000, true, 11, 800000000, 99, L, PLAIN);
    main(
        42, L, 77, 1000000000, 0, path, 5, FL, 0, 0, 0, [0; DEPTH], 0, true, 3000000, true, 250000000, true, 11, 800000000, 99,
        root, nullifier(42, mine, 0), nullifier(42, fee_note, 1), change, 0, TSLA, UNIT, TQ, QUNIT, commitment, 0, 123, PLAIN,
    );
}

#[test(should_fail)]
fn the_order_keeps_the_notes_label() {
    let (root, path, _, mine, _) = tree(TQ, 1000000000, 0);
    let owner = owner_pub(42);
    let change = note(owner, TQ, 200000000, 5, L);
    let commitment = order(owner, TSLA, true, 3000000, true, 250000000, true, 11, 800000000, 99, 9999, PLAIN);
    main(
        42, L, 77, 1000000000, 0, path, 5, FL, 0, 0, 0, [0; DEPTH], 0, true, 3000000, true, 250000000, true, 11, 800000000, 99,
        root, nullifier(42, mine, 0), 0, change, 0, TSLA, UNIT, TQ, QUNIT, commitment, 0, 123, PLAIN,
    );
}
