// Association set publisher. The approved labels are the settlement fee label plus every deposit whose depositor
// passes screening: not sanctioned (Chainalysis's free sanctions API; Robinhood Chain has no on-chain sanctions oracle)
// and allowed by the screening gate (its blocklist). The operator (the gate's poster) publishes their root, and a
// withdrawal proves its label is in a recent root without saying which deposit it is. The list behind each root is
// kept so clients can build their membership path.
// Screening fails closed: a depositor is approved only after a clean check; without CHAINALYSIS_API_KEY, or while the
// API errs, a new depositor stays out (their deposit can always ragequit back to them). Verdicts are kept and
// re-checked every SCREEN_EVERY_SEC, so a passing outage does not drop depositors already approved.
import { FEE_LABEL, aspLeaf, hex, ready, rootOf } from "@/shielded/protocol";
import { rpc } from "../db";
import { GATE_ABI, gate } from "./contract";
import { sendOperator } from "./sends";

const SCREEN_EVERY_SEC = 24 * 3_600;
const MAX_CHECKS_PER_RUN = 40; // API calls per run; the rest are screened on the next runs
const SANCTIONS_API = "https://public.chainalysis.com/api/v1/address/";

export interface Association {
  root: string;
  labels: string[]; // decimal, in leaf order
}

interface Verdict {
  ok: boolean; // not sanctioned at `at`
  at: number; // unix seconds of the check
}

/** One address against the sanctions API: true when it has no sanctions identification. */
async function notSanctioned(address: string, key: string) {
  const res = await fetch(SANCTIONS_API + address, { headers: { "X-API-Key": key, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`sanctions API ${res.status}`);
  const body = (await res.json()) as { identifications?: unknown[] };
  if (!Array.isArray(body.identifications)) throw new Error("sanctions API: unexpected reply");
  return body.identifications.length === 0;
}

/** Screening verdicts for `addresses`: cached, refreshed when older than SCREEN_EVERY_SEC, missing when never checked. */
async function screen(addresses: string[]) {
  const now = Math.floor(Date.now() / 1000);
  const verdicts = (await rpc<Record<string, Verdict> | null>("lum_pool_get_state", { p_name: "screening" })) ?? {};
  const key = process.env["CHAINALYSIS_API_KEY"]?.trim();
  const due = addresses.filter((a) => !verdicts[a] || now - verdicts[a]!.at > SCREEN_EVERY_SEC).slice(0, MAX_CHECKS_PER_RUN);
  const errors: string[] = [];
  if (!key && due.length) errors.push(`CHAINALYSIS_API_KEY missing: ${due.length} depositor(s) not screened`);
  if (key) {
    for (const a of due) {
      try {
        verdicts[a] = { ok: await notSanctioned(a, key), at: now };
      } catch (e) {
        errors.push(`${a}: ${String((e as Error)?.message ?? e).slice(0, 80)}`); // keeps the last verdict, if any
      }
    }
    if (due.length) await rpc("lum_pool_put_state", { p_name: "screening", p_value: verdicts });
  }
  return { verdicts, errors };
}

/** Posts a new association root when the approved deposit labels changed (ScreeningGate.postAssociationRoot). */
export async function publishAssociation() {
  const g = gate();
  const deposits = await rpc<{ from: string; label: string }[]>("lum_pool_deposit_labels", {});
  const depositors = [...new Set(deposits.map((d) => d.from.toLowerCase()))];
  const { verdicts, errors } = await screen(depositors);
  // ponytail: one allowed() call per distinct depositor each run; cache verdicts per block once depositors number thousands.
  const allowed = new Map(await Promise.all(depositors.map(async (a) => [a, Boolean(await g.getFunction("allowed")(a))] as const)));
  const approved = (a: string) => verdicts[a]?.ok === true && allowed.get(a) === true;
  const labels = [FEE_LABEL, ...deposits.filter((d) => approved(d.from.toLowerCase())).map((d) => BigInt(d.label))];
  const report = { labels: labels.length, unscreened: depositors.filter((a) => !verdicts[a]).length, ...(errors.length ? { error: errors.join("; ").slice(0, 300) } : {}) };

  await ready();
  const root = hex(rootOf(labels.map(aspLeaf)));
  if (root === String(await g.getFunction("latestAssociationRoot")()).toLowerCase()) return { idle: true, ...report };
  // recorded first: clients only use a root once the gate has it
  await rpc("lum_pool_put_association", { p_root: root, p_labels: labels.map(String) });
  const tx = await sendOperator(await g.getAddress(), GATE_ABI.encodeFunctionData("postAssociationRoot", [root]), "association");
  return tx ? { posted: root, tx, ...report } : { waiting: "an operator transaction is still pending", ...report };
}

/** The newest recorded association whose root the gate currently accepts, or null. */
export async function currentAssociation(): Promise<Association | null> {
  const g = gate();
  for (const a of await rpc<Association[]>("lum_pool_recent_associations", { p_limit: 8 })) {
    if (await g.getFunction("isAssociationRoot")(a.root)) return a;
  }
  return null;
}
