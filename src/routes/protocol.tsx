import { createFileRoute } from "@tanstack/react-router";
import EditorialPage from "@/components/editorial-page";

export const Route = createFileRoute("/protocol")({
  head: () => ({
    meta: [
      { title: "The protocol — Luminary" },
      {
        name: "description",
        content:
          "How a Luminary sealed call auction works: private orders, one clearing price, a public print.",
      },
      { property: "og:title", content: "The protocol — Luminary" },
      {
        property: "og:description",
        content: "Private orders, one clearing price, a public print.",
      },
    ],
  }),
  component: () => <EditorialPage kind="protocol" />,
});
