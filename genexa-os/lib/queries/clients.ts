import "server-only";
import { createClient } from "@/lib/supabase/server";
import { etToday } from "@/lib/time";

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
/** ET calendar day of a stored timestamp. */
const day = (ts: string | null | undefined): string | null => (ts ? etToday(new Date(ts)) : null);

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
export const STAGES = ["unlaunched", "onboarding", "live", "paused", "churned"] as const;
export const PODS = ["pod_1", "pod_2", "pod_3"] as const;
const FIRST_MONTH = "2026-08";

/** Column a header sorts by -> column of client_list() to order on. */
const SORT_COLUMN = {
  name: "name", stage: "stage", pod: "pod", health: "health_rank", days_live: "days_live", monthly_fee: "monthly_fee",
  renewal: "renewal_date", guarantee: "guarantee_deadline",
  spend: "spend", leads: "leads", booked: "booked", confirmed: "confirmed", shows: "shows", closes: "closes", revenue: "revenue",
  cpl: "cpl", cost_per_booked: "cost_per_booked", booking_rate: "booking_rate", confirmation_rate: "confirmation_rate",
  show_rate: "show_rate", close_rate: "close_rate", ctr: "ctr", roas: "roas",
  last_contact_us: "last_contact_us", last_reply_client: "last_reply_client", next_action: "next_action",
} as const;
export type SortKey = keyof typeof SORT_COLUMN;

export type ClientListParams = {
  view: "list" | "lanes";
  month: string; // YYYY-MM
  months: string[]; // newest first, from 2026-08 to the current ET month
  sort: SortKey;
  dir: "asc" | "desc";
  stage: string | null;
  pod: string | null;
};

type RawParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Reads and validates the page's query string. Anything unrecognised falls back to the default. */
export function parseClientListParams(params: RawParams): ClientListParams {
  const current = etToday().slice(0, 7);
  const months: string[] = [];
  for (let m = current; m >= FIRST_MONTH; ) {
    months.push(m);
    const [y, mo] = m.split("-").map(Number);
    m = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
  }
  if (months.length === 0) months.push(current);
  const month = first(params.month);
  const sort = first(params.sort);
  const stage = first(params.stage);
  const pod = first(params.pod);
  return {
    view: first(params.view) === "lanes" ? "lanes" : "list",
    month: month && months.includes(month) ? month : months[0],
    months,
    sort: sort && sort in SORT_COLUMN ? (sort as SortKey) : "name",
    dir: first(params.dir) === "desc" ? "desc" : "asc",
    stage: stage && (STAGES as readonly string[]).includes(stage) ? stage : null,
    pod: pod && (PODS as readonly string[]).includes(pod) ? pod : null,
  };
}

export type AdsState = "ok" | "not_connected" | "unverified";
export type ClientListRow = {
  client_id: string; name: string; stage: string; pod: string | null; churned: boolean;
  health_colour: string | null; health_reasons: string | null;
  days_live: number | null; monthly_fee: number | null;
  renewal_date: string | null; renewal_status: string | null; renewal_amount: number | null;
  guarantee_text: string | null; guarantee_target_amount: number | null; guarantee_deadline: string | null;
  rev_share_type: string; rev_share_rate: number | null; rev_share_per_patient: number | null;
  ads_state: AdsState;
  spend: number | null; leads: number | null; booked: number | null; confirmed: number | null; shows: number | null;
  closes: number | null; revenue: number | null; cpl: number | null; cost_per_booked: number | null;
  booking_rate: number | null; confirmation_rate: number | null; show_rate: number | null; close_rate: number | null;
  ctr: number | null; roas: number | null;
  last_contact_us: string | null; last_reply_client: string | null; next_action: string | null;
};

const NUMERIC: (keyof ClientListRow)[] = [
  "days_live", "monthly_fee", "renewal_amount", "guarantee_target_amount", "spend", "leads", "booked", "confirmed", "shows",
  "closes", "revenue", "cpl", "cost_per_booked", "booking_rate", "confirmation_rate", "show_rate", "close_rate", "ctr", "roas",
];

/** One row per non-deleted client for the month. Churned clients always sort last; nulls sort last. */
export async function getClientList(p: ClientListParams): Promise<ClientListRow[]> {
  const supabase = await createClient();
  let q = supabase.rpc("client_list", { p_month: `${p.month}-01` });
  if (p.stage) q = q.eq("stage", p.stage);
  if (p.pod) q = q.eq("pod", p.pod);
  const { data, error } = await q
    .order("churned")
    .order(SORT_COLUMN[p.sort], { ascending: p.dir === "asc", nullsFirst: false })
    .order("name");
  if (error) throw new Error(`client_list: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => {
    const row = { ...r } as Record<string, unknown>;
    for (const k of NUMERIC) row[k] = n(r[k]);
    row.last_contact_us = day(r.last_contact_us as string | null);
    row.last_reply_client = day(r.last_reply_client as string | null);
    return row as ClientListRow;
  });
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------
export const LANES = ["launch", "ads", "call_centre", "outcomes", "contact"] as const;
export type Lane = (typeof LANES)[number];
export type LaneCell = { colour: "red" | "amber" | "green" | "grey"; reason: string };
export type ClientLanesRow = { client_id: string; name: string; stage: string; pod: string | null; lanes: Partial<Record<Lane, LaneCell>> };

/** One row per client from client_lanes, churned last. */
export async function getClientLanes(p: Pick<ClientListParams, "stage" | "pod">): Promise<ClientLanesRow[]> {
  const supabase = await createClient();
  let q = supabase.from("client_lanes").select("client_id, name, stage, pod, lane, colour, reason");
  if (p.stage) q = q.eq("stage", p.stage);
  if (p.pod) q = q.eq("pod", p.pod);
  const { data, error } = await q.order("name").order("lane_order");
  if (error) throw new Error(`client_lanes: ${error.message}`);
  const byClient = new Map<string, ClientLanesRow>();
  for (const r of data ?? []) {
    const row: ClientLanesRow = byClient.get(r.client_id) ?? { client_id: r.client_id, name: r.name, stage: r.stage, pod: r.pod, lanes: {} };
    row.lanes[r.lane as Lane] = { colour: r.colour, reason: r.reason };
    byClient.set(r.client_id, row);
  }
  const rows = [...byClient.values()];
  return [...rows.filter((r) => r.stage !== "churned"), ...rows.filter((r) => r.stage === "churned")];
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------
export type ClientRecord = {
  id: string; name: string; contact_name: string | null; cortana_business_id: string | null;
  stage: string; pod: string | null; billing_cycle: string | null;
  cycle_fee: number | null; monthly_fee: number | null; launch_date: string | null;
  guarantee_text: string | null; guarantee_target_amount: number | null; guarantee_deadline: string | null;
  rev_share_type: string; rev_share_rate: number | null; rev_share_per_patient: number | null;
  next_action: string | null;
  /** ET days of the stored timestamps. */
  last_contact_us: string | null; last_reply_client: string | null;
};
export type ClientMtd = Pick<ClientListRow,
  "spend" | "leads" | "booked" | "confirmed" | "shows" | "closes" | "revenue" | "cpl" | "cost_per_booked" | "booking_rate"
  | "confirmation_rate" | "show_rate" | "close_rate" | "ctr" | "roas">;
export type ClientProfile = {
  client: ClientRecord;
  health: { colour: string | null; reasons: string | null } | null;
  renewal: { renewal_date: string | null; renewal_amount: number | null; status: string | null; days_until: number | null } | null;
  scope: { campaign_name_contains: string | null; verified: boolean; note: string | null } | null;
  ads_state: AdsState;
  /** This ET month from client_mtd. Null = nothing recorded this month. */
  mtd: ClientMtd | null;
  exceptions: { severity: string; reason: string; status: string; first_seen: string; money_at_risk: number | null; resolved: string | null }[];
  payments: { id: string; paid_on: string; product: string | null; amount: number; status: string }[];
  memberships: { id: string; product: string | null; status: string | null; valid: boolean; cancelling: boolean; renews_on: string | null; price: number | null; period_days: number | null }[];
  touches: { id: string; on: string; kind: string; by: string | null; note: string | null }[];
  tech_jobs: { id: string; title: string; type: string; status: string; requested_on: string; due_on: string | null; done_on: string | null; overdue: boolean | null }[];
  locations: { id: string; name: string; address: string | null; doctors: string[]; price_points: string | null; calendar_url: string | null }[];
};

const MTD_KEYS: (keyof ClientMtd)[] = [
  "spend", "leads", "booked", "confirmed", "shows", "closes", "revenue", "cpl", "cost_per_booked", "booking_rate",
  "confirmation_rate", "show_rate", "close_rate", "ctr", "roas",
];

/** Everything the profile page shows for one clinic. Null when the client does not exist or is deleted. */
export async function getClientProfile(id: string): Promise<ClientProfile | null> {
  const supabase = await createClient();
  const { data: c, error } = await supabase
    .from("clients")
    .select("id, name, contact_name, cortana_business_id, stage, pod, billing_cycle, cycle_fee, monthly_fee, launch_date, guarantee_text, guarantee_target_amount, guarantee_deadline, rev_share_type, rev_share_rate, rev_share_per_patient, next_action, last_contact_us, last_reply_client")
    .eq("id", id).is("deleted_at", null).maybeSingle();
  if (error) throw new Error(`clients: ${error.message}`);
  if (!c) return null;

  const [health, renewal, scope, mtd, exceptions, payments, memberships, touches, jobs, locations, staff] = await Promise.all([
    supabase.from("client_health").select("colour, reasons").eq("client_id", id).maybeSingle(),
    supabase.from("renewals").select("renewal_date, renewal_amount, status, days_until").eq("client_id", id).maybeSingle(),
    supabase.from("client_campaign_scope").select("campaign_name_contains, verified, note").eq("client_id", id).maybeSingle(),
    supabase.from("client_mtd").select(MTD_KEYS.join(", ")).eq("client_id", id).maybeSingle(),
    supabase.from("exceptions").select("severity, reason, status, first_detected_at, money_at_risk, resolved_at, resolved_by").eq("client_id", id).order("first_detected_at", { ascending: false }).limit(50),
    supabase.from("payments").select("id, paid_at, product_title, amount, status").eq("client_id", id).order("paid_at", { ascending: false }).limit(100),
    supabase.from("whop_memberships").select("id, product_title, status, valid, cancel_at_period_end, renewal_period_end, renewal_price, billing_period_days").eq("client_id", id).order("renewal_period_end", { ascending: false, nullsFirst: false }),
    supabase.from("touches").select("id, at, kind, by_id, note").eq("client_id", id).is("deleted_at", null).order("at", { ascending: false }).limit(100),
    supabase.from("tech_jobs").select("id, title, type, status, requested_at, due_at, done_at").eq("client_id", id).is("deleted_at", null).order("requested_at", { ascending: false }).limit(100),
    supabase.from("client_locations").select("id, name, address, doctors, price_points, calendar_url").eq("client_id", id).is("deleted_at", null).order("name"),
    supabase.from("staff").select("id, name"),
  ]);
  for (const r of [health, renewal, scope, mtd, exceptions, payments, memberships, touches, jobs, locations, staff]) {
    if (r.error) throw new Error(`client profile: ${r.error.message}`);
  }
  const jobIds = (jobs.data ?? []).map((j) => j.id as string);
  const sla = jobIds.length
    ? await supabase.from("tech_job_sla").select("tech_job_id, is_overdue").in("tech_job_id", jobIds)
    : { data: [], error: null };
  if (sla.error) throw new Error(`tech_job_sla: ${sla.error.message}`);
  const overdue = new Map((sla.data ?? []).map((s) => [s.tech_job_id as string, s.is_overdue as boolean | null]));
  const staffName = new Map((staff.data ?? []).map((s) => [s.id as string, s.name as string]));
  const mtdRow = mtd.data as Record<string, unknown> | null;

  return {
    client: {
      ...c,
      cycle_fee: n(c.cycle_fee), monthly_fee: n(c.monthly_fee), guarantee_target_amount: n(c.guarantee_target_amount), rev_share_rate: n(c.rev_share_rate), rev_share_per_patient: n(c.rev_share_per_patient),
      last_contact_us: day(c.last_contact_us), last_reply_client: day(c.last_reply_client),
    },
    health: health.data,
    renewal: renewal.data ? { ...renewal.data, renewal_amount: n(renewal.data.renewal_amount) } : null,
    scope: scope.data,
    ads_state: !c.cortana_business_id ? "not_connected" : scope.data && !scope.data.verified ? "unverified" : "ok",
    mtd: mtdRow ? (Object.fromEntries(MTD_KEYS.map((k) => [k, n(mtdRow[k])])) as ClientMtd) : null,
    exceptions: (exceptions.data ?? []).map((e) => ({
      severity: e.severity, reason: e.reason, status: e.status, first_seen: day(e.first_detected_at) ?? "", money_at_risk: n(e.money_at_risk),
      resolved: e.status !== "resolved" ? null : e.resolved_by === "system" ? `cleared on its own, ${day(e.resolved_at) ?? ""}` : `resolved by ${e.resolved_by ?? "someone"}, ${day(e.resolved_at) ?? ""}`,
    })),
    payments: (payments.data ?? []).map((p) => ({ id: p.id, paid_on: day(p.paid_at) ?? "", product: p.product_title, amount: Number(p.amount), status: p.status })),
    memberships: (memberships.data ?? []).map((m) => ({
      id: m.id, product: m.product_title, status: m.status, valid: m.valid, cancelling: m.cancel_at_period_end,
      renews_on: day(m.renewal_period_end), price: n(m.renewal_price), period_days: n(m.billing_period_days),
    })),
    touches: (touches.data ?? []).map((t) => ({ id: t.id, on: day(t.at) ?? "", kind: t.kind, by: t.by_id ? (staffName.get(t.by_id) ?? null) : null, note: t.note })),
    tech_jobs: (jobs.data ?? []).map((j) => ({
      id: j.id, title: j.title, type: j.type, status: j.status, requested_on: day(j.requested_at) ?? "",
      due_on: day(j.due_at), done_on: day(j.done_at), overdue: overdue.get(j.id) ?? null,
    })),
    locations: (locations.data ?? []).map((l) => ({ ...l, doctors: (l.doctors ?? []) as string[] })),
  };
}

/** A clinic's client-dashboard login. Row security returns nothing to anyone but the owner. */
export async function getDashboardLogin(clientId: string): Promise<{ username: string; password: string } | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("client_dashboard_logins").select("username, password").eq("client_id", clientId).maybeSingle();
  return data ? { username: data.username as string, password: data.password as string } : null;
}
