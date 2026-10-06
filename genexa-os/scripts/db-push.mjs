// Applies supabase/migrations to the hosted database.
// Usage: npm run db:push   (reads SUPABASE_DB_URL from .env.local)
import { spawnSync } from "node:child_process";

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL in .env.local (Supabase → Project Settings → Database → Connection string).");
  process.exit(1);
}
const result = spawnSync("npx", ["--yes", "supabase@latest", "db", "push", "--db-url", dbUrl, "--include-all"], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
