// Schedules the workers with Supabase pg_cron + pg_net: each job GETs a /api/cron route with the x-cron-secret header.
// The secret is kept in Supabase Vault (read by the job at run time), never in git or in the job text. Re-runnable.
// node --env-file=.env.local scripts/schedule-crons.mjs [base URL, default https://luminariesrh.com]
import postgres from "postgres";

const base = (process.argv[2] ?? "https://luminariesrh.com").replace(/\/$/, "");
const JOBS = [
  ["lum-tick", "* * * * *", "/api/cron/tick"],
  ["lum-nav", "*/5 * * * *", "/api/cron/nav"],
  ["lum-calendar", "7 * * * *", "/api/cron/calendar"],
];

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", max: 1, onnotice: () => {} });
try {
  await sql`create extension if not exists pg_cron`;
  await sql`create extension if not exists pg_net`;
  const [existing] = await sql`select id from vault.secrets where name = 'lum_cron_secret'`;
  if (existing) await sql`select vault.update_secret(${existing.id}, ${process.env.CRON_SECRET})`;
  else await sql`select vault.create_secret(${process.env.CRON_SECRET}, 'lum_cron_secret')`;
  for (const [name, schedule, path] of JOBS) {
    const command = `select net.http_get(url := '${base}${path}',
      headers := jsonb_build_object('x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'lum_cron_secret')),
      timeout_milliseconds := 300000)`;
    await sql`select cron.schedule(${name}, ${schedule}, ${command})`;
    console.log(`scheduled ${name} ${schedule} → ${base}${path}`);
  }
} finally {
  await sql.end();
}
