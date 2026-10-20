# Security

Luminary runs on Robinhood Chain **mainnet** (chain 4663) and holds real value. This file lists who can do what, what
we accept and why, how we watch the system, and what we do when something goes wrong.

## Reporting a vulnerability

Report privately through GitHub's **private vulnerability reporting** on the public repository
(`luminaryRH/Luminary-stack` → Security → Report a vulnerability). Please do not open a public issue. Include the
contract or file, the steps, and the impact you expect. We answer within 72 hours. Do not test against the live pool
with funds you do not own, and do not attack the RPC, the website or other users' accounts; a local fork
(`FORK_RPC_URL=… forge test`) reproduces the deployment.

## Scope

In scope: `contracts/src`, `circuits/`, `src/server/luminary`, `src/routes/api`, `src/shielded`,
`supabase/migrations`, the deploy and check scripts. The frontend UI and the test mocks (`contracts/test/mocks`) are
out of scope. Each audit run's grade and findings are in `.audit-grade/`.

## Privileged roles

Nothing is upgradeable: no proxies, no `delegatecall`, no initializers. `contracts/deployments/4663.json` lists the
addresses; `contracts/deployments/4663-readback.txt` is the latest dated read-only check of them on chain.

- **Owner** of AuctionPool and ScreeningGate: an OpenZeppelin `TimelockController` with a **48-hour** minimum delay.
  It is its own admin, so its roles and its delay change only through the same 48 hours.
- **The Safe** (2-of-3, SafeL2 v1.4.1): the timelock's only proposer, canceller and executor, and the pool's guardian.
- **Operator** (hot EOA in the server environment, `OPERATOR_PRIVATE_KEY`): AuctionPool scheduler and ScreeningGate
  poster only. It owns nothing.
- **Deployer**: a fresh key that held every role only during the deploy transaction sequence and renounced them all
  (PostDeployCheck verifies it holds none).

| Contract | Function | Who | What it can do | Bounds |
| --- | --- | --- | --- | --- |
| AuctionPool | `setMarket` | owner (48 h) | list, delist (halt) or re-point a market's price feed, band and staleness limit | unit fixed once set, band ≤ 20%, staleness 1 s to 26 h, feed ≠ 0 |
| AuctionPool | `setMinLock` | owner (48 h) | smallest lock an order may carry | < 2^64, listed tokens only |
| AuctionPool | `setScheduler` | owner (48 h) | who schedules calendar auctions | — |
| AuctionPool | `setDesk` | owner | the RfqDesk | **once** (done at deploy); never replaceable |
| AuctionPool | `setFee` | owner (48 h) | settlement fee, for auctions scheduled afterwards; the fee-note owner, read at settlement, so it also applies to auctions already scheduled | ≤ 1% |
| AuctionPool | `setDepositFee` | owner (48 h) | ETH fee per deposit | ≤ 0.001 ETH |
| AuctionPool | `setDepositsPaused` | owner (48 h) | pause or resume deposits | deposits only; every exit stays open |
| AuctionPool | `setGuardian` | owner (48 h) | who may stop deposits or a market at once | — |
| AuctionPool | `pauseDeposits`, `haltMarket` | guardian (the Safe), owner | stop deposits / delist one stock market **at once** | stops only; resuming needs the owner. The quote (USDG) is never listed, so `haltMarket(USDG)` reverts: for a USDG problem, halt every stock market |
| AuctionPool | `setGate` | owner (48 h) | the screening gate | the ragequit never calls it |
| AuctionPool | `transferOwnership` / `acceptOwnership` | owner → new owner | two-step ownership move | — |
| AuctionPool | `schedule` (non-RFQ) | scheduler (operator) | create calendar auctions | listed market, future call |
| AuctionPool | `settleAuction` with `excluded ≠ 0` | scheduler (operator) | leave an order whose sealed copy does not open out of a settlement | the order stays reclaimable by its owner |
| RfqDesk | — | nobody | no owner; opens RFQ auctions for anyone and settles them with a proof | — |
| ScreeningGate | `setBlocked`, `setSanctions` | owner (48 h) | block deposits from addresses / plug a sanctions oracle | deposits only |
| ScreeningGate | `setAssociationRequired` | owner (48 h) | require an association proof for value leaving the pool (on at deploy) | the ragequit is never affected |
| ScreeningGate | `postAssociationRoot` | poster (operator), owner | publish the association set root | root < field |
| ScreeningGate | `setPoster`, ownership | owner (48 h) | who posts roots | — |
| TimelockController | `schedule`, `execute`, `cancel` | the Safe | queue an owner call, run it after 48 h, cancel it | delay ≥ 48 h |
| PrintRegistry | `setWriter` | deployer, once | wire the AuctionPool | once (done at deploy) |

Off chain the operator also holds `SEAL_KEY` (opens sealed orders), `FEE_SECRET` (fee-note blindings), the database
credentials, `CRON_SECRET` and `CHAINALYSIS_API_KEY`.

**What no role can do:** move a user's notes, mint notes (the desk is fixed and settles only with a proof), change a
clearing away from the published rule, set a price (the pool reads Chainlink), block a cancel before the call, a
reclaim of a voided or left-out order, an abandon after the settle deadline, or a ragequit.

## Ownership as deployed

`contracts/script/Deploy.s.sol` does all of this in one run, and `PostDeployCheck.s.sol` verifies it on chain:

1. A fresh deployer key deploys; it holds nothing afterwards.
2. A 2-of-3 Safe (official SafeL2 v1.4.1 through the official factory) controls a 48-hour OpenZeppelin
   `TimelockController`, which owns AuctionPool and ScreeningGate (ownership accepted through the timelock).
3. The hot operator key keeps only operational roles: AuctionPool `scheduler` and ScreeningGate `poster`. A leaked
   operator key can schedule auctions and post association roots, both watched (see Monitoring); removing it takes
   the timelock.
4. Prices come from the Chainlink feeds on Robinhood Chain (each updates on a 0.5% move and at least every 24 hours);
   each market's staleness limit is the heartbeat plus an hour, 25 hours.
5. The Safe is the guardian: it can pause deposits or halt a market immediately; resuming waits 48 hours.

Next: move each Safe signer to its own hardware wallet (Safe → Settings → swap owner; no redeploy), and switch the
clearing key to the threshold committee (`COMMITTEE`) once members run `scripts/committee-member.ts`.

## Accepted risks

These are known, documented and accepted at launch. Each names what would change it.

1. **One key opens every order** (`offchain-backend|src/server/luminary/pool/committee.ts|single-key-custody`).
   The 1-of-1 clearing committee means the operator sees every order before the call and could trade on it in the
   same auction. The order dialog says so. Changes when committee members run `scripts/committee-member.ts` and
   `COMMITTEE` is set (built and tested end to end; settlement then waits for the members' partials). Members trust the
   operator for nothing: each checks on its own RPC that the auction is pinned, that the ciphertext is the one an
   `OrderResting` event of that auction carries, and that the order's envelope proves knowledge of the ciphertext's
   ephemeral key (a Schnorr proof bound to the chain, the pool, the auction and the order's commitment). A partial
   depends only on that key, so this is what stops a copy of someone's ciphertext, or a related key, placed in an
   auction that pins earlier, including by the operator acting as relayer, which sees relayed orders before they are on
   chain: only the sealer knows the key, so only the sealer's own order gets partials, and copying gains nothing and
   costs the original nothing. A rolled order has no ciphertext on chain, so in committee mode it is left out of the
   next settlement and its owner reclaims the lock (rolls work again once the roll re-seals on chain).
2. **Some actions are linked to the user's wallet** (`zk-privacy|src/shielded/client.ts|wallet-linked-submissions`).
   Token withdrawals, reclaims, ragequits and RFQ opens are sent from the user's wallet, because the relayer is paid
   in ETH only. They reveal that this wallet acted, not what it holds. Deposits are public by nature. Relayed ETH
   transactions and orders are not linked. Changes when the relayer accepts token fees.
3. **The Safe's three signer keys start on one machine** (`deploy-verification|contracts/script/deploy.s.sol|safe-signers-colocated`).
   At launch the 2-of-3 Safe's keys were generated together and are kept on one computer, so one compromise of that
   machine gives an attacker a quorum. What bounds it: whoever controls the Safe still waits 48 hours for every owner power, each
   queued call is alerted at once, and no owner power can block an exit, so users have two days to leave; at once they
   can only stop deposits or halt markets (the guardian powers). Changes when each signer moves to its own hardware
   wallet.
4. **Screening depends on an outside API** (`offchain-backend|src/server/luminary/pool/association.ts|screening-api-dependency`).
   Robinhood Chain has no on-chain sanctions oracle, so the association publisher screens depositors with Chainalysis's
   free sanctions API. It fails closed (an unscreened depositor is not approved and can only ragequit) and re-checks
   every 24 hours; an outage delays approvals. A depositor sanctioned after approval stays approved until the next
   successful check (an API error keeps the last verdict, so through an outage longer than a day), and a label
   removed from the set still proves against the gate's previous roots (it keeps the last eight) until newer roots
   replace them, which happens only when the set changes. The gate's blocklist (owner, 48 h) is the on-chain backstop.
5. **An issuer burn from the pool makes it short** (`rwa-tokenized-stocks|contracts/src/auctionpool.sol|forced-burn-insolvency`, Low).
   The stock issuer can `adminBurn` from any address. The pool cannot prevent it and does not reconcile balances, so
   the last withdrawers of that asset would bear it. Runbook below: halt the market at once.
6. **Ex-date pauses are entered by hand** (`rwa-tokenized-stocks|src/server/luminary/calendar.ts|exdate-pause-gaps`, Low).
   The calendar's corporate-action table is manual. The pool itself voids any auction whose token's share multiplier
   is not one or changes before settlement, so a missed entry voids auctions instead of mispricing them.
7. **Filling an auction still costs only capital** (`evm-stack|contracts/src/auctionpool.sol|per-asset-order-cap-dos`;
   the id is older than the code: the limit is per auction, 64 orders, and per RFQ block, 2). Cancelled slots are reused, each order locks at least the market minimum (0.05 share or 25 USDG), and the operator
   rolls leftovers into the next auction only while they take at most half its slots (otherwise every leftover is
   refunded). Holding one auction's 64 slots still takes 64 placements (a proof and a transaction each) and about
   $1,600 locked, all of it refundable, and the attacker can cancel before the call so the auction voids. A flooded
   roll target also turns the operator's rolls into refunds. No funds are lost and exits stay open. Raising the minimums
   (`setMinLock`, 48 h) raises the cost; a fee per placement kept on cancel would close it but needs a new pool.
8. **An issuer freeze is caught off chain after the pin**
   (`rwa-tokenized-stocks|contracts/src/auctionpool.sol|issuer-freeze-no-halt`). `pin` voids an auction of a paused
   token on chain. A pause that lands between pin and settlement, or a registry block on the pool address, is caught by
   the operator: before settling it checks that both tokens can still leave the pool (a zero transfer from the pool),
   and if not it does not settle, so the auction is abandoned and every lock reclaimed. A third party holding every
   opening could still settle such an auction; the runbook halts the market.
9. **Orders placed while their deposit was approved keep trading after it is removed**
   (`evm-stack|contracts/src/auctionpool.sol|association-bypass-via-auction`, Low). Association is proven at placement;
   a resting or rolling order is not re-checked. Each cross moves at most the band (5%) of its notional to a
   counterparty, and the order's own value keeps its label.
10. **Value received by private transfer exits through its sender's deposit**
    (`studio-policy|contracts/src/auctionpool.sol|exit-gated-by-owner-gate`, residual Low). The ragequit pays only the
    depositor of a note's label. A note someone else sent you carries the sender's label, so while association is
    required and your label is not approved, that value can leave only back to the sender (or by the screened path).
11. **The operator chooses which unreadable orders to leave out** (new with `Clearing.excluded`, Low). A scheduler can
    also leave out orders that do open, shifting `p*` within the band for the rest. Those owners lose the execution,
    never the lock (they reclaim it). It is part of trusting the operator with the clearing key (risk 1).
12. **Smaller off-chain residuals (Low):** the event API reads up to 5,000 rows before cutting the response at 2.5 MB
    (`offchain-backend|src/routes/api/pool_.events.ts|unbounded-response`); fresh RFQ keys pass the per-key limit,
    within the global limits (`offchain-backend|src/routes/api/rfq.ts|unauthenticated-spam`); sealed plaintexts are
    padded to 512-byte blocks, so an order opening falls in one of two sizes
    (`zk-privacy|src/shielded/orders.ts|ciphertext-length-leak`); Lovable's own packages are exempt from the 3-day
    release cooldown (`supply-chain-ci|bunfig.toml|install-controls-partial`).

Closed with the mainnet deploy: the hot-EOA owner that also priced the market (now a 48-hour timelock under the
Safe, and Chainlink prices) and the note tree's 2^20-leaf limit (trees now roll over; every root of a full tree stays
valid).

## Leaked secret record

- **GitHub token in `GITHUB_SETUP.md` (commit `7b4eaa8`, 2026-09-28).** A classic personal access token for the
  `luminaryRH` account was committed. It was removed from the tree on 2026-10-16 (`23c29a2`), publishing now reads a
  fine-grained `GH_TOKEN` from the environment, and gitleaks runs in CI. **Revoked 2026-10-18** by the account owner
  (verified the same day: GitHub answers the old token with HTTP 401). The history entry is allow-listed in
  `.gitleaksignore` because the dead token stays in history (AGENTS.md forbids rewriting pushed history).

No other secret has ever been committed (gitleaks over the full history in CI). `.env*` files are ignored;
`.env.example` lists names only. Mainnet keys live outside the repository.

## Monitoring

`src/server/luminary/alerts.ts` runs every 5 minutes (the `nav` cron) and posts to `ALERT_WEBHOOK_URL` (Telegram
bot in production; without it alerts go to the function log):

- anything the Safe queues, executes or cancels on the timelock (a queued call is alerted 48 hours before it can run),
  any change to the timelock's roles or delay, and any change to the Safe's signers, threshold, guard or modules;
- any admin event on AuctionPool, ScreeningGate or RfqDesk (ownership, markets and halts, minimum locks, fees, pause,
  guardian, gate, desk, scheduler, association requirement, poster, sanctions, blocklist);
- a single outflow of 10,000 tokens or more;
- the operator's ETH below 0.002 (relays, pins and settlements stop without gas);
- an auction voided while holding orders: its price was older than its market's limit, its token was halted, paused
  or re-scaled, or nobody settled it in time;
- a worker step that has not run for 15 minutes.

`/api/status` shows every worker step (including screening errors), the operator balance and the latest errors
(redacted).

## Incident runbook

Owner on call: the repository owner. Keep the Safe signers, the Vercel project and the Supabase project reachable
from one place.

| Situation | First action (minutes) | Then |
| --- | --- | --- |
| Suspected contract bug | From the Safe: `pauseDeposits()` and `haltMarket(token)` for each market (immediate) | Exits stay open by design. Fix, redeploy, and tell users to withdraw or ragequit from the old pool |
| A call you did not expect is queued on the timelock | From the Safe: `cancel(id)` on the timelock | Find out who signed it; rotate the Safe signers |
| Operator key leaked | Rotate `OPERATOR_PRIVATE_KEY` in Vercel, sweep the old key's ETH | Queue `setScheduler(old, false)` and `setPoster(new)` through the Safe → timelock; meanwhile watch for unexpected association roots and auctions |
| `SEAL_KEY` leaked | Orders are readable by the leaker; nothing can be stolen with it | Deploy a new sealing key (`SEAL_PUBLIC`), tell users resting orders were exposed |
| Price feed wrong or stale | Stale rounds void auctions by themselves; for a wrong price, `haltMarket(token)` from the Safe | Queue a `setMarket` with a corrected feed through the timelock |
| Issuer pauses, blocks the pool or burns from it | `haltMarket(token)` from the Safe: no new orders, pins void | Tell holders; withdrawals of that token revert until the issuer lifts it |
| Screening API down or key missing | Nothing is lost: new depositors wait (ragequit stays open) | Check `/api/status`; renew `CHAINALYSIS_API_KEY` |
| Workers down | Nothing is at risk: auctions void or are abandoned after an hour and every lock is reclaimable | Check `/api/status`, Vercel logs, Supabase `pg_cron` |

## Static analysis triage

CI runs Slither 0.11.6 (`--fail-high`) on the core contracts, Semgrep on the server code and gitleaks on the full
history. Excluded Slither detectors, triaged:

- `arbitrary-send-eth`: `_pay` sends only to a recipient or relayer bound into the proof's context.
- `reentrancy-*`: every value-moving entry point is `nonReentrant` (a transient-storage lock); `reclaim`,
  `advanceTree`, `pin` and `abandon` make no external call that could re-enter with a benefit (verifier and price
  reads only).
- `incorrect-equality`, `timestamp`: intended (exact flags and call times; the chain's timestamp is the clock).
- `unused-return`: `latestRoundData`'s unused round fields and `markets()`'s unused fields.
