import { createFileRoute } from "@tanstack/react-router";
import EditorialPage from "@/components/editorial-page";

export const Route = createFileRoute("/auctions")({
  head: () => ({
    meta: [
      { title: "The rhythm — Luminary" },
      {
        name: "description",
        content: "Open. Close. Midnight. The daily rhythm of Luminary's scheduled call auctions.",
      },
      { property: "og:title", content: "The rhythm — Luminary" },
      { property: "og:description", content: "Open. Close. Midnight." },
    ],
  }),
  component: () => <EditorialPage kind="auctions" />,
});
