import { createHash, timingSafeEqual } from "node:crypto";
import { rpc } from "./db";
import { env } from "./env";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Supabase pg_cron (through pg_net) sends `x-cron-secret: $CRON_SECRET`; `Authorization: Bearer` works for manual runs. */
export function isCronAuthorized(request: Request): boolean {
  const secret = env("CRON_SECRET");
  const header = request.headers.get("x-cron-secret") ?? "";
  const bearer = request.headers.get("authorization") ?? "";
  return timingSafeEqual(digest(header), digest(secret)) || timingSafeEqual(digest(bearer), digest(`Bearer ${secret}`));
}

type StepResult = Record<string, unknown>;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const statusOf = (r: StepResult) => ("error" in r ? "error" : "waiting" in r ? "waiting" : "ok");
const STALLED_RUNS = { error: 5, waiting: 30 } as const;

/**
 * Runs a worker's steps in order (a failing step never stops the next) and records one lum_cron_runs row per step.
 * A step stalled for many runs in a row is logged, and shows on /api/status.
 */
export async function runJob(job: string, steps: Record<string, () => Promise<StepResult>>) {
  const out: Record<string, StepResult> = {};
  const log: { step: string; status: string; ms: number; detail: StepResult }[] = [];
  for (const [step, run] of Object.entries(steps)) {
    const started = Date.now();
    const result = await run().catch((e) => ({ error: errText(e) }));
    out[step] = result;
    log.push({ step, status: statusOf(result), ms: Date.now() - started, detail: result });
  }
  const streaks = await rpc<Record<string, number>>("lum_cron_log", { p_job: job, p_steps: log }).catch((e) => {
    console.error("cron log failed", errText(e));
    return {};
  });
  for (const [step, runs] of Object.entries(streaks)) {
    const status = statusOf(out[step]!) as "error" | "waiting";
    if (runs >= STALLED_RUNS[status]) console.error(`worker ${job}/${step} has not completed for ${runs} runs`, out[step]);
  }
  return out;
}
