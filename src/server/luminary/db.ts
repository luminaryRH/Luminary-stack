import postgres from "postgres";
import { env } from "./env";

export class DbError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
  }
}

let client: postgres.Sql | undefined;

/** DATABASE_URL, moved to Supabase's transaction pooler (6543), which suits short serverless invocations. */
function sql(): postgres.Sql {
  client ??= postgres(env("DATABASE_URL").replace(/:5432\//, ":6543/"), { ssl: "require", prepare: false, max: 3, onnotice: () => {} });
  return client;
}

const signatures = new Map<string, Promise<{ types: Map<string, string>; ret: string }>>();

function signature(fn: string) {
  let s = signatures.get(fn);
  if (!s) {
    s = sql()`select coalesce(proargnames, '{}') as names, string_to_array(oidvectortypes(proargtypes), ', ') as types, prorettype::regtype::text as ret
              from pg_proc where proname = ${fn} and pronamespace = 'public'::regnamespace`.then(([row]) => {
      if (!row) throw new DbError(`no function ${fn}`, undefined);
      return { types: new Map((row.names as string[]).map((n, i) => [n, (row.types as string[])[i]!])), ret: row.ret as string };
    });
    s.catch(() => signatures.delete(fn));
    signatures.set(fn, s);
  }
  return s;
}

/**
 * Calls a lum_* SQL function with named arguments and returns its value as JSON (bigint and numeric come back as
 * numbers, void as null), the same shape PostgREST returned.
 */
export async function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { types, ret } = await signature(fn);
  const names = Object.keys(args);
  const call = `${fn}(${names.map((n, i) => `${n} => $${i + 1}::${types.get(n) ?? "text"}`).join(", ")})`;
  try {
    const rows = await sql().unsafe(ret === "void" ? `select ${call}` : `select to_jsonb(${call}) as r`, names.map((n) => args[n] ?? null) as never[]);
    return (ret === "void" ? null : rows[0]!.r) as T;
  } catch (e) {
    const err = e as { message?: string; code?: string };
    throw new DbError(err.message ?? String(e), err.code);
  }
}
