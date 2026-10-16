import type { MetadataRoute } from "next";

// Installable web app (home screen / PWA). Icons are generated from the OPS logo into public/icons.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Genexa Operations",
    short_name: "Genexa Ops",
    description: "Genexa Scaling internal operating system",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#111110",
    theme_color: "#111110",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
