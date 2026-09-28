// Applies supabase/migrations/*.sql in order to DATABASE_URL (.env.local). Every migration is re-runnable; a file is
// applied again only when its content changed since the last run (recorded in lum_migrations).
// node --env-file=.env.local scripts/migrate.mjs
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const sql = postgres(url, { ssl: "require", max: 1, onnotice: () => {} });
try {
  await sql`create table if not exists lum_migrations (name text primary key, sha text not null, applied_at timestamptz not null default now())`;
  await sql`alter table lum_migrations enable row level security`;
  const done = new Map((await sql`select name, sha from lum_migrations`).map((r) => [r.name, r.sha]));
  for (const name of readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort()) {
    const text = readFileSync(`supabase/migrations/${name}`, "utf8");
    const sha = createHash("sha256").update(text).digest("hex");
    if (done.get(name) === sha) continue;
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into lum_migrations (name, sha) values (${name}, ${sha}) on conflict (name) do update set sha = excluded.sha, applied_at = now()`;
    });
    console.log(`migrate: applied ${name}`);
  }
  console.log("migrate: up to date");
} finally {
  await sql.end();
}
