/**
 * Phase 2 acceptance check: yesterday's spend in ad_metrics_daily against a
 * fresh Cortana call, per clinic, to the cent.
 *   npm run verify:cortana
 * The Cortana side is summed here from the raw JSON, not through the app's mapper.
 */
import { createClient } from "@supabase/supabase-js";
import { accountDayRange, addDays, etToday } from "../lib/time";

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
};
type Raw = { dimension: string | null; customerId?: string | null; spent?: number | null };

async function main() {
  const db = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const date = addDays(etToday(), -1);
  const range = accountDayRange(date, date);
  const { data: clients } = await db.from("clients").select("id, name, cortana_business_id").not("cortana_business_id", "is", null).neq("stage", "churned").order("name");
  const { data: scopes } = await db.from("client_campaign_scope").select("client_id, campaign_name_contains, verified");
  const { data: stored } = await db.from("ad_metrics_daily").select("client_id, spend, synced_at").eq("date", date);
  console.log(`Spend for ${date} (ET): database vs Cortana\n`);
  console.log(`${"clinic".padEnd(42)} ${"database".padStart(10)} ${"cortana".padStart(10)}  match  note`);
  let matched = 0;
  for (const c of clients ?? []) {
    const qs = new URLSearchParams({ startDate: range.start, endDate: range.end, groupBy: "campaign" });
    const res = await fetch(`${process.env.CORTANA_BASE_URL ?? "https://app.usecortana.ai/api/v1"}/businesses/${c.cortana_business_id}/attribution?${qs}`, {
      headers: { Authorization: `Bearer ${env("CORTANA_API_KEY")}`, "User-Agent": "genexa-os/1.0" },
    });
    if (!res.ok) throw new Error(`Cortana ${res.status} for ${c.name}`);
    const rows = ((await res.json()) as { data: { data: Raw[] } }).data.data;
    const scope = scopes?.find((s) => s.client_id === c.id);
    const paid = rows.filter((r) => r.customerId);
    const ours = paid.filter((r) => !scope?.campaign_name_contains || (r.dimension ?? "").toLowerCase().includes(scope.campaign_name_contains.toLowerCase()));
    const cents = (list: Raw[]) => Math.round(list.reduce((a, r) => a + (r.spent ?? 0), 0) * 100);
    const dbRow = stored?.find((s) => s.client_id === c.id);
    const dbCents = dbRow ? Math.round(Number(dbRow.spend) * 100) : null;
    const ok = dbCents !== null && dbCents === cents(ours);
    if (ok) matched++;
    const notes = [
      scope?.campaign_name_contains ? `scope "${scope.campaign_name_contains}": whole business is $${(cents(paid) / 100).toFixed(2)}` : "",
      scope && !scope.verified ? "scope UNVERIFIED" : "",
    ].filter(Boolean).join("; ");
    console.log(`${c.name.padEnd(42)} ${(dbCents === null ? "no row" : (dbCents / 100).toFixed(2)).padStart(10)} ${(cents(ours) / 100).toFixed(2).padStart(10)}  ${ok ? "yes  " : "NO   "}  ${notes}`);
    await new Promise((r) => setTimeout(r, 1100));
  }
  console.log(`\n${matched} of ${clients?.length ?? 0} clinics match to the cent.`);
  if (matched !== (clients?.length ?? 0)) process.exit(1);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
