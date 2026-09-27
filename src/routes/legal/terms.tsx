import { createFileRoute } from "@tanstack/react-router";
import LegalPage from "@/components/legal-page";

export const Route = createFileRoute("/legal/terms")({
  head: () => ({
    meta: [
      { title: "Terms of use — Luminary" },
      { name: "description", content: "Draft terms of use for the Luminary site." },
      { property: "og:title", content: "Terms of use — Luminary" },
      { property: "og:description", content: "Draft terms of use for Luminary." },
    ],
  }),
  component: () => <LegalPage kind="terms" />,
});
