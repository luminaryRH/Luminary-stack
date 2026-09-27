import { createFileRoute } from "@tanstack/react-router";
import EditorialPage from "@/components/editorial-page";

export const Route = createFileRoute("/technology")({
  head: () => ({
    meta: [
      { title: "The technology — Luminary" },
      {
        name: "description",
        content: "The architecture behind every Luminary call: sealed intent, clearing, settlement.",
      },
      { property: "og:title", content: "The technology — Luminary" },
      { property: "og:description", content: "The architecture behind every call." },
    ],
  }),
  component: () => <EditorialPage kind="technology" />,
});
