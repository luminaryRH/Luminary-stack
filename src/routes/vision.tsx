import { createFileRoute } from "@tanstack/react-router";
import EditorialPage from "@/components/editorial-page";

export const Route = createFileRoute("/vision")({
  head: () => ({
    meta: [
      { title: "The vision — Luminary" },
      {
        name: "description",
        content: "A foundation built to grow: where Luminary's sealed auction market goes next.",
      },
      { property: "og:title", content: "The vision — Luminary" },
      { property: "og:description", content: "A foundation built to grow." },
    ],
  }),
  component: () => <EditorialPage kind="vision" />,
});
