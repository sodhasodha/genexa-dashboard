import "server-only";
import { createClient } from "@/lib/supabase/server";
import { formatAge, formatValue } from "@/lib/format";
import { addDays } from "@/lib/time";

// Reads for the Media Buying page. Every number is computed in SQL
// (media_account_metrics, media_ad_metrics, score_media_weekly); this file
// only fetches, types and words them.

export type WindowKey = "3d" | "7d" | "all";
export const WINDOWS: { key: WindowKey; label: string; days: number | null }[] = [
  { key: "3d", label: "3 days", days: 3 },
  { key: "7d", label: "7 days", days: 7 },
  { key: "all", label: "All time", days: null },
];
export const parseWindow = (value: unknown): WindowKey => (WINDOWS.some((w) => w.key === value) ? (value as WindowKey) : "7d");
const daysOf = (key: WindowKey) => WINDOWS.find((w) => w.key === key)?.days ?? null;

export const AD_EXCEPTION_TYPES = ["zero_spend", "account_cpb_high", "ad_fatigue", "ad_performance", "ad_disapproved"] as const;
const TYPE_LABEL: Record<string, string> = {
  zero_spend: "Zero spend",
  account_cpb_high: "Cost per booked",
  ad_fatigue: "Ad fatigue",
  ad_performance: "Ad performance",
  ad_disapproved: "Disapproved ad",
};

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);
type Colour = "green" | "amber" | "red";

// ---------------------------------------------------------------------------
// Thresholds: every verdict on the page names the scoring_config row behind it.
// ---------------------------------------------------------------------------
type Config = { key: string; label: string; direction: string; green: number | null; amber: number | null; value: number | null; unit: string | null };
export type Thresholds = Record<string, string>;

const CONFIG_KEYS = [
  "cost_per_booked_7d", "ad_fatigue_frequency", "ad_fatigue_ctr_drop_pct",
  "sop_milestone_1", "sop_milestone_2", "sop_milestone_3", "sop_milestone_4",
  "media_exceptions_24h_pct", "media_accounts_over_cpb", "media_book_cpb_change_pct",
  "media_zero_spend_accounts", "media_accounts_flagged_3d", "media_exception_sla_hours", "media_flagged_days",
];

const withUnit = (v: number | null, unit: string | null) => (v === null ? "not set" : unit === "$" ? `$${v}` : unit === "%" ? `${v}%` : `${v}`);

/** "green ≤ $71 · amber ≤ $110 · red above (scoring_config: cost_per_booked_7d)" */
function describeConfig(c: Config): string {
  const source = `scoring_config: ${c.key}`;
  if (c.direction === "constant") return `${c.label}: ${withUnit(c.value, c.unit)} (${source})`;
  const [cmp, rest] = c.direction === "higher_better" ? ["≥", "red below"] : ["≤", "red above"];
  return `${c.label}: green ${cmp} ${withUnit(c.green, c.unit)} · amber ${cmp} ${withUnit(c.amber, c.unit)} · ${rest} (${source})`;
}

async function getConfig(): Promise<Map<string, Config>> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("scoring_config").select("key, label, direction, green, amber, value, unit").in("key", CONFIG_KEYS);
  if (error) throw new Error(`scoring_config: ${error.message}`);
  return new Map((data ?? []).map((c) => [c.key as string, { ...c, green: n(c.green), amber: n(c.amber), value: n(c.value) } as Config]));
}

/** The wording of each threshold used on the page, keyed by scoring_config key. */
export async function getThresholds(): Promise<Thresholds> {
  const config = await getConfig();
  return Object.fromEntries([...config.values()].map((c) => [c.key, describeConfig(c)]));
}

// ---------------------------------------------------------------------------
// Open ad exceptions, oldest first.
// ---------------------------------------------------------------------------
export type AdException = {
  id: string; type: string; type_label: string; severity: "red" | "amber"; status: string; reason: string;
  client_name: string | null; owner_id: string | null; owner_name: string | null; age: string; detected: string; action_taken: string | null;
};

export async function getAdExceptions(): Promise<AdException[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("exceptions")
    .select("id, type, severity, status, reason, first_detected_at, action_taken, owner_id, client:clients(name), owner:staff!exceptions_owner_id_fkey(name)")
    .in("status", ["open", "snoozed"])
    .in("type", [...AD_EXCEPTION_TYPES])
    .order("first_detected_at");
  if (error) throw new Error(`exceptions: ${error.message}`);
  return (data ?? []).map((d) => ({
    id: d.id as string,
    type: d.type as string,
    type_label: TYPE_LABEL[d.type as string] ?? (d.type as string),
    severity: d.severity as "red" | "amber",
    status: d.status as string,
    reason: d.reason as string,
    client_name: one(d.client as { name: string } | { name: string }[] | null)?.name ?? null,
    owner_id: d.owner_id as string | null,
    owner_name: one(d.owner as { name: string } | { name: string }[] | null)?.name ?? null,
    age: (formatAge((Date.now() - new Date(d.first_detected_at as string).getTime()) / 60_000) ?? "").replace(" ago", ""),
    detected: new Date(d.first_detected_at as string).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }),
    action_taken: d.action_taken as string | null,
  }));
}

// ---------------------------------------------------------------------------
// Per account.
// ---------------------------------------------------------------------------
export type AccountRow = {
  client_id: string; name: string; stage: string; launch_date: string | null; days_live: number | null; sop_stage: string | null;
  unverified: boolean; campaign_scoped: boolean; window_from: string | null; window_to: string | null;
  spend: number | null; leads: number | null; booked: number | null; shows: number | null; closes: number | null; revenue: number | null;
  cpl: number | null; cost_per_booked: number | null; booking_rate: number | null; cost_per_show: number | null; cost_per_close: number | null;
  frequency: number | null; ctr: number | null; cpm: number | null;
  spend_7d: number | null; booked_7d: number | null; cost_per_booked_7d: number | null; verdict: Colour | null;
  /** Why there is no verdict, in plain words. Null when there is one. */
  verdict_note: string | null;
};

const ACCOUNT_NUMBERS = [
  "days_live", "spend", "leads", "booked", "shows", "closes", "revenue", "cpl", "cost_per_booked", "booking_rate", "cost_per_show",
  "cost_per_close", "frequency", "ctr", "cpm", "spend_7d", "booked_7d", "cost_per_booked_7d",
] as const;

export async function getAccounts(window: WindowKey): Promise<AccountRow[]> {
  const supabase = await createClient();
  const days = daysOf(window);
  const { data, error } = await supabase.rpc("media_account_metrics", days === null ? {} : { p_days: days });
  if (error) throw new Error(`media_account_metrics: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => {
    const row = { ...r, ...Object.fromEntries(ACCOUNT_NUMBERS.map((k) => [k, n(r[k])])) } as unknown as AccountRow;
    const note = row.verdict
      ? null
      : row.unverified ? "unverified"
      : row.spend_7d === null ? "no spend loaded for the last 7 days"
      : "no bookings in 7d";
    return { ...row, verdict_note: note };
  });
}

/** Non-churned clinics with no Cortana business: listed, never counted. */
export async function getNotConnected(): Promise<{ id: string; name: string; stage: string }[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("clients").select("id, name, stage").is("deleted_at", null).neq("stage", "churned").is("cortana_business_id", null).order("name");
  if (error) throw new Error(`clients: ${error.message}`);
  return (data ?? []) as { id: string; name: string; stage: string }[];
}

// ---------------------------------------------------------------------------
// Per ad.
// ---------------------------------------------------------------------------
export type AdRow = {
  client_id: string; client_name: string; ad_id: string; ad_name: string | null; ad_status: string | null; is_active: boolean;
  spend: number | null; leads: number | null; booked: number | null; cost_per_booked: number | null; frequency: number | null; ctr: number | null;
  spend_7d: number | null; fatigue: boolean | null; fatigue_reason: string | null;
};
export const AD_LIMIT = 300;

/** Active ads first, then 7d spend, largest first. The figures shown follow the window (7d or all-time). */
export async function getAds(clientId: string | null, period: "7d" | "all"): Promise<AdRow[]> {
  const supabase = await createClient();
  let query = supabase
    .from("media_ad_metrics")
    .select("*")
    .order("is_active", { ascending: false })
    .order("spend_7d", { ascending: false, nullsFirst: false })
    .order("ad_id")
    .limit(AD_LIMIT);
  if (clientId) query = query.eq("client_id", clientId);
  const { data, error } = await query;
  if (error) throw new Error(`media_ad_metrics: ${error.message}`);
  const s = period === "7d" ? "_7d" : "_all";
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    client_id: r.client_id as string,
    client_name: r.client_name as string,
    ad_id: r.ad_id as string,
    ad_name: r.ad_name as string | null,
    ad_status: r.ad_status as string | null,
    is_active: r.is_active as boolean,
    spend: n(r[`spend${s}`]),
    leads: n(r[`leads${s}`]),
    booked: n(r[`booked${s}`]),
    cost_per_booked: n(r[`cost_per_booked${s}`]),
    frequency: n(r[`frequency${s}`]),
    ctr: n(r[`ctr${s}`]),
    spend_7d: n(r.spend_7d),
    fatigue: r.fatigue as boolean | null,
    fatigue_reason: r.fatigue_reason as string | null,
  }));
}

// ---------------------------------------------------------------------------
// One clinic's daily rows: what the account row adds up from.
// ---------------------------------------------------------------------------
export type DailyRow = { day: string; spend: number | null; leads: number | null; booked: number | null; shows: number | null; closes: number | null; revenue: number | null };
export type ClinicDaily = { from: string | null; to: string | null; rows: DailyRow[]; total: DailyRow | null };

const DAILY_KEYS = ["spend", "leads", "booked", "shows", "closes", "revenue"] as const;

/** today is the current ET date. 3d / 7d end yesterday, as in media_account_metrics. */
export async function getClinicDaily(clientId: string, window: WindowKey, today: string): Promise<ClinicDaily> {
  const supabase = await createClient();
  const days = daysOf(window);
  let query = supabase.from("client_performance_daily").select("day, spend, leads, booked, shows, closes, revenue").eq("client_id", clientId).order("day", { ascending: false });
  if (days !== null) query = query.gte("day", addDays(today, -days)).lte("day", addDays(today, -1));
  const { data, error } = await query;
  if (error) throw new Error(`client_performance_daily: ${error.message}`);
  const rows = ((data ?? []) as Record<string, unknown>[]).map((r) => ({ day: String(r.day), ...Object.fromEntries(DAILY_KEYS.map((k) => [k, n(r[k])])) }) as DailyRow);
  // A column's total is null when no day has a value: nothing loaded is not zero.
  const sum = (k: (typeof DAILY_KEYS)[number]) => (rows.some((r) => r[k] !== null) ? rows.reduce((a, r) => a + (r[k] ?? 0), 0) : null);
  return {
    from: days !== null ? addDays(today, -days) : (rows.at(-1)?.day ?? null),
    to: days !== null ? addDays(today, -1) : (rows[0]?.day ?? null),
    rows,
    total: rows.length ? { day: "Total", spend: sum("spend"), leads: sum("leads"), booked: sum("booked"), shows: sum("shows"), closes: sum("closes"), revenue: sum("revenue") } : null,
  };
}

// ---------------------------------------------------------------------------
// Scorecard.
// ---------------------------------------------------------------------------
export type ScoreCell = { display: string | null; detail: string | null; colour: Colour | null };
export type ScoreMetric = { metric: string; label: string; threshold: string | null; current: ScoreCell; previous: ScoreCell; currentOnly: boolean };
export type Scorecard = { staff_id: string; name: string; week_start: string; prev_week_start: string; metrics: ScoreMetric[] };

const SCORE_METRICS: { metric: string; key: string; currentOnly: boolean }[] = [
  { metric: "exceptions_24h_pct", key: "media_exceptions_24h_pct", currentOnly: false },
  { metric: "accounts_over_cpb", key: "media_accounts_over_cpb", currentOnly: true },
  { metric: "book_cpb_change_pct", key: "media_book_cpb_change_pct", currentOnly: true },
  { metric: "zero_spend_accounts", key: "media_zero_spend_accounts", currentOnly: true },
  { metric: "accounts_flagged_3d", key: "media_accounts_flagged_3d", currentOnly: true },
];

type Score = { staff_id: string; week_start: string; metric: string; value: number | null; numerator: number | null; denominator: number | null; colour: Colour | null };

function scoreCell(s: Score | undefined): ScoreCell {
  if (!s || s.value === null) return { display: null, detail: null, colour: null };
  if (s.metric === "exceptions_24h_pct") return { display: `${s.value}%`, detail: `${s.numerator} of ${s.denominator} resolved inside the limit`, colour: s.colour };
  if (s.metric === "book_cpb_change_pct") {
    return { display: `${s.value > 0 ? "+" : ""}${s.value}%`, detail: `${formatValue(s.numerator, "money")} now vs ${formatValue(s.denominator, "money")} the 7 days before`, colour: s.colour };
  }
  return { display: String(s.value), detail: `of ${s.denominator} live accounts`, colour: s.colour };
}

/** This week and last week for each media buyer. today is the current ET date. */
export async function getScorecards(today: string): Promise<Scorecard[]> {
  const supabase = await createClient();
  const isoDow = ((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
  const week = addDays(today, -(isoDow - 1));
  const prev = addDays(week, -7);
  const [staff, scores, config] = await Promise.all([
    supabase.from("staff").select("id, name").eq("role", "media_buyer").neq("status", "left").order("created_at"),
    supabase.from("score_media_weekly").select("staff_id, week_start, metric, value, numerator, denominator, colour").in("week_start", [week, prev]),
    getConfig(),
  ]);
  if (staff.error) throw new Error(`staff: ${staff.error.message}`);
  if (scores.error) throw new Error(`score_media_weekly: ${scores.error.message}`);
  const all = ((scores.data ?? []) as Record<string, unknown>[]).map((s) => ({
    staff_id: s.staff_id as string, week_start: String(s.week_start), metric: s.metric as string,
    value: n(s.value), numerator: n(s.numerator), denominator: n(s.denominator), colour: s.colour as Colour | null,
  }));
  return (staff.data ?? []).map((p) => ({
    staff_id: p.id as string,
    name: p.name as string,
    week_start: week,
    prev_week_start: prev,
    metrics: SCORE_METRICS.map((m) => {
      const find = (w: string) => all.find((s) => s.staff_id === p.id && s.week_start === w && s.metric === m.metric);
      const c = config.get(m.key);
      return {
        metric: m.metric,
        label: c?.label ?? m.metric,
        threshold: c ? describeConfig(c) : null,
        current: scoreCell(find(week)),
        previous: scoreCell(find(prev)),
        currentOnly: m.currentOnly,
      };
    }),
  }));
}
