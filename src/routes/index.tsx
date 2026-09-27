import { createFileRoute } from "@tanstack/react-router";
import Home from "@/pages/Home";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Luminary — The closing auction for tokenized stocks" },
      {
        name: "description",
        content:
          "Private orders. One clearing price. A public record. Luminary is a sealed call auction for tokenized stocks.",
      },
      { property: "og:title", content: "Luminary — The closing auction for tokenized stocks" },
      {
        property: "og:description",
        content: "Private orders. One clearing price. A public record.",
      },
    ],
  }),
  component: Home,
});
