import "server-only";
import { createClient } from "@/lib/supabase/server";
import { formatValue } from "@/lib/format";
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
};

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

/** Every live prospect, by stage. Contact details are read only when the app owner is asking. */
export async function getPipeline(withContact: boolean): Promise<PipelineStage[]> {
  const supabase = await createClient();
  const columns = "id, name, heat, state, call_date, what_they_want, objection, promised, follow_up_date, deal_size, fathom_url, stage";
  const [list, late] = await Promise.all([
    supabase
      .from("prospects")
      .select(withContact ? `${columns}, contact` : columns)
      .is("deleted_at", null)
      .order("follow_up_date", { nullsFirst: false })
      .order("name"),
    supabase.from("prospect_follow_ups").select("id, days_overdue"),
  ]);
  if (list.error) throw new Error(`prospects: ${list.error.message}`);
  if (late.error) throw new Error(`prospect_follow_ups: ${late.error.message}`);
  const overdue = new Map((late.data ?? []).map((r) => [r.id as string, r.days_overdue as number]));

  type Raw = Omit<Prospect, "contact" | "call_label" | "follow_up_label" | "days_overdue" | "deal_label" | "fathom_link"> & { contact?: string | null };
  const prospects = ((list.data ?? []) as unknown as Raw[]).map((r): Prospect => ({
    ...r,
    contact: r.contact ?? null,
    call_label: formatDay(r.call_date),
    follow_up_label: formatDay(r.follow_up_date),
    days_overdue: overdue.get(r.id) ?? null,
    deal_label: money(r.deal_size),
    fathom_link: webLink(r.fathom_url),
  }));

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
