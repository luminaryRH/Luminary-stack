import { createFileRoute } from "@tanstack/react-router";
import Dashboard from "@/components/dashboard";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Auction terminal — Luminary" },
      {
        name: "description",
        content:
          "The Luminary auction terminal: orders, clearing, treasury, RFQ and public prints on Robinhood Chain.",
      },
      { property: "og:title", content: "Auction terminal — Luminary" },
      { property: "og:description", content: "A sealed auction terminal on Robinhood Chain." },
    ],
  }),
  component: Dashboard,
});
