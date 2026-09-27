import { createFileRoute } from "@tanstack/react-router";
import LegalPage from "@/components/legal-page";

export const Route = createFileRoute("/legal/risks")({
  head: () => ({
    meta: [
      { title: "Risk & eligibility — Luminary" },
      {
        name: "description",
        content:
          "Risk and eligibility notes for Luminary. No real funds or settlement.",
      },
      { property: "og:title", content: "Risk & eligibility — Luminary" },
      { property: "og:description", content: "No real funds or settlement." },
    ],
  }),
  component: () => <LegalPage kind="risks" />,
});
