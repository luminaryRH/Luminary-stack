import { createFileRoute } from "@tanstack/react-router";
import { fail, handle, ok, readJson } from "@/server/luminary/http";
import { acceptPartials, committee, pendingForCommittee } from "@/server/luminary/pool/committee";
import type { Partial } from "@/shielded/committee";

const MAX_ITEMS = 256;
const MAX_SEALED_HEX = 2 + 2 * 8_192;

// Committee members (scripts/committee-member.ts). GET: every order ciphertext of a pinned auction that still lacks
// `threshold` partials (ciphertexts are public on chain already). POST { items: [{ sealed, partial }] }: a member's
// partial decryptions; each carries a Chaum-Pedersen proof against the member's public share, so no login is needed and
// a forged partial is dropped. 404 while the operator opens orders alone (no COMMITTEE).
export const Route = createFileRoute("/api/pool_/partials")({
  server: {
    handlers: {
      GET: () => handle(async () => (committee() ? ok({ pending: await pendingForCommittee() }) : fail("no committee", 404))),
      POST: ({ request }) =>
        handle(async () => {
          if (!committee()) return fail("no committee", 404);
          const items = (await readJson(request))["items"];
          if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) return fail(`items must be 1 to ${MAX_ITEMS} partials`);
          const valid = items.filter(
            (x): x is { sealed: string; partial: Partial } =>
              typeof x?.sealed === "string" && /^0x[0-9a-fA-F]+$/.test(x.sealed) && x.sealed.length <= MAX_SEALED_HEX && typeof x?.partial === "object" && x.partial !== null,
          );
          const r = await acceptPartials(valid);
          return ok({ accepted: r.accepted, rejected: r.rejected + items.length - valid.length });
        }),
    },
  },
});
