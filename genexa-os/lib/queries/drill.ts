import "server-only";
import { createClient } from "@/lib/supabase/server";
import { formatValue, type Unit } from "@/lib/format";
import type { Period } from "@/lib/periods";
import { addDays, etMidnight } from "@/lib/time";

export type DrillTable = {
  title: string;
  note?: string;
  columns: string[];
  rows: (string | null)[][];
  total?: string | null;
};

type Db = Awaited<ReturnType<typeof createClient>>;
const fmt = (v: unknown, unit: Unit) => formatValue(v === null || v === undefined ? null : Number(v), unit);
const range = (p: Period) => `${p.from} to ${p.to} (ET)`;
/** UTC instants bounding the period's ET days. */
const startOf = (p: Period) => etMidnight(p.from).toISOString();
const endOf = (p: Period) => etMidnight(addDays(p.to, 1)).toISOString();
const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);
const clientName = (v: unknown) => one(v as { name: string } | { name: string }[] | null)?.name ?? "—";
const when = (ts: string | null) => (ts ? new Date(ts).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : null);

/** The rows behind a number on the Overview. Unknown metric -> null. */
export async function getDrill(metric: string, period: Period): Promise<DrillTable | null> {
  const db: Db = await createClient();
  const perDay = async (title: string, columns: string[], pick: (r: Record<string, unknown>) => (string | null)[], filter: (r: Record<string, unknown>) => boolean, totalOf?: (rows: Record<string, unknown>[]) => string | null): Promise<DrillTable> => {
    const { data, error } = await db
      .from("client_performance_daily")
      .select("day, spend, leads, booked, client:clients(name)")
      .gte("day", period.from).lte("day", period.to).order("day", { ascending: false });
    if (error) throw new Error(error.message);
    const rows = ((data ?? []) as Record<string, unknown>[]).filter(filter);
    return { title: `${title} · ${range(period)}`, columns: ["Day", "Clinic", ...columns], rows: rows.map((r) => [String(r.day), clientName(r.client), ...pick(r)]), total: totalOf?.(rows) };
  };
  const sum = (rows: Record<string, unknown>[], key: string) => rows.reduce((a, r) => a + Number(r[key] ?? 0), 0);

  switch (metric) {
    case "ad_spend": {
      const { data, error } = await db
        .from("ad_metrics_daily")
        .select("date, spend, impressions, clicks, cortana_leads, cortana_booked, campaigns_in_scope, client_id, client:clients(name)")
        .gte("date", period.from).lte("date", period.to).order("date", { ascending: false }).order("spend", { ascending: false });
      if (error) throw new Error(error.message);
      const { data: unverified } = await db.from("clients_ads_unverified").select("client_id");
      const skip = new Set((unverified ?? []).map((u) => u.client_id));
      const counted = (data ?? []).filter((r) => !skip.has(r.client_id));
      return {
        title: `Ad spend · ${range(period)}`,
        note: skip.size ? "Clinics whose Cortana scope is unverified are listed but not counted in the total." : undefined,
        columns: ["Day", "Clinic", "Spend", "Impressions", "Clicks", "Cortana leads", "Cortana booked", "Counted"],
        rows: (data ?? []).map((r) => [r.date, clientName(r.client), fmt(r.spend, "money"), fmt(r.impressions, "count"), fmt(r.clicks, "count"), fmt(r.cortana_leads, "count"), fmt(r.cortana_booked, "count"), skip.has(r.client_id) ? "no (unverified)" : "yes"]),
        total: fmt(counted.reduce((a, r) => a + Number(r.spend ?? 0), 0), "money"),
      };
    }
    case "leads":
    case "booked":
    case "shows":
    case "rev_share": {
      const { data, error } = await db.rpc("rev_share_period", { p_from: period.from, p_to: period.to });
      if (error) throw new Error(error.message);
      const rows = ((data ?? []) as { name: string; terms: string; revenue: number; new_patients: number; owed: number }[]).sort((a, b) => Number(b.owed) - Number(a.owed));
      return {
        title: `Rev share owed · ${range(period)}`,
        note: "Each clinic's own terms. A new paying patient is one whose first purchase at that clinic falls in the period. Revenue is what Cortana records; test contacts are left out.",
        columns: ["Clinic", "Terms", "Clinic revenue", "New paying patients", "Owed"],
        rows: rows.map((r) => [r.name, r.terms, fmt(Number(r.revenue), "money"), fmt(Number(r.new_patients), "count"), fmt(Number(r.owed), "money")]),
        total: `${fmt(rows.reduce((a, r) => a + Number(r.owed), 0), "money")} owed`,
      };
    }
    case "show_rate":
    case "closes":
    case "clinic_revenue": {
      const spec: Record<string, { title: string; events: string[] }> = {
        leads: { title: "Leads", events: ["lead"] },
        booked: { title: "Booked", events: ["unconfirmed_appointment_booked"] },
        shows: { title: "Shows", events: ["appointment_shown"] },
        show_rate: { title: "Shows and no-shows", events: ["appointment_shown", "appointment_no_show"] },
        closes: { title: "Closes", events: ["purchase"] },
        clinic_revenue: { title: "Clinic revenue", events: ["purchase"] },
      };
      const { title, events } = spec[metric];
      const [{ data, error }, { data: unverified }] = await Promise.all([
        db.from("cortana_events")
          .select("event, occurred_at, value, contact_id, contact_first_name, attribution_source, campaign_name, ad_name, client_id, client:clients(name)")
          .eq("is_test", false).in("event", events).gte("occurred_at", startOf(period)).lt("occurred_at", endOf(period))
          .order("occurred_at", { ascending: false }).limit(2000),
        db.from("clients_ads_unverified").select("client_id"),
      ]);
      if (error) throw new Error(error.message);
      const skip = new Set((unverified ?? []).map((u) => u.client_id));
      const rows = (data ?? []).filter((r) => !skip.has(r.client_id));
      const EVENT: Record<string, string> = { lead: "Lead", unconfirmed_appointment_booked: "Booked", appointment_shown: "Showed", appointment_no_show: "No-show", purchase: "Purchase" };
      const money = events.includes("purchase");
      const people = (name: string) => new Set(rows.filter((r) => r.event === name).map((r) => `${r.client_id}:${r.contact_id}`)).size;
      return {
        title: `${title} · ${range(period)}`,
        note: "From Cortana, every source. Test contacts are left out. A contact is counted once per clinic per day.",
        columns: ["When (ET)", "Clinic", "Patient", "Event", ...(money ? ["Value"] : []), "Source", "Campaign", "Ad"],
        rows: rows.map((r) => [when(r.occurred_at), clientName(r.client), r.contact_first_name ?? "—", EVENT[r.event] ?? r.event, ...(money ? [fmt(r.value, "money")] : []), r.attribution_source, r.campaign_name, r.ad_name]),
        total: money
          ? `${rows.length} purchases · ${fmt(rows.reduce((a, r) => a + Number(r.value ?? 0), 0), "money")}`
          : events.length > 1 ? `${people("appointment_shown")} showed · ${people("appointment_no_show")} no-show` : `${rows.length} events`,
      };
    }
    case "cost_per_booked":
      return perDay("Spend and bookings", ["Spend", "Booked"], (r) => [fmt(r.spend, "money"), fmt(r.booked, "count")], (r) => r.spend !== null || Number(r.booked) > 0, (rows) => `${fmt(sum(rows, "spend"), "money")} spend · ${sum(rows, "booked")} booked`);
    case "cash_collected": {
      const { data, error } = await db.from("payments").select("customer_name, amount, paid_at, product_title, classified, client:clients(name)")
        .gte("paid_at", startOf(period)).lt("paid_at", endOf(period)).order("paid_at", { ascending: false }).limit(1000);
      if (error) throw new Error(error.message);
      return {
        title: `Whop payments · ${range(period)}`, note: "Only classified payments (with a product title) count as cash collected.",
        columns: ["Paid", "Customer", "Clinic", "Product", "Amount", "Counted"],
        rows: (data ?? []).map((r) => [when(r.paid_at), r.customer_name, clientName(r.client), r.product_title, fmt(r.amount, "money"), r.classified ? "yes" : "no"]),
        total: fmt((data ?? []).filter((r) => r.classified).reduce((a, r) => a + Number(r.amount), 0), "money"),
      };
    }
    case "expenses":
    case "net_profit":
    case "margin": {
      const { data, error } = await db.from("finance_transactions").select("posted_at, counterparty, amount, category, included")
        .gte("posted_at", startOf(period)).lt("posted_at", endOf(period)).order("posted_at", { ascending: false }).limit(1000);
      if (error) throw new Error(error.message);
      return {
        title: `Bank transactions · ${range(period)}`,
        columns: ["Posted", "Counterparty", "Category", "Amount", "Counted"],
        rows: (data ?? []).map((r) => [when(r.posted_at), r.counterparty, r.category, fmt(r.amount, "money"), r.included ? "yes" : "no"]),
      };
    }
    case "mrr": {
      const [{ data, error }, { data: prefix }, { data: names }] = await Promise.all([
        db.from("whop_memberships").select("client_id, product_title, status, valid, cancel_at_period_end, renewal_price, billing_period_days, renewal_period_end").gt("billing_period_days", 0).not("renewal_price", "is", null),
        db.from("app_settings").select("value").eq("key", "whop_mrr_product_prefix").maybeSingle(),
        db.from("clients").select("id, name"),
      ]);
      if (error) throw new Error(error.message);
      const name = new Map((names ?? []).map((c) => [c.id, c.name]));
      const now = new Date().toISOString();
      const want = String(prefix?.value ?? "").toLowerCase();
      const counted = (data ?? [])
        .filter((m) => String(m.product_title ?? "").toLowerCase().startsWith(want))
        .filter((m) => m.valid || (m.renewal_period_end !== null && m.renewal_period_end > now))
        .map((m) => ({ ...m, monthly: (Number(m.renewal_price) / Number(m.billing_period_days)) * 30 }))
        .sort((a, b) => b.monthly - a.monthly);
      return {
        title: "MRR · Whop recurring plans",
        note: "Every renewing Whop plan still inside a paid period, as a 30-day figure. A cancelled plan counts until its paid period ends.",
        columns: ["Clinic", "Plan", "Price", "Every", "Monthly", "Status", "Paid until"],
        rows: counted.map((m) => [
          m.client_id ? name.get(m.client_id) ?? null : "Not matched to a client yet", m.product_title, fmt(Number(m.renewal_price), "money"), `${m.billing_period_days} days`,
          fmt(m.monthly, "money"), m.valid ? (m.cancel_at_period_end ? "cancelling" : "active") : "cancelled, still paid", m.renewal_period_end ? when(m.renewal_period_end) : null,
        ]),
      };
    }
    case "clients": {
      const [{ data, error }, { data: clients }] = await Promise.all([
        db.from("client_fees").select("client_id, name, stage, billing_cycle, cycle_fee, record_monthly, whop_monthly, whop_plans, monthly_fee, source").order("monthly_fee", { ascending: false, nullsFirst: false }),
        db.from("clients").select("id, pod, launch_date").is("deleted_at", null),
      ]);
      if (error) throw new Error(error.message);
      const extra = new Map((clients ?? []).map((c) => [c.id, c]));
      const SOURCE: Record<string, string> = { whop: "Whop plan", confirmed: "Confirmed by owner", record: "Client record" };
      return {
        title: "MRR · clients that are not churned",
        note: "A matched client's fee is their live Whop plan as a 30-day figure. A fee the owner confirmed is kept. Otherwise it is the fee on the client record.",
        columns: ["Clinic", "Stage", "Pod", "Monthly fee used", "From", "Whop plan", "Fee on record", "Launch date"],
        rows: (data ?? []).map((r) => [r.name, r.stage, extra.get(r.client_id)?.pod?.replace("pod_", "Pod ") ?? null, fmt(r.monthly_fee, "money"), SOURCE[r.source] ?? r.source, r.whop_plans, r.record_monthly === null ? null : `${fmt(r.record_monthly, "money")}/month`, extra.get(r.client_id)?.launch_date ?? null]),
        total: fmt((data ?? []).reduce((a, r) => a + Number(r.monthly_fee ?? 0), 0), "money"),
      };
    }
    case "consults_tomorrow": {
      const { data, error } = await db.from("consults_tomorrow").select("name, consults, confirmed").order("consults", { ascending: false });
      if (error) throw new Error(error.message);
      return {
        title: "Consults booked for tomorrow (ET)",
        note: "From each clinic's GHL consult calendars. Cancelled consults are left out.",
        columns: ["Clinic", "Consults", "Confirmed", "Not yet confirmed"],
        rows: (data ?? []).map((r) => [r.name, String(r.consults), String(r.confirmed), String(Number(r.consults) - Number(r.confirmed))]),
        total: `${(data ?? []).reduce((a, r) => a + Number(r.consults), 0)} consults`,
      };
    }
    default:
      return null;
  }
}
