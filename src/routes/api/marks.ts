import { createFileRoute } from "@tanstack/react-router";
import { rpc } from "@/server/luminary/db";
import { handle, ok } from "@/server/luminary/http";

// The latest reference marks (micro-USD per token), read from the Chainlink feeds every 5 minutes.
export const Route = createFileRoute("/api/marks")({
  server: {
    handlers: {
      GET: () =>
        handle(async () => {
          const res = ok(await rpc<unknown>("lum_marks_latest", {}));
          res.headers.set("Cache-Control", "public, max-age=30");
          return res;
        }),
    },
  },
});
