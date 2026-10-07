/** Run the Fathom sync from this machine: npm run sync:fathom */
import { createClient } from "@supabase/supabase-js";
import { syncFathom } from "../lib/integrations/fathom/sync";

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
};
async function main() {
  const db = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  const r = await syncFathom({ db, apiKey: env("FATHOM_API_KEY"), since: "2026-08-01" });
  console.log(`${r.ok ? "OK" : `FAILED: ${r.error}`} · ${r.calls} calls · ${r.client} with clients · ${r.prospect} with prospects · ${r.internal} internal · ${r.unmatched} unmatched · ${r.touches_added} touches added`);
  if (!r.ok) process.exit(1);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
