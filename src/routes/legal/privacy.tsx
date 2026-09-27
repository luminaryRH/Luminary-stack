import { createFileRoute } from "@tanstack/react-router";
import LegalPage from "@/components/legal-page";

export const Route = createFileRoute("/legal/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy notice — Luminary" },
      {
        name: "description",
        content:
          "How Luminary handles data: your portfolio stays in this browser's storage.",
      },
      { property: "og:title", content: "Privacy notice — Luminary" },
      { property: "og:description", content: "Your portfolio stays in this browser." },
    ],
  }),
  component: () => <LegalPage kind="privacy" />,
});
