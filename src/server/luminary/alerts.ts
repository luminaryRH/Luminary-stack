// Monitoring (every 5 minutes, from the nav job): posts an alert to ALERT_WEBHOOK_URL when the Safe queues, executes or
// cancels anything on the timelock (48 hours before it can take effect), when the timelock's roles or delay or the
// Safe's signers or threshold change, when an admin power is used on the pool, gate or desk, when a large amount leaves
// the pool, when the operator wallet runs low on gas, when an auction holding orders is voided (a stale price, a
// halted or re-scaled token, or nobody settled it), or when a worker step has stalled. The runbook for each alert is
// in SECURITY.md. Without ALERT_WEBHOOK_URL it only logs.
import { Interface, formatEther } from "ethers";
import { provider } from "./chain";
import { rpc } from "./db";
import { deployment, operator, pool } from "./pool/contract";

const ADMIN = new Interface([
  "event OwnershipTransferStarted(address indexed from, address indexed to)",
  "event OwnershipTransferred(address indexed from, address indexed to)",
  "event MarketSet(address indexed token, address feed, uint256 unit, bool listed, uint256 capBps, uint256 maxAge)",
  "event MinLockSet(address indexed token, uint256 minLock)",
  "event FeeSet(bytes32 feeOwner, uint16 feeBps)",
  "event DepositsPausedSet(bool paused)",
  "event DepositFeeSet(address recipient, uint256 fee)",
  "event GateSet(address gate)",
  "event GuardianSet(address guardian)",
  "event DeskSet(address desk)",
  "event SchedulerSet(address indexed account, bool allowed)",
  "event AssociationRequiredSet(bool required)",
  "event PosterSet(address poster)",
  "event SanctionsSet(address sanctions)",
  "event Blocked(address indexed account, bool blocked)",
]);
// the owner chain: OpenZeppelin TimelockController and the Safe (v1.4.1) that controls it
const GOVERNANCE = new Interface([
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  "event Cancelled(bytes32 indexed id)",
  "event MinDelayChange(uint256 oldDuration, uint256 newDuration)",
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  "event AddedOwner(address indexed owner)",
  "event RemovedOwner(address indexed owner)",
  "event ChangedThreshold(uint256 threshold)",
  "event ChangedGuard(address indexed guard)",
  "event EnabledModule(address indexed module)",
]);
const VOIDED = new Interface(["event AuctionVoided(uint256 indexed id)"]);
const OUTFLOW = new Interface(["event Transacted(bytes32 indexed nullifier0, bytes32 indexed nullifier1, address indexed asset, address to, uint256 released, address relayer, uint256 fee, bytes memo)"]);

const LOW_GAS_WEI = 2_000_000_000_000_000n; // 0.002 ETH: about a day of settlements
const LARGE_OUTFLOW_UNITS = 10n ** 6n * 10_000n; // 10,000 tokens of a 6-decimal asset; 18-decimal assets scale below
const MAX_RANGE = 50_000;

interface AlertState {
  block: number;
  lowGasSent?: boolean;
}

async function post(lines: string[]) {
  if (lines.length === 0) return false;
  const text = `Luminary alert\n${lines.join("\n")}`;
  console.error(text);
  const url = process.env["ALERT_WEBHOOK_URL"]?.trim();
  if (!url) return false;
  // Slack/Discord/Telegram-bridge compatible body
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, content: text }), signal: AbortSignal.timeout(10_000) });
  return res.ok;
}

/** Checks the chain and the workers since the last run and posts any alert (see the header); returns what it saw. */
export async function watchAlerts() {
  const p = provider();
  const d = deployment();
  const head = await p.getBlockNumber();
  const state = (await rpc<AlertState | null>("lum_pool_get_state", { p_name: "alerts" })) ?? { block: head - 1 };
  const from = Math.max(state.block + 1, head - MAX_RANGE);
  const lines: string[] = [];

  if (from <= head) {
    const watched = [d.AuctionPool, d.ScreeningGate, d.RfqDesk];
    const adminTopics: string[] = [];
    ADMIN.forEachEvent((ev) => adminTopics.push(ev.topicHash));
    const logs = await p.getLogs({ address: watched, fromBlock: from, toBlock: head, topics: [adminTopics] });
    for (const l of logs) {
      const e = ADMIN.parseLog(l);
      if (e) lines.push(`admin: ${e.name}(${e.args.map(String).join(", ")}) on ${l.address} in tx ${l.transactionHash}`);
    }
    const govTopics: string[] = [];
    GOVERNANCE.forEachEvent((ev) => govTopics.push(ev.topicHash));
    const gov = await p.getLogs({ address: [d.owner, d.safe], fromBlock: from, toBlock: head, topics: [govTopics] });
    for (const l of gov) {
      const e = GOVERNANCE.parseLog(l);
      if (!e) continue;
      const what = e.name === "CallScheduled" ? `${e.name}: ${e.args[2]} call ${String(e.args[4]).slice(0, 10)}, executable in ${Number(e.args[6]) / 3600} h` : `${e.name}(${e.args.map(String).join(", ")})`;
      lines.push(`governance: ${what} on ${l.address} in tx ${l.transactionHash}`);
    }
    const outs = await p.getLogs({ address: d.AuctionPool, fromBlock: from, toBlock: head, topics: [OUTFLOW.getEvent("Transacted")!.topicHash] });
    for (const l of outs) {
      const e = OUTFLOW.parseLog(l)!;
      const asset = String(e.args[2]).toLowerCase();
      const scale = asset === "0x0000000000000000000000000000000000000000" || Object.entries(d.tokens).some(([s, t]) => t.toLowerCase() === asset && s !== "USDG") ? 10n ** 12n : 1n;
      const out = BigInt(e.args[4]) + BigInt(e.args[6]);
      if (out >= LARGE_OUTFLOW_UNITS * scale) lines.push(`large outflow: ${out} base units of ${asset} to ${e.args[3]} in tx ${l.transactionHash}`);
    }
    // an empty auction voids at every call; one holding orders voids only when its price was stale, its token was
    // halted, paused or re-scaled, or nobody settled it in time: each is worth a look
    const voids = await p.getLogs({ address: d.AuctionPool, fromBlock: from, toBlock: head, topics: [VOIDED.getEvent("AuctionVoided")!.topicHash] });
    for (const l of voids) {
      const id = VOIDED.parseLog(l)!.args[0] as bigint;
      const a = await pool().getFunction("auctions")(id);
      if (Number(a.live) > 0) lines.push(`auction #${id} voided with ${a.live} orders (stale price, halted or re-scaled token, or not settled in time) in tx ${l.transactionHash}`);
    }
  }

  const wei = await p.getBalance(operator().address);
  const low = wei < LOW_GAS_WEI;
  if (low && !state.lowGasSent) lines.push(`operator ${operator().address} holds ${formatEther(wei)} ETH (below ${formatEther(LOW_GAS_WEI)}): top it up, or relays, pins and settlements stop`);

  const cron = await rpc<Record<string, Record<string, { status: string; at: string }>>>("lum_cron_status", {});
  for (const [job, steps] of Object.entries(cron ?? {})) {
    for (const [step, r] of Object.entries(steps)) {
      const age = (Date.now() - Date.parse(r.at)) / 1000;
      if (job === "tick" && age > 15 * 60) lines.push(`worker tick/${step} has not run for ${Math.round(age / 60)} min`);
    }
  }

  const sent = await post(lines).catch((e) => (console.error("alert webhook failed", String(e)), false));
  // a webhook that failed keeps the cursor where it was, so the same alerts go out again next run
  const delivered = sent || lines.length === 0 || !process.env["ALERT_WEBHOOK_URL"]?.trim();
  const next: AlertState = delivered ? { block: head, lowGasSent: low } : state;
  await rpc("lum_pool_put_state", { p_name: "alerts", p_value: next });
  return { alerts: lines.length, sent, from, to: head };
}
