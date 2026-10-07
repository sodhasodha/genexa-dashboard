import "server-only";
import { createClient } from "@/lib/supabase/server";
import { changeRatio, formatAge, type Unit } from "@/lib/format";
import type { Period } from "@/lib/periods";

export type TileState = "ok" | "no_data" | "stale";
export type Tile = {
  key: string;
  label: string;
  unit: Unit;
  value: number | null;
  previous: number | null;
  change: number | null;
  /** Is up good (revenue), bad (expenses) or neutral? Decides the arrow colour. */
  upIs: "good" | "bad" | "neutral";
  state: TileState;
  /** Why there is no number, in plain words. */
  note: string | null;
  href: string;
  sub?: string;
};

type Totals = {
  ad_spend: number | null; leads: number | null; booked: number | null; confirmed: number | null; shows: number | null;
  no_shows: number | null; closes: number | null; clinic_revenue: number | null; cash_collected: number | null;
  expenses: number | null; bank_revenue: number | null;
};
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const usd = (v: number) => v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const SOURCE_NAME: Record<string, string> = { cortana: "Cortana", ghl: "GHL", whop: "Whop", mercury: "Mercury" };

export async function getOverview(period: Period) {
  const supabase = await createClient();
  const [cur, prev, fresh, clients, config, firstAdDay] = await Promise.all([
    supabase.rpc("overview_period", { p_from: period.from, p_to: period.to }).single(),
    supabase.rpc("overview_period", { p_from: period.prevFrom, p_to: period.prevTo }).single(),
    supabase.from("source_freshness").select("source, freshness"),
    supabase.from("clients").select("id, stage").is("deleted_at", null),
    supabase.from("scoring_config").select("key, value").in("key", ["rev_share_rate", "mrr_target"]),
    supabase.from("ad_metrics_daily").select("date").order("date").limit(1).maybeSingle(),
  ]);
  const firstEvent = await supabase.from("cortana_events").select("occurred_at").order("occurred_at").limit(1).maybeSingle();
  // No events loaded at all = the funnel has not synced: show "no data", not zeros.
  const eventsLoaded = !!firstEvent.data;
  const eventsPrevComplete = eventsLoaded && (firstEvent.data?.occurred_at as string).slice(0, 10) <= period.prevFrom;
  const ev = (v: number | null) => (eventsPrevComplete ? v : null);
  // A comparison is only shown when the earlier period is fully loaded. Ad history starts at the first synced day.
  const adHistoryFrom = (firstAdDay.data?.date as string | undefined) ?? null;
  const adPrevComplete = adHistoryFrom !== null && adHistoryFrom <= period.prevFrom;
  for (const r of [cur, prev, fresh, clients, config]) if (r.error) throw new Error(`overview: ${r.error.message}`);
  const c = Object.fromEntries(Object.entries(cur.data as Record<string, unknown>).map(([k, v]) => [k, n(v)])) as Totals;
  const p = Object.fromEntries(Object.entries(prev.data as Record<string, unknown>).map(([k, v]) => [k, n(v)])) as Totals;
  const freshness = new Map((fresh.data ?? []).map((f) => [f.source as string, f.freshness as string]));
  const cfg = new Map((config.data ?? []).map((x) => [x.key as string, Number(x.value)]));
  const revShare = cfg.get("rev_share_rate") ?? null;

  /** A number is only shown when every source behind it has synced. */
  const stateOf = (sources: string[]): { state: TileState; note: string | null } => {
    const never = sources.filter((s) => freshness.get(s) === "never");
    if (never.length) return { state: "no_data", note: `${never.map((s) => SOURCE_NAME[s]).join(" and ")} not connected yet` };
    const stale = sources.filter((s) => freshness.get(s) === "stale");
    if (stale.length) return { state: "stale", note: `${stale.map((s) => SOURCE_NAME[s]).join(" and ")} sync is stale` };
    return { state: "ok", note: null };
  };
  const q = `?period=${period.key}`;
  const tile = (key: string, label: string, unit: Unit, sources: string[], value: number | null, previous: number | null, upIs: Tile["upIs"], sub?: string): Tile => {
    const s = stateOf(sources);
    const shown = s.state === "no_data" ? null : value;
    const shownPrev = s.state === "no_data" ? null : previous;
    return { key, label, unit, value: shown, previous: shownPrev, change: changeRatio(shown, shownPrev), upIs, href: `/drill/${key}${q}`, sub, ...s };
  };
  const ratio = (a: number | null, b: number | null) => (a === null || b === null || b === 0 ? null : a / b);

  // MRR: each client's effective monthly fee (Whop plan when matched, confirmed or recorded fee otherwise).
  const fees = await supabase.from("client_fees").select("monthly_fee, source");
  if (fees.error) throw new Error(`client_fees: ${fees.error.message}`);
  const mrr = (fees.data ?? []).reduce((a, x) => a + Number(x.monthly_fee ?? 0), 0);
  const fromWhop = (fees.data ?? []).filter((x) => x.source === "whop").length;
  // Month-on-month uses one method for both months: recurring Whop memberships now vs at the end of last month.
  const lastMonthEnd = new Date(Date.UTC(Number(period.to.slice(0, 4)), Number(period.to.slice(5, 7)) - 1, 0)).toISOString().slice(0, 10);
  const [whopNow, whopThen] = await Promise.all([
    supabase.rpc("whop_mrr_at", { p_day: period.to }),
    supabase.rpc("whop_mrr_at", { p_day: lastMonthEnd }),
  ]);
  const whopKnown = freshness.get("whop") !== "never" && !whopNow.error && !whopThen.error;
  const recurringNow = whopKnown ? Number(whopNow.data) : null;
  const recurringThen = whopKnown ? Number(whopThen.data) : null;
  const stage = (s: string) => (clients.data ?? []).filter((x) => x.stage === s).length;
  const net = (t: Totals) => (t.bank_revenue === null && t.expenses === null ? null : (t.bank_revenue ?? 0) - (t.expenses ?? 0));

  const money: Tile[] = [
    tile("cash_collected", "Cash collected", "money", ["whop"], c.cash_collected, p.cash_collected, "good"),
    {
      ...tile("mrr", "MRR", "money", [], mrr, null, "good"),
      note: `${fromWhop} of ${(fees.data ?? []).length} clients priced from Whop`,
      sub: recurringNow !== null && recurringThen !== null
        ? `Whop recurring ${usd(recurringNow)} · ${usd(recurringThen)} at end of last month`
        : `Target ${usd(cfg.get("mrr_target") ?? 0)}`,
    },
    tile("clinic_revenue", "Clinic revenue generated", "money", ["cortana"], c.clinic_revenue, ev(p.clinic_revenue), "good"),
    tile("rev_share", "Rev share owed", "money", ["cortana"],
      c.clinic_revenue === null || revShare === null ? null : c.clinic_revenue * revShare,
      ev(p.clinic_revenue) === null || revShare === null ? null : (p.clinic_revenue as number) * revShare, "good"),
  ];
  const profit: Tile[] = [
    tile("expenses", "Expenses", "money", ["mercury"], c.expenses, p.expenses, "bad"),
    tile("net_profit", "Net profit", "money", ["mercury"], net(c), net(p), "good"),
    tile("margin", "Margin", "percent", ["mercury"], ratio(net(c), c.bank_revenue), ratio(net(p), p.bank_revenue), "good"),
    { ...tile("clients", "Active clients", "count", [], stage("live"), null, "good"), note: "Live right now", sub: `${stage("live")} live · ${stage("onboarding")} onboarding · ${stage("unlaunched")} waiting` },
  ];
  const noEvents = (t: Tile): Tile => (eventsLoaded ? t : { ...t, value: null, previous: null, change: null, state: "no_data", note: "Cortana events not synced yet" });
  const deliveryRaw: Tile[] = [
    adPrevComplete
      ? tile("ad_spend", "Ad spend", "money", ["cortana"], c.ad_spend, p.ad_spend, "neutral")
      : { ...tile("ad_spend", "Ad spend", "money", ["cortana"], c.ad_spend, null, "neutral"), note: adHistoryFrom ? `No comparison: ad history starts ${adHistoryFrom}` : null },
    tile("leads", "Leads", "count", ["cortana"], c.leads, ev(p.leads), "good"),
    tile("booked", "Booked", "count", ["cortana"], c.booked, ev(p.booked), "good"),
    tile("shows", "Shows", "count", ["cortana"], c.shows, ev(p.shows), "good"),
    tile("closes", "Closes", "count", ["cortana"], c.closes, ev(p.closes), "good"),
    tile("cost_per_booked", "Cost per booked", "money", ["cortana"], ratio(c.ad_spend, c.booked), adPrevComplete ? ratio(p.ad_spend, ev(p.booked)) : null, "bad"),
    tile("show_rate", "Show rate", "percent", ["cortana"],
      ratio(c.shows, (c.shows ?? 0) + (c.no_shows ?? 0)), eventsPrevComplete ? ratio(p.shows, (p.shows ?? 0) + (p.no_shows ?? 0)) : null, "good"),
  ];
  const delivery = deliveryRaw.map((t) => (t.key === "ad_spend" ? t : noEvents(t)));
  money[2] = noEvents(money[2]);
  money[3] = noEvents(money[3]);
  return { money, profit, delivery, mrr, mrrTarget: cfg.get("mrr_target") ?? null };
}

export type Bottleneck = {
  id: string; type: string; severity: "red" | "amber"; reason: string; money_at_risk: number | null;
  client_name: string | null; owner_name: string | null; age: string; action_taken: string | null; status: string;
  reminded: number;
};

/** Open exceptions ranked by money at risk, then age. */
export async function getBottlenecks(): Promise<{ rows: Bottleneck[]; atRisk: number }> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("exceptions")
    .select("id, type, severity, reason, money_at_risk, first_detected_at, action_taken, status, client:clients(name), owner:staff!exceptions_owner_id_fkey(name)")
    .eq("status", "open")
    .order("money_at_risk", { ascending: false, nullsFirst: false })
    .order("severity", { ascending: false })
    .order("first_detected_at");
  if (error) throw new Error(`exceptions: ${error.message}`);
  const ids = (data ?? []).map((d) => d.id);
  const { data: notes } = ids.length
    ? await supabase.from("notifications").select("record_id").in("record_id", ids).not("sent_at", "is", null)
    : { data: [] as { record_id: string }[] };
  const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);
  const rows = (data ?? []).map((d) => ({
    id: d.id as string,
    type: d.type as string,
    severity: d.severity as "red" | "amber",
    reason: d.reason as string,
    money_at_risk: n(d.money_at_risk),
    client_name: one(d.client as { name: string } | { name: string }[] | null)?.name ?? null,
    owner_name: one(d.owner as { name: string } | { name: string }[] | null)?.name ?? null,
    age: (formatAge((Date.now() - new Date(d.first_detected_at as string).getTime()) / 60_000) ?? "").replace(" ago", ""),
    action_taken: d.action_taken as string | null,
    status: d.status as string,
    reminded: (notes ?? []).filter((x) => x.record_id === d.id).length,
  }));
  return { rows, atRisk: rows.reduce((a, r) => a + (r.money_at_risk ?? 0), 0) };
}

export const REVIEW_KINDS = [
  { kind: "unlogged_outcome", label: "Unlogged outcomes" },
  { kind: "unmatched_payment", label: "Unmatched payments" },
  { kind: "unclassified_payment", label: "Unclassified payments" },
  { kind: "uncategorised_expense", label: "Uncategorised expenses" },
  { kind: "eod_issue", label: "EOD issues" },
  { kind: "test_lead", label: "Test leads" },
  { kind: "anomaly", label: "Data anomalies" },
] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number]["kind"];
export type ReviewItem = { kind: ReviewKind; record_table: string; record_id: string; client_id: string | null; title: string; detail: string; item_key: string };

export async function getReview(): Promise<{ counts: Record<ReviewKind, number>; items: ReviewItem[]; total: number }> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("data_review_open")
    .select("kind, record_table, record_id, client_id, title, detail, occurred_at, item_key")
    .order("occurred_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`data_review_open: ${error.message}`);
  const items = (data ?? []) as ReviewItem[];
  const counts = Object.fromEntries(REVIEW_KINDS.map((k) => [k.kind, items.filter((i) => i.kind === k.kind).length])) as Record<ReviewKind, number>;
  return { counts, items, total: items.length };
}

export async function getClientOptions(): Promise<{ id: string; name: string }[]> {
  const supabase = await createClient();
  const { data } = await supabase.from("clients").select("id, name").is("deleted_at", null).order("name");
  return (data ?? []) as { id: string; name: string }[];
}

export type PersonCard = {
  id: string; name: string; role: string; pod: string | null; status: string;
  colour: "green" | "amber" | "red" | null;
  metrics: { label: string; value: string; colour: string | null }[];
  /** Metrics that cannot be measured yet because their source is not connected. */
  waiting: string[];
  openItems: number;
  oldest: string | null;
};

// How each metric reads on a card. "ratio" shows value/denominator; "pct" a percentage; "count" a plain number.
const METRIC: Record<string, { label: string; as: "ratio" | "pct" | "count" }> = {
  attendance_pct: { label: "On time", as: "pct" },
  late_count: { label: "Late", as: "count" },
  no_shows: { label: "No-shows", as: "count" },
  eods: { label: "EODs this week", as: "ratio" },
  launch_sla_pct: { label: "Launches in SLA", as: "pct" },
  fix_sla_pct: { label: "Fixes in SLA", as: "pct" },
  broken_week1: { label: "Broken in week 1", as: "count" },
  paused_pct: { label: "Jobs paused", as: "pct" },
  exceptions_24h_pct: { label: "Ad exceptions cleared in 24h", as: "pct" },
  accounts_over_cpb: { label: "Accounts over cost-per-booked line", as: "count" },
  book_cpb_change_pct: { label: "Book cost per booked vs last 7d", as: "pct" },
  zero_spend_accounts: { label: "Accounts at $0 spend", as: "count" },
  accounts_flagged_3d: { label: "Accounts flagged 3+ days", as: "count" },
};
const RANK: Record<string, number> = { red: 3, amber: 2, green: 1 };

/** One card per person: worst metric wins. Only metrics with data are shown. */
export async function getPeople(): Promise<PersonCard[]> {
  const supabase = await createClient();
  const [staff, scores, exceptions, tasks] = await Promise.all([
    supabase.from("staff").select("id, name, role, pod, status").neq("status", "left").in("role", ["media_buyer", "tech", "csr"]).order("role").order("name"),
    supabase.rpc("current_week_scores"),
    supabase.from("exceptions").select("owner_id, reason, first_detected_at").eq("status", "open").order("first_detected_at"),
    supabase.from("tasks").select("owner_id, title, created_at").is("deleted_at", null).neq("status", "done").order("created_at"),
  ]);
  for (const r of [staff, scores, exceptions, tasks]) if (r.error) throw new Error(`people: ${r.error.message}`);
  const { data: hp } = await supabase.from("source_freshness").select("freshness").eq("source", "hot_prospector").maybeSingle();
  const callsConnected = !!hp && hp.freshness !== "never";
  type Score = { staff_id: string; metric: string; value: number | null; denominator: number | null; colour: string | null };
  return (staff.data ?? []).map((s) => {
    const mine = ((scores.data ?? []) as Score[]).filter((x) => x.staff_id === s.id);
    const ex = (exceptions.data ?? []).filter((x) => x.owner_id === s.id);
    const tk = (tasks.data ?? []).filter((x) => x.owner_id === s.id);
    const worst = mine.filter((m) => m.value !== null && (m.denominator === null || Number(m.denominator) > 0)).map((m) => m.colour).filter((x): x is string => !!x).sort((a, b) => RANK[b] - RANK[a])[0] ?? null;
    const oldestEx = ex[0] ? { at: ex[0].first_detected_at as string, text: ex[0].reason as string } : null;
    const oldestTask = tk[0] ? { at: tk[0].created_at as string, text: tk[0].title as string } : null;
    const oldest = [oldestEx, oldestTask].filter((x): x is { at: string; text: string } => !!x).sort((a, b) => a.at.localeCompare(b.at))[0];
    // CSR call metrics have no source until Hot Prospector is connected: shown as waiting, never as red.
    const waiting = s.role === "csr" && !callsConnected ? ["Speed to lead", "Book rate", "Confirmation rate", "Show rate"] : [];
    return {
      id: s.id as string, name: s.name as string, role: s.role as string, pod: s.pod as string | null, status: s.status as string,
      waiting,
      colour: worst as PersonCard["colour"],
      // Only metrics that have something to measure this week are shown.
      metrics: mine.filter((m) => m.value !== null && (m.denominator === null || Number(m.denominator) > 0)).map((m) => {
        const spec = METRIC[m.metric] ?? { label: m.metric, as: "count" as const };
        const v = Number(m.value);
        return {
          label: spec.label,
          value: spec.as === "ratio" ? `${v}/${Number(m.denominator)}` : spec.as === "pct" ? `${v > 0 && m.metric === "book_cpb_change_pct" ? "+" : ""}${Math.round(v)}%` : String(v),
          colour: m.colour,
        };
      }),
      openItems: ex.length + tk.length,
      oldest: oldest ? `${oldest.text} (${(formatAge((Date.now() - new Date(oldest.at).getTime()) / 60_000) ?? "").replace(" ago", "")})` : null,
    };
  });
}

export type ClientPill = { client_id: string; name: string; stage: string; colour: "green" | "amber" | "red"; reasons: string | null; cortana_connected: boolean; sources_missing: string[] };

export async function getClientsStrip(): Promise<ClientPill[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("client_health").select("client_id, name, stage, colour, reasons, cortana_connected, sources_missing").order("name");
  if (error) throw new Error(`client_health: ${error.message}`);
  return (data ?? []) as ClientPill[];
}

export type Trajectory = {
  months: { month: string; mrr: number | null; current: boolean }[];
  cash: { day: number; total: number }[];
  cashKnown: boolean;
  target: number | null;
  targetDate: string | null;
  daysInMonth: number;
};

/**
 * Recurring MRR by month from Whop memberships (month end; today for the current
 * month), one method for every month, plus this month's cumulative cash.
 */
export async function getTrajectory(today: string, target: number | null): Promise<Trajectory> {
  const supabase = await createClient();
  const monthStart = `${today.slice(0, 8)}01`;
  const [pays, fresh, settings] = await Promise.all([
    supabase.from("payments").select("amount, paid_at, classified, status").gte("paid_at", `${monthStart}T04:00:00Z`).order("paid_at"),
    supabase.from("source_freshness").select("source, freshness").eq("source", "whop").maybeSingle(),
    supabase.from("app_settings").select("value").eq("key", "mrr_target_date").maybeSingle(),
  ]);
  const whopKnown = fresh.data?.freshness !== "never" && fresh.data?.freshness !== undefined;
  const targetDate = typeof settings.data?.value === "string" ? settings.data.value : null;
  const keys: string[] = [];
  const end = targetDate ? targetDate.slice(0, 7) : today.slice(0, 7);
  // History starts in August 2026, the first month Genexa's Whop data is complete.
  let [y, m] = [2026, 8];
  for (let i = 0; i < 36; i++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    keys.push(key);
    if (key >= end) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  const months: Trajectory["months"] = await Promise.all(
    keys.map(async (key) => {
      const current = key === today.slice(0, 7);
      if (!whopKnown || key > today.slice(0, 7)) return { month: key, mrr: null, current };
      const lastDay = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).toISOString().slice(0, 10);
      const { data, error } = await supabase.rpc("whop_mrr_at", { p_day: current ? today : lastDay });
      return { month: key, mrr: error ? null : Number(data), current };
    }),
  );
  const byDay = new Map<number, number>();
  for (const p of (pays.data ?? []).filter((x) => x.classified && x.status === "paid")) {
    const day = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", day: "2-digit" }).format(new Date(p.paid_at as string)));
    byDay.set(day, (byDay.get(day) ?? 0) + Number(p.amount));
  }
  const cash: Trajectory["cash"] = [];
  let running = 0;
  for (let d = 1; d <= Number(today.slice(8, 10)); d++) {
    running += byDay.get(d) ?? 0;
    cash.push({ day: d, total: running });
  }
  return {
    months, cash, cashKnown: whopKnown,
    target, targetDate,
    daysInMonth: new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate(),
  };
}
