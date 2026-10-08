import "server-only";
import { createClient } from "@/lib/supabase/server";
import { formatValue } from "@/lib/format";
import { REASON_LABEL } from "@/lib/pipeline/reasons";
import { formatDay } from "./dates";

export const STAGES = [
  { key: "chase", label: "Chase" },
  { key: "contract_out", label: "Contract out" },
  { key: "paid", label: "Paid" },
  { key: "dead", label: "Dead" },
] as const;
export type StageKey = (typeof STAGES)[number]["key"];
const STAGE_LABEL: Record<string, string> = Object.fromEntries(STAGES.map((s) => [s.key, s.label]));

export type Prospect = {
  id: string;
  name: string;
  /** Only ever loaded for the app owner. Null for everyone else, and when not recorded. */
  contact: string | null;
  heat: string | null;
  state: string | null;
  call_date: string | null;
  call_label: string | null;
  what_they_want: string | null;
  objection: string | null;
  promised: string | null;
  follow_up_date: string | null;
  follow_up_label: string | null;
  /** From prospect_follow_ups: set only while the follow-up is late and the prospect is still being worked. */
  days_overdue: number | null;
  deal_size: number | null;
  deal_label: string | null;
  /** The Fathom recording, only when the stored value is a web link. */
  fathom_link: string | null;
  fathom_url: string | null;
  stage: StageKey;
  /** Still being worked (chase or contract out), so its follow-up can be closed or moved. */
  can_close: boolean;
};

/** The stages that have follow-ups: the only ones "Not following up" / "Follow up later" apply to. */
const OPEN_STAGES: string[] = ["chase", "contract_out"];

export type PipelineStage = {
  key: StageKey;
  label: string;
  count: number;
  /** Sum of the deal sizes that are recorded, and how many prospects that covers. Null when none are recorded. */
  deal_total_label: string | null;
  deals_recorded: number;
  prospects: Prospect[];
};

export type FollowUp = {
  id: string;
  name: string;
  heat: string | null;
  state: string | null;
  stage_label: string;
  promised: string | null;
  follow_up_label: string | null;
  days_overdue: number;
  deal_label: string | null;
};

const money = (v: number | null) => formatValue(v, "money");
const webLink = (url: string | null) => (url && /^https?:\/\//i.test(url) ? url : null);

/** Late follow-ups on prospects still being worked, most overdue first (view prospect_follow_ups). */
export async function getOverdueFollowUps(): Promise<FollowUp[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("prospect_follow_ups")
    .select("id, name, heat, state, stage, promised, follow_up_date, deal_size, days_overdue")
    .order("days_overdue", { ascending: false })
    .order("name");
  if (error) throw new Error(`prospect_follow_ups: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    heat: r.heat,
    state: r.state,
    stage_label: STAGE_LABEL[r.stage] ?? r.stage,
    promised: r.promised,
    follow_up_label: formatDay(r.follow_up_date),
    days_overdue: r.days_overdue,
    deal_label: money(r.deal_size),
  }));
}

const PROSPECT_COLUMNS = "id, name, heat, state, call_date, what_they_want, objection, promised, follow_up_date, deal_size, fathom_url, stage";
type Raw = Omit<Prospect, "contact" | "call_label" | "follow_up_label" | "days_overdue" | "deal_label" | "fathom_link" | "can_close"> & {
  prospect_contacts?: { contact: string | null } | { contact: string | null }[] | null;
};

function toProspect(r: Raw, daysOverdue: number | null): Prospect {
  return {
    ...r,
    contact: (Array.isArray(r.prospect_contacts) ? r.prospect_contacts[0]?.contact : r.prospect_contacts?.contact) ?? null,
    call_label: formatDay(r.call_date),
    follow_up_label: formatDay(r.follow_up_date),
    days_overdue: daysOverdue,
    deal_label: money(r.deal_size),
    fathom_link: webLink(r.fathom_url),
    can_close: OPEN_STAGES.includes(r.stage),
  };
}

/** The first day "Follow up later" accepts: tomorrow in ET (the database refuses anything earlier). */
export function earliestLaterDay(now: Date = new Date()): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
  const next = new Date(`${today}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export type FollowUpDecision = {
  id: string;
  /** "Not following up: Gone cold" or "Follow up later: 15 Oct 2026". */
  what: string;
  /** The text typed with the reason, when there was one. */
  note: string | null;
  /** How the prospect stood before: "Chase, follow-up 3 Oct 2026". */
  before: string;
  /** "Ryan, 8 Oct 2026, in Slack". */
  who: string;
  /** "Undone by Ryan, 9 Oct 2026" once it has been undone. */
  undone: string | null;
};

export type ProspectPage = {
  prospect: Prospect;
  decisions: FollowUpDecision[];
  /** The label of the undo button, when the latest decision can still be undone. */
  undo_label: string | null;
};

const etDay = (ts: string | null) =>
  ts ? new Date(ts).toLocaleDateString("en-GB", { timeZone: "America/New_York", day: "numeric", month: "short", year: "numeric" }) : null;

/** One prospect with the history of its "not following up" / "follow up later" decisions, newest first. */
export async function getProspect(id: string, withContact: boolean): Promise<ProspectPage | null> {
  const supabase = await createClient();
  const [row, late, log] = await Promise.all([
    supabase
      .from("prospects")
      .select(withContact ? `${PROSPECT_COLUMNS}, prospect_contacts(contact)` : PROSPECT_COLUMNS)
      .eq("id", id)
      .is("deleted_at", null)
      .maybeSingle(),
    supabase.from("prospect_follow_ups").select("days_overdue").eq("id", id).maybeSingle(),
    supabase
      .from("prospect_follow_up_decision_log")
      .select("id, kind, reason, reason_text, previous_stage, previous_follow_up_date, new_follow_up_date, decided_by_name, decided_at, source, undone_at, undone_by_name, is_undoable")
      .eq("prospect_id", id)
      .order("decided_at", { ascending: false }),
  ]);
  if (row.error) throw new Error(`prospects: ${row.error.message}`);
  if (late.error) throw new Error(`prospect_follow_ups: ${late.error.message}`);
  if (log.error) throw new Error(`prospect_follow_up_decision_log: ${log.error.message}`);
  if (!row.data) return null;

  const stageLabel = (stage: string) => STAGE_LABEL[stage] ?? stage;
  const undoable = (log.data ?? []).find((d) => d.is_undoable);
  const previousDay = undoable ? formatDay(undoable.previous_follow_up_date) : null;
  return {
    prospect: toProspect(row.data as unknown as Raw, (late.data?.days_overdue as number | undefined) ?? null),
    decisions: (log.data ?? []).map((d) => ({
      id: d.id,
      what: d.kind === "not_following_up"
        ? `Not following up: ${REASON_LABEL[d.reason] ?? d.reason}`
        : `Follow up later: ${formatDay(d.new_follow_up_date)}`,
      note: d.reason_text,
      before: `${stageLabel(d.previous_stage)}, ${d.previous_follow_up_date ? `follow-up ${formatDay(d.previous_follow_up_date)}` : "no follow-up date"}`,
      who: `${d.decided_by_name}, ${etDay(d.decided_at)}${d.source === "slack" ? ", in Slack" : ""}`,
      undone: d.undone_at ? `Undone by ${d.undone_by_name}, ${etDay(d.undone_at)}` : null,
    })),
    undo_label: !undoable
      ? null
      : undoable.kind === "not_following_up"
        ? `Undo: back to ${stageLabel(undoable.previous_stage)}${previousDay ? `, follow-up ${previousDay}` : ""}`
        : previousDay
          ? `Undo: follow-up back to ${previousDay}`
          : "Undo: clear the follow-up date",
  };
}

/** Every live prospect, by stage. Contact details are read only when the app owner is asking. */
export async function getPipeline(withContact: boolean): Promise<PipelineStage[]> {
  const supabase = await createClient();
  const columns = PROSPECT_COLUMNS;
  const [list, late] = await Promise.all([
    supabase
      .from("prospects")
      // Contact details live in their own owner-only table; RLS returns nothing to anyone else.
      .select(withContact ? `${columns}, prospect_contacts(contact)` : columns)
      .is("deleted_at", null)
      .order("follow_up_date", { nullsFirst: false })
      .order("name"),
    supabase.from("prospect_follow_ups").select("id, days_overdue"),
  ]);
  if (list.error) throw new Error(`prospects: ${list.error.message}`);
  if (late.error) throw new Error(`prospect_follow_ups: ${late.error.message}`);
  const overdue = new Map((late.data ?? []).map((r) => [r.id as string, r.days_overdue as number]));

  const prospects = ((list.data ?? []) as unknown as Raw[]).map((r) => toProspect(r, overdue.get(r.id) ?? null));

  return STAGES.map((s) => {
    const inStage = prospects.filter((p) => p.stage === s.key);
    const sized = inStage.filter((p) => p.deal_size !== null);
    return {
      key: s.key,
      label: s.label,
      count: inStage.length,
      deal_total_label: sized.length > 0 ? money(sized.reduce((sum, p) => sum + Number(p.deal_size), 0)) : null,
      deals_recorded: sized.length,
      prospects: inStage,
    };
  });
}
