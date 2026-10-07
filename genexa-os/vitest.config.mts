import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Each SQL test file boots its own Postgres; more than a few at once starves them.
    maxWorkers: 3,
  },
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
});
