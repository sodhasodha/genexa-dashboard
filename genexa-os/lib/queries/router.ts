import "server-only";
import { UK, formatDeadline, instantToLocal } from "@/lib/deadlines";
import { createClient } from "@/lib/supabase/server";

export type RouterOwner = "tech" | "ads" | "ryan";
export const OWNER_LABEL: Record<RouterOwner, string> = { tech: "Tech", ads: "Ads", ryan: "Ryan" };

export type RouterRow = {
  id: string;
  client_id: string;
  client_name: string;
  channel_kind: "general" | "scheduling";
  text: string;
  permalink: string;
  received_at: string;
  mode: "live" | "backfill";
  status: string;
  is_request: boolean | null;
  owner: RouterOwner | null;
  assigned_owner: RouterOwner | null;
  title: string | null;
  due_at: string | null;
  urgency: "normal" | "urgent" | null;
  confidence: number | null;
  tech_type: "fix" | "other" | null;
  triage_reason: string | null;
  routed_table: "tasks" | "tech_jobs" | "exceptions" | null;
  routed_id: string | null;
  verdict: "right" | "wrong" | null;
  timezone: string;
  /** The deadline the work has, or will get when the request is assigned or approved (client_request_deadlines). */
  deadline: RequestDeadline;
};

export type DeadlineSource = "item" | "set" | "message" | "next_shift" | "sla" | "on_assign" | "none";
export type RequestDeadline = {
  /** UK time, e.g. "Wed 14 Oct, 15:00 BST". Null when there is no instant to show. */
  label: string | null;
  /** UK wall-clock value for the date and time box. */
  input: string;
  source: DeadlineSource;
  /** Still in Triage or awaiting approval: the owner can set it. */
  can_change: boolean;
};
const NO_DEADLINE: RequestDeadline = { label: null, input: "", source: "none", can_change: false };

/** Adds each request's deadline. One query for the page of rows. */
async function withDeadlines(supabase: Awaited<ReturnType<typeof createClient>>, rows: Omit<RouterRow, "deadline">[]): Promise<RouterRow[]> {
  if (rows.length === 0) return [];
  const { data, error } = await supabase.from("client_request_deadlines").select("request_id, deadline_at, source, can_change").in("request_id", rows.map((r) => r.id));
  if (error) throw new Error(`client_request_deadlines: ${error.message}`);
  const by = new Map((data ?? []).map((d) => [d.request_id as string, d]));
  return rows.map((r) => {
    const d = by.get(r.id);
    return {
      ...r,
      deadline: d
        ? { label: formatDeadline(d.deadline_at as string | null, UK), input: instantToLocal(d.deadline_at as string | null), source: d.source as DeadlineSource, can_change: d.can_change === true }
        : NO_DEADLINE,
    };
  });
}

const COLUMNS =
  "id, client_id, channel_kind, text, permalink, received_at, mode, status, is_request, owner, assigned_owner, title, due_at, urgency, confidence, tech_type, triage_reason, routed_table, routed_id, verdict, clients(name, timezone)";

type Raw = Omit<RouterRow, "client_name" | "timezone" | "confidence"> & {
  confidence: number | string | null;
  clients: { name: string; timezone: string | null } | { name: string; timezone: string | null }[] | null;
};

const tidy = (rows: unknown[] | null): Omit<RouterRow, "deadline">[] =>
  ((rows ?? []) as Raw[]).map(({ clients, confidence, ...r }) => {
    const c = Array.isArray(clients) ? clients[0] : clients;
    return { ...r, confidence: confidence === null ? null : Number(confidence), client_name: c?.name ?? "Unknown clinic", timezone: c?.timezone ?? "America/New_York" };
  });

/** Every message the model has classified, newest first. */
export async function getRouterLog(limit = 200): Promise<RouterRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("client_requests").select(COLUMNS).not("classified_at", "is", null).order("received_at", { ascending: false }).limit(limit);
  if (error) throw new Error(`client_requests: ${error.message}`);
  return withDeadlines(supabase, tidy(data));
}

/** Requests found by a backfill that nobody has approved or rejected yet. */
export async function getBackfillPending(): Promise<RouterRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("client_requests").select(COLUMNS).eq("status", "pending_approval").order("received_at", { ascending: false }).limit(200);
  if (error) throw new Error(`client_requests: ${error.message}`);
  return withDeadlines(supabase, tidy(data));
}

export type HandledRow = { id: string; client_name: string; label: string; permalink: string; handled_by: string | null; handled_at: string };

/** Triage items cleared because we had already replied in Slack, latest first. Label = the title, or the first 80 characters. */
export async function getHandledInSlack(limit = 50): Promise<HandledRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("client_requests").select("id, title, text, permalink, handled_by, handled_at, clients(name)")
    .eq("status", "handled").order("handled_at", { ascending: false }).limit(limit);
  if (error) throw new Error(`client_requests: ${error.message}`);
  type Row = { id: string; title: string | null; text: string; permalink: string; handled_by: string | null; handled_at: string; clients: { name: string } | { name: string }[] | null };
  return ((data ?? []) as Row[]).map((r) => {
    const c = Array.isArray(r.clients) ? r.clients[0] : r.clients;
    const flat = r.text.replace(/\s+/g, " ").trim();
    return {
      id: r.id, client_name: c?.name ?? "Unknown clinic", label: r.title?.trim() || (flat.length > 80 ? `${flat.slice(0, 80)}…` : flat),
      permalink: r.permalink, handled_by: r.handled_by, handled_at: r.handled_at,
    };
  });
}

export type AccuracyRow = { window_days: 7 | 30; owner: "all" | RouterOwner | "none"; classified: number; judged: number; right_count: number; wrong_count: number; accuracy_pct: number | null };

export async function getRouterAccuracy(): Promise<AccuracyRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("router_accuracy").select("window_days, owner, classified, judged, right_count, wrong_count, accuracy_pct");
  if (error) throw new Error(`router_accuracy: ${error.message}`);
  return ((data ?? []) as AccuracyRow[]).map((r) => ({ ...r, accuracy_pct: r.accuracy_pct === null ? null : Number(r.accuracy_pct) }));
}

/** Where the work a request was turned into can be opened. */
export function routedHref(row: Pick<RouterRow, "routed_table" | "routed_id">): string | null {
  if (!row.routed_table || !row.routed_id) return null;
  if (row.routed_table === "tasks") return `/tasks?task=${row.routed_id}`;
  if (row.routed_table === "tech_jobs") return `/tech?job=${row.routed_id}`;
  return `/overview?exception=${row.routed_id}`;
}
