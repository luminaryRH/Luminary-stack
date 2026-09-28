// Fails if the source project's name appears anywhere in tracked or untracked (non-ignored) files.
// The pattern is stored encoded so this file passes its own check.
import { spawnSync } from "node:child_process";

const pattern = Buffer.from("ZGFya1sgXy1dP3Bvb2x8KF58W15hLXowLTldKWRhcmtf", "base64").toString();
const r = spawnSync("git", ["grep", "--untracked", "-n", "-I", "-i", "-E", pattern], { encoding: "utf8" });
if (r.status === 0) {
  console.error("check-naming: banned name found:\n" + r.stdout);
  process.exit(1);
}
if (r.status !== 1) throw new Error(`check-naming: git grep failed: ${r.stderr}`);
console.log("check-naming: ok");
