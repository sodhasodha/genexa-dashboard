/**
 * Run the Cortana sync from this machine (backfills, or a manual refresh).
 *   npm run sync:cortana -- --days 30
 */
import { createClient } from "@supabase/supabase-js";
import { createCortanaClient } from "../lib/integrations/cortana/client";
import { syncCortana } from "../lib/integrations/cortana/sync";

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
};
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

async function main() {
  const days = Number(arg("days") ?? 2);
  const db = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  const cortana = createCortanaClient({ apiKey: env("CORTANA_API_KEY"), baseUrl: process.env.CORTANA_BASE_URL });
  console.log(`Cortana sync: last ${days} ET day(s)`);
  const result = await syncCortana({ db, cortana, days, log: (l) => console.log(`  ${l}`) });
  console.log(`\n${result.ok ? "OK" : "FAILED"}: ${result.clients} clinics · ${result.rows} rows · ${result.calls} Cortana calls`);
  for (const e of result.errors) console.log(`  ${e.client}: ${e.error}`);
  if (!result.ok) process.exit(1);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
