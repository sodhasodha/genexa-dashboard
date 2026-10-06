import type { NextConfig } from "next";

// Every page is per-user and reads live operational data, so nothing is
// prerendered or cached: Cache Components and partial prefetching stay off.
const nextConfig: NextConfig = {
  turbopack: {
    // This app lives inside the Life OS repo; without this Turbopack picks the
    // repo root and loads that app's PostCSS config.
    root: import.meta.dirname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
