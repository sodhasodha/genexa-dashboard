import "server-only";
import type { CurrentStaff } from "@/lib/auth/staff";
import { createClient } from "@/lib/supabase/server";
import { etToday } from "@/lib/time";

export const LAUNCH_STAGES = ["paid", "ob_call_booked", "ob_call_done", "ob_form_complete", "access_granted", "built", "qc_passed", "live"] as const;
export type LaunchStage = (typeof LAUNCH_STAGES)[number];
export const QC_FIELDS = ["qc_lead_access", "qc_calendar_tested", "qc_test_lead_deleted", "qc_pixel_firing", "qc_cortana_connected", "qc_clinic_sheet"] as const;
export type QcField = (typeof QC_FIELDS)[number];

export type LaunchCard = {
  launch_id: string;
  client_id: string;
  client_name: string;
  owner_name: string | null;
  stage: LaunchStage;
  next_stage: LaunchStage | null;
  prev_stage: LaunchStage | null;
  /** ET day payment was recorded. Null = no payment date on the launch. */
  paid_on: string | null;
  live_on: string | null;
  ob_form_done: boolean;
  access_done: boolean;
  qc: Record<QcField, boolean>;
  qc_done: number;
  qc_all: boolean;
  broke_week1: boolean;
  days_waiting: number | null;
  waiting_colour: "green" | "amber" | "red" | null;
  days_paid_to_live: number | null;
  clock_started: boolean;
  sla_hours_elapsed: number | null;
  sla_hours_allowed: number | null;
  is_paused: boolean;
  is_overdue: boolean | null;
  met_sla: boolean | null;
  pause_reason: string | null;
  pause_note: string | null;
  paused_on: string | null;
  /** The launch's owner or the app owner. */
  can_act: boolean;
  /** App owner only. */
  can_move_back: boolean;
};
export type LaunchColumn = { stage: LaunchStage; cards: LaunchCard[] };
export type LaunchBoard = {
  columns: LaunchColumn[];
  /** Clients with no open launch, for the "start a launch" form (owner only). */
  candidates: { id: string; name: string; stage: string }[];
  today: string;
  /** Days a live launch stays on the board (scoring_config). */
  liveDays: number | null;
};

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const day = (ts: string | null | undefined): string | null => (ts ? etToday(new Date(ts)) : null);

/** The kanban, grouped by stage from launch_board, with what this person may do on each card. */
export async function getLaunchBoard(me: CurrentStaff): Promise<LaunchBoard> {
  const supabase = await createClient();
  const isOwner = me.role === "owner";
  const [board, clients, open, config] = await Promise.all([
    supabase.from("launch_board").select("*").order("paid_at", { ascending: true, nullsFirst: true }),
    isOwner
      ? supabase.from("clients").select("id, name, stage").is("deleted_at", null).neq("stage", "churned").order("name")
      : Promise.resolve({ data: [], error: null }),
    isOwner ? supabase.from("launches").select("client_id").is("live_at", null) : Promise.resolve({ data: [], error: null }),
    supabase.from("scoring_config").select("value").eq("key", "launch_board_live_days").maybeSingle(),
  ]);
  for (const r of [board, clients, open, config]) if (r.error) throw new Error(`launch board: ${r.error.message}`);

  const cards: LaunchCard[] = ((board.data ?? []) as Record<string, unknown>[]).map((r) => ({
    launch_id: r.launch_id as string,
    client_id: r.client_id as string,
    client_name: r.client_name as string,
    owner_name: r.owner_name as string | null,
    stage: r.stage as LaunchStage,
    next_stage: r.next_stage as LaunchStage | null,
    prev_stage: r.prev_stage as LaunchStage | null,
    paid_on: day(r.paid_at as string | null),
    live_on: day(r.live_at as string | null),
    ob_form_done: r.ob_form_done_at !== null,
    access_done: r.access_done_at !== null,
    qc: Object.fromEntries(QC_FIELDS.map((f) => [f, r[f] === true])) as Record<QcField, boolean>,
    qc_done: Number(r.qc_done),
    qc_all: r.qc_all === true,
    broke_week1: r.broke_week1 === true,
    days_waiting: n(r.days_waiting),
    waiting_colour: r.waiting_colour as LaunchCard["waiting_colour"],
    days_paid_to_live: n(r.days_paid_to_live),
    clock_started: r.clock_started === true,
    sla_hours_elapsed: n(r.sla_hours_elapsed),
    sla_hours_allowed: n(r.sla_hours_allowed),
    is_paused: r.is_paused === true,
    is_overdue: r.is_overdue as boolean | null,
    met_sla: r.met_sla as boolean | null,
    pause_reason: r.pause_reason as string | null,
    pause_note: r.pause_note as string | null,
    paused_on: day(r.paused_at as string | null),
    can_act: isOwner || r.owner_id === me.id,
    can_move_back: isOwner,
  }));

  const hasOpen = new Set((open.data ?? []).map((l) => l.client_id as string));
  return {
    columns: LAUNCH_STAGES.map((stage) => ({ stage, cards: cards.filter((c) => c.stage === stage) })),
    candidates: (clients.data ?? []).filter((c) => !hasOpen.has(c.id as string)) as LaunchBoard["candidates"],
    today: etToday(),
    liveDays: n(config.data?.value),
  };
}
