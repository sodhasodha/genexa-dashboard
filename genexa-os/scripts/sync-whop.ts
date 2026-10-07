/**
 * Run the Whop sync from this machine and print who was matched and who was not.
 *   npm run sync:whop
 */
import { createClient } from "@supabase/supabase-js";
import { createWhopClient } from "../lib/integrations/whop/client";
import { syncWhop } from "../lib/integrations/whop/sync";

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
};

async function main() {
  const db = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  const r = await syncWhop({ db, whop: createWhopClient({ apiKey: env("WHOP_API_KEY") }), since: "2026-08-01" });
  console.log(`${r.ok ? "OK" : `FAILED: ${r.error}`} · ${r.payments} payments · ${r.memberships} memberships`);
  console.log(`\nNewly matched (${r.matched.length})`);
  for (const m of r.matched) console.log(`  ${m.customer.padEnd(30)} -> ${m.client.padEnd(42)} [${m.reason}]`);
  console.log(`\nNot matched: in the Data review queue (${r.unmatched.length})`);
  for (const u of r.unmatched) console.log(`  ${u.customer.padEnd(30)} ${String(u.email ?? "").padEnd(34)} paid $${u.paid}`);
  if (!r.ok) process.exit(1);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
