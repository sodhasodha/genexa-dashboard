import "server-only";
import type { CurrentStaff } from "@/lib/auth/staff";
import { UK, formatDeadline, instantToLocal } from "@/lib/deadlines";
import { createClient } from "@/lib/supabase/server";

export const JOB_TYPES = ["launch", "fix", "build", "other"] as const;
export const JOB_STATUSES = ["todo", "working", "stuck", "done"] as const;
export const PAUSE_REASONS = ["client_access", "client_approval", "client_assets", "third_party"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const PAUSE_REASON_LABEL: Record<string, string> = {
  client_access: "waiting on client access",
  client_approval: "waiting on client approval",
  client_assets: "waiting on client assets",
  third_party: "waiting on a third party",
};

export type TechJob = {
  id: string;
  type: string;
  title: string;
  notes: string | null;
  client_name: string | null;
  requested_by_name: string | null;
  owner_name: string | null;
  /** ET, e.g. "Mon 5 Oct 14:30". */
  requested: string | null;
  due: string | null;
  /** The due time in UK time, for the owner who sets deadlines in UK time. */
  due_uk: string | null;
  /** True when the owner replaced the automatic due time with their own. */
  deadline_overridden: boolean;
  /** UK wall-clock value for the deadline box ("2026-10-14T15:00"); empty when nothing is due. */
  deadline_uk_input: string;
  done: string | null;
  /** e.g. "2h 10m". Fix jobs count business minutes (09:00-17:00 ET, Mon-Fri). */
  genexa_time: string | null;
  paused_time: string | null;
  sla_time: string | null;
  status: JobStatus;
  blocked_on: string | null;
  is_paused: boolean;
  pause_reason: string | null;
  pause_evidence: string | null;
  is_overdue: boolean;
  met_sla: boolean | null;
  pause_count: number;
  /** The viewer owns this job or is the app owner. */
  can_edit: boolean;
};

export type ScoreCell = {
  metric: string;
  label: string;
  /** Formatted value, null = no data. */
  value: string | null;
  /** e.g. "2 of 3". */
  detail: string | null;
  colour: "green" | "amber" | "red" | null;
  /** Thresholds in plain words, from scoring_config. Null for a metric that is not scored. */
  target: string | null;
};
export type ScoreWeek = { week_start: string; label: string; cells: ScoreCell[] };
export type TechScorecard = { tech_name: string | null; weeks: ScoreWeek[] };

type BoardRow = {
  tech_job_id: string; type: string; title: string; notes: string | null; client_name: string | null;
  requested_by_name: string | null; owner_id: string | null; owner_name: string | null;
  requested_at: string | null; due_at: string | null; due_override: string | null; done_at: string | null; status: JobStatus; blocked_on: string | null;
  sla_minutes: number | null; genexa_minutes: number | null; paused_minutes: number | null; pause_count: number | null;
  is_paused: boolean | null; is_overdue: boolean | null; met_sla: boolean | null;
  pause_reason: string | null; pause_evidence: string | null;
};
const BOARD_COLUMNS =
  "tech_job_id, type, title, notes, client_name, requested_by_name, owner_id, owner_name, requested_at, due_at, due_override, done_at, status, blocked_on, " +
  "sla_minutes, genexa_minutes, paused_minutes, pause_count, is_paused, is_overdue, met_sla, pause_reason, pause_evidence";

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Minutes as "45m", "2h 10m", "3d 4h". Null in, null out. */
export function formatDuration(minutes: number | null): string | null {
  if (minutes === null || Number.isNaN(minutes)) return null;
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return m % 60 === 0 ? `${m / 60}h` : `${Math.floor(m / 60)}h ${m % 60}m`;
  const d = Math.floor(m / (60 * 24));
  const h = Math.floor((m - d * 60 * 24) / 60);
  return h === 0 ? `${d}d` : `${d}d ${h}h`;
}

const ET_STAMP = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/New_York", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** An instant as ET wall time, e.g. "Mon 5 Oct 14:30". */
export function formatEt(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const part = Object.fromEntries(ET_STAMP.formatToParts(at).map((p) => [p.type, p.value]));
  return `${part.weekday} ${part.day} ${part.month} ${part.hour}:${part.minute}`;
}

function toJob(r: BoardRow, me: CurrentStaff): TechJob {
  return {
    id: r.tech_job_id,
    type: r.type,
    title: r.title,
    notes: r.notes,
    client_name: r.client_name,
    requested_by_name: r.requested_by_name,
    owner_name: r.owner_name,
    requested: formatEt(r.requested_at),
    due: formatEt(r.due_at),
    due_uk: formatDeadline(r.due_at, UK),
    deadline_overridden: r.due_override !== null && r.due_override !== undefined,
    deadline_uk_input: instantToLocal(r.due_at),
    done: formatEt(r.done_at),
    genexa_time: formatDuration(num(r.genexa_minutes)),
    paused_time: formatDuration(num(r.paused_minutes)),
    sla_time: formatDuration(num(r.sla_minutes)),
    status: r.status,
    blocked_on: r.blocked_on,
    is_paused: r.is_paused === true,
    pause_reason: r.pause_reason ? (PAUSE_REASON_LABEL[r.pause_reason] ?? r.pause_reason) : null,
    pause_evidence: r.pause_evidence,
    is_overdue: r.is_overdue === true,
    met_sla: r.met_sla,
    pause_count: num(r.pause_count) ?? 0,
    can_edit: me.role === "owner" || (r.owner_id !== null && r.owner_id === me.id),
  };
}

/** Jobs not yet done: overdue first, then by due time (jobs with no due time last). */
export async function getOpenJobs(me: CurrentStaff): Promise<TechJob[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tech_jobs_board")
    .select(BOARD_COLUMNS)
    .neq("status", "done")
    .order("is_overdue", { ascending: false })
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("requested_at", { ascending: true });
  if (error) throw new Error(`tech_jobs_board: ${error.message}`);
  return ((data ?? []) as unknown as BoardRow[]).map((r) => toJob(r, me));
}

/** Jobs completed in the current ET week (Mon-Sun), newest first. */
export async function getDoneThisWeek(me: CurrentStaff): Promise<TechJob[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tech_jobs_board")
    .select(BOARD_COLUMNS)
    .eq("done_this_week", true)
    .order("done_at", { ascending: false });
  if (error) throw new Error(`tech_jobs_board: ${error.message}`);
  return ((data ?? []) as unknown as BoardRow[]).map((r) => toJob(r, me));
}

export async function getClientOptions(): Promise<{ id: string; name: string }[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("clients").select("id, name").is("deleted_at", null).neq("stage", "churned").order("name");
  if (error) throw new Error(`clients: ${error.message}`);
  return data ?? [];
}

const METRICS: { metric: string; label: string; config_key: string | null; unit: "%" | "count" }[] = [
  { metric: "launch_sla_pct", label: "Launches within SLA", config_key: "tech_launch_sla_pct", unit: "%" },
  { metric: "fix_sla_pct", label: "Fixes within SLA", config_key: "tech_fix_sla_pct", unit: "%" },
  { metric: "broken_week1", label: "Launches broken in week 1", config_key: "tech_broken_week1", unit: "count" },
  { metric: "paused_pct", label: "Jobs paused at least once", config_key: null, unit: "%" },
  // From score_tasks_weekly: tasks with a deadline in the week, done by the deadline.
  { metric: "tasks_on_time_pct", label: "Tasks done on time", config_key: "tasks_on_time_pct", unit: "%" },
];

type ConfigRow = { key: string; direction: string; green: number | null; amber: number | null };

function targetText(c: ConfigRow | undefined, unit: "%" | "count"): string | null {
  if (!c || c.green === null || c.amber === null) return null;
  const u = unit === "%" ? "%" : "";
  const [g, a] = [Number(c.green), Number(c.amber)];
  return c.direction === "lower_better"
    ? `green up to ${g}${u}, amber up to ${a}${u}, red above`
    : `green from ${g}${u}, amber from ${a}${u}, red below`;
}

function weekLabel(weekStart: string, index: number): string {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(`${weekStart}T12:00:00Z`));
  return `${index === 0 ? "This week" : "Last week"} (from Mon ${day})`;
}

/** The tech person's scorecard for the current and the previous ET week, from score_tech_weekly. */
export async function getTechScorecard(): Promise<TechScorecard> {
  const supabase = await createClient();
  const holder = await supabase.rpc("app_role_holder", { p_role: "tech" });
  if (holder.error) throw new Error(`app_role_holder: ${holder.error.message}`);
  const techId = (holder.data as string | null) ?? null;
  if (!techId) return { tech_name: null, weeks: [] };

  const [who, scores, taskScores, config] = await Promise.all([
    supabase.from("staff").select("name").eq("id", techId).maybeSingle(),
    supabase
      .from("score_tech_weekly")
      .select("week_start, metric, value, numerator, denominator, colour")
      .eq("staff_id", techId)
      .order("week_start", { ascending: false })
      .limit(METRICS.length * 2),
    supabase
      .from("score_tasks_weekly")
      .select("week_start, metric, value, numerator, denominator, colour")
      .eq("staff_id", techId)
      .order("week_start", { ascending: false })
      .limit(2),
    supabase.from("scoring_config").select("key, direction, green, amber").in("card", ["tech", "tasks"]),
  ]);
  if (scores.error) throw new Error(`score_tech_weekly: ${scores.error.message}`);
  if (taskScores.error) throw new Error(`score_tasks_weekly: ${taskScores.error.message}`);
  if (config.error) throw new Error(`scoring_config: ${config.error.message}`);

  const configByKey = new Map((config.data ?? []).map((c) => [c.key, c as ConfigRow]));
  const rows = [...(scores.data ?? []), ...(taskScores.data ?? [])];
  const weekStarts = [...new Set(rows.map((r) => r.week_start as string))].sort().reverse();
  const weeks = weekStarts.map((week_start, i) => ({
    week_start,
    label: weekLabel(week_start, i),
    cells: METRICS.map((m): ScoreCell => {
      const row = rows.find((r) => r.week_start === week_start && r.metric === m.metric);
      const value = num(row?.value);
      const [numerator, denominator] = [num(row?.numerator), num(row?.denominator)];
      return {
        metric: m.metric,
        label: m.label,
        value: value === null ? null : m.unit === "%" ? `${value}%` : String(value),
        detail: numerator === null || denominator === null || denominator === 0 ? null : `${numerator} of ${denominator}`,
        colour: (row?.colour as ScoreCell["colour"]) ?? null,
        target: m.config_key ? targetText(configByKey.get(m.config_key), m.unit) : null,
      };
    }),
  }));
  return { tech_name: who.data?.name ?? null, weeks };
}
