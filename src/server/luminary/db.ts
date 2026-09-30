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
    // one JSON text column: the result never depends on the driver's array or type parsing
    s = sql()`select json_build_object('names', coalesce(proargnames, '{}'), 'types', string_to_array(oidvectortypes(proargtypes), ', '),
                                       'ret', prorettype::regtype::text)::text as sig
              from pg_proc where proname = ${fn} and pronamespace = 'public'::regnamespace`.then(([row]) => {
      if (!row) throw new DbError(`no function ${fn}`, undefined);
      const sig = JSON.parse(row.sig as string) as { names: string[]; types: string[]; ret: string };
      return { types: new Map(sig.names.map((n, i) => [n, sig.types[i]!])), ret: sig.ret };
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
  // every argument travels as text (JSON for jsonb and arrays) and is cast in SQL, independent of driver type inference
  const param = (n: string, i: number) => {
    const type = types.get(n) ?? "text";
    if (type.endsWith("[]")) return `${n} => array(select jsonb_array_elements_text($${i + 1}::text::jsonb))::${type}`;
    return `${n} => $${i + 1}::text::${type}`;
  };
  const value = (n: string) => {
    const v = args[n];
    if (v === null || v === undefined) return null;
    return types.get(n) === "jsonb" || types.get(n)?.endsWith("[]") ? JSON.stringify(v) : String(v);
  };
  const call = `${fn}(${names.map(param).join(", ")})`;
  try {
    const rows = await sql().unsafe(ret === "void" ? `select ${call}` : `select to_jsonb(${call})::text as r`, names.map(value) as never[]);
    return (ret === "void" ? null : JSON.parse(rows[0]!.r as string)) as T;
  } catch (e) {
    const err = e as { message?: string; code?: string };
    throw new DbError(err.message ?? String(e), err.code);
  }
}
