import { tmpdir } from "node:os";
import { join } from "node:path";

// bb.js caches its proving setup (CRS) under $HOME by default; serverless home directories are read-only, /tmp is not.
process.env["CRS_PATH"] ??= join(tmpdir(), "bb-crs");

/** Server-only env read. Throws when a required variable is missing. */
export function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}
