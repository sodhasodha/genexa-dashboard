import Link from "next/link";
import { notFound } from "next/navigation";
import { DataTable } from "@/components/DataTable";
import { requireStaff } from "@/lib/auth/staff";
import { formatValue } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

// First cut of the client profile: the facts on record and what is open against the clinic.
// The full profile (payments, touches, launch checklist, editing) ships in Phase 7.
export default async function ClientPage({ params }: PageProps<"/clients/[id]">) {
  await requireStaff();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const [{ data: c }, { data: health }, { data: renewal }, { data: exceptions }, { data: scope }] = await Promise.all([
    supabase.from("clients").select("*").eq("id", id).is("deleted_at", null).maybeSingle(),
    supabase.from("client_health").select("colour, reasons").eq("client_id", id).maybeSingle(),
    supabase.from("renewals").select("renewal_date, renewal_amount, status, days_until").eq("client_id", id).maybeSingle(),
    supabase.from("exceptions").select("severity, reason, status, first_detected_at, money_at_risk").eq("client_id", id).order("first_detected_at", { ascending: false }).limit(50),
    supabase.from("client_campaign_scope").select("campaign_name_contains, verified, note").eq("client_id", id).maybeSingle(),
  ]);
  if (!c) notFound();
  const facts: [string, string | null][] = [
    ["Stage", c.stage], ["Pod", c.pod?.replace("pod_", "Pod ") ?? null], ["Contact", c.contact_name],
    ["Billing cycle", c.billing_cycle ? (c.billing_cycle === "legacy" ? "Legacy (30 days)" : `${c.billing_cycle} days`) : null],
    ["Fee per cycle", formatValue(c.cycle_fee === null ? null : Number(c.cycle_fee), "money")],
    ["Monthly fee", formatValue(c.monthly_fee === null ? null : Number(c.monthly_fee), "money")],
    ["Launch date", c.launch_date],
    ["Next renewal", renewal?.renewal_date ? `${renewal.renewal_date} · ${renewal.status}` : (renewal?.status ?? null)],
    ["Guarantee", c.guarantee_text ? `${c.guarantee_text}${c.guarantee_deadline ? ` · due ${c.guarantee_deadline}` : ""}` : null],
    ["Cortana", c.cortana_business_id ? (scope && !scope.verified ? "Connected · scope unverified" : scope?.campaign_name_contains ? `Connected · campaigns containing "${scope.campaign_name_contains}"` : "Connected") : "Not connected"],
    ["Next action", c.next_action],
    ["Last contact (us)", c.last_contact_us?.slice(0, 10) ?? null], ["Last reply (client)", c.last_reply_client?.slice(0, 10) ?? null],
  ];
  const tone = c.stage !== "live" ? "bg-stale-bg text-stale" : health?.colour === "red" ? "bg-bad-bg text-bad" : health?.colour === "amber" ? "bg-warn-bg text-warn" : "bg-good-bg text-good";
  return (
    <div className="flex flex-col gap-4 p-4">
      <Link href="/overview" className="text-xs text-muted underline">← Overview</Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{c.name}</h1>
        <span className={`rounded-full px-2.5 py-1 text-xs ${tone}`}>{c.stage !== "live" ? c.stage : (health?.reasons ?? "No issues found")}</span>
      </div>
      {scope?.note ? <p className="text-xs text-muted">{scope.note}</p> : null}
      <dl className="grid gap-x-6 gap-y-2 rounded-lg border border-line bg-panel p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {facts.map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-muted">{k}</dt>
            <dd>{v ?? <span className="text-stale">no data</span>}</dd>
          </div>
        ))}
      </dl>
      <section>
        <h2 className="mb-2 text-sm font-semibold">Exceptions</h2>
        <DataTable
          columns={["Status", "Severity", "What", "First seen", "At risk"]}
          rows={(exceptions ?? []).map((e) => [e.status, e.severity, e.reason, e.first_detected_at.slice(0, 10), Number(e.money_at_risk ?? 0) > 0 ? formatValue(Number(e.money_at_risk), "money") : "—"])}
        />
      </section>
    </div>
  );
}
