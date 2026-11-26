import type { MetadataRoute } from "next";

/**
 * Web app manifest (PWA-01). One stable application identity for both locales: `id` and
 * `start_url` carry no tenant, token or query. Launch resolves the session and locale on the
 * server. Installation never enables offline banking.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Al Qarib Corporate Banking (Sandbox)",
    short_name: "Al Qarib",
    description:
      "Al Qarib corporate banking sandbox. Simulated funds. A live connection is required: no banking data is available offline.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#F5F7FA",
    theme_color: "#10233F",
    lang: "en",
    dir: "auto",
    categories: ["finance", "business"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
