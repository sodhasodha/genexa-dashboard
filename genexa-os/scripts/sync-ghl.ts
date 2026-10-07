/**
 * Run the GHL appointments sync from this machine.
 *   npm run sync:ghl
 */
import { createClient } from "@supabase/supabase-js";
import { syncGhlAppointments, type GhlKeys } from "../lib/integrations/ghl/sync";

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
};
async function main() {
  const db = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  const r = await syncGhlAppointments({ db, keys: JSON.parse(env("GHL_API_KEYS_JSON")) as GhlKeys, log: (l) => console.log(`  ${l}`) });
  console.log(`\n${r.ok ? "OK" : "FAILED"}: ${r.clinics} clinics · ${r.appointments} consults · ${r.outcomes_applied} outcomes copied from Cortana`);
  for (const s of r.skipped) console.log(`  skipped ${s}`);
  for (const e of r.errors) console.log(`  ${e.client}: ${e.error}`);
  if (!r.ok) process.exit(1);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
