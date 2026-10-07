/** Run the Mercury sync from this machine: npm run sync:mercury */
import { createClient } from "@supabase/supabase-js";
import { syncMercury } from "../lib/integrations/mercury/sync";

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
};
async function main() {
  const db = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  const r = await syncMercury({ db, apiKey: env("MERCURY_API_KEY"), proxyUrl: process.env.FIXIE_URL, since: "2026-08-01" });
  console.log(`${r.ok ? "OK" : `FAILED: ${r.error}`} · ${r.transactions} transactions · ${r.categorised} categorised by rule this run · ${r.unclassified} left for review`);
  if (!r.ok) process.exit(1);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
