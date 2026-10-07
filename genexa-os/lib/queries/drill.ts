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
      .select("day, spend, leads, booked, confirmed, shows, no_shows, closes, revenue, client:clients(name)")
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
    case "booked": {
      const col = metric === "leads" ? "created_at" : "booked_at";
      const { data, error } = await db.from("leads").select("name, created_at, booked_at, first_call_at, client:clients(name)")
        .eq("is_test", false).gte(col, startOf(period)).lt(col, endOf(period)).order(col, { ascending: false }).limit(1000);
      if (error) throw new Error(error.message);
      return {
        title: `${metric === "leads" ? "Leads" : "Booked"} · ${range(period)}`,
        columns: ["Lead", "Clinic", "Created", "First call", "Booked"],
        rows: (data ?? []).map((r) => [(r.name as string | null)?.split(" ")[0] ?? "—", clientName(r.client), when(r.created_at), when(r.first_call_at), when(r.booked_at)]),
        total: fmt((data ?? []).length, "count"),
      };
    }
    case "shows":
    case "show_rate":
      return perDay("Shows", ["Shows", "No-shows"], (r) => [fmt(r.shows, "count"), fmt(r.no_shows, "count")], (r) => Number(r.shows) + Number(r.no_shows) > 0, (rows) => `${sum(rows, "shows")} shows · ${sum(rows, "no_shows")} no-shows`);
    case "closes":
    case "clinic_revenue":
    case "rev_share":
      return perDay("Closes and clinic revenue", ["Closes", "Revenue"], (r) => [fmt(r.closes, "count"), fmt(r.revenue, "money")], (r) => Number(r.closes) > 0, (rows) => `${sum(rows, "closes")} closes · ${fmt(sum(rows, "revenue"), "money")}`);
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
    case "mrr":
    case "clients": {
      const { data, error } = await db.from("clients").select("name, stage, pod, billing_cycle, cycle_fee, monthly_fee, launch_date").is("deleted_at", null).neq("stage", "churned").order("monthly_fee", { ascending: false, nullsFirst: false });
      if (error) throw new Error(error.message);
      return {
        title: "MRR · clients that are not churned",
        columns: ["Clinic", "Stage", "Pod", "Billing cycle", "Fee per cycle", "Monthly fee", "Launch date"],
        rows: (data ?? []).map((r) => [r.name, r.stage, r.pod?.replace("pod_", "Pod ") ?? null, r.billing_cycle ? (r.billing_cycle === "legacy" ? "Legacy (30 days)" : `${r.billing_cycle} days`) : null, fmt(r.cycle_fee, "money"), fmt(r.monthly_fee, "money"), r.launch_date]),
        total: fmt((data ?? []).reduce((a, r) => a + Number(r.monthly_fee ?? 0), 0), "money"),
      };
    }
    default:
      return null;
  }
}
