"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/staff";
import { NOT_FOLLOWING_UP_REASONS } from "@/lib/pipeline/reasons";
import { createClient } from "@/lib/supabase/server";
import { blank, Day, Id } from "./fields";

const Stage = z.enum(["chase", "contract_out", "paid", "dead"]);
const Text = z.string().max(4000).nullable();
const ProspectFields = z.object({
  name: z.string().min(1).max(200),
  contact: z.string().max(500).nullable(),
  state: z.string().max(60).nullable(),
  heat: z.enum(["hot", "warm", "cold"]).nullable(),
  call_date: Day.nullable(),
  what_they_want: Text,
  objection: Text,
  promised: Text,
  follow_up_date: Day.nullable(),
  fathom_url: z.string().max(1000).regex(/^https?:\/\/\S+$/i).nullable(),
  deal_size: z.number().min(0).max(9_999_999_999).nullable(),
  stage: Stage,
});

function back(result: string): never {
  revalidatePath("/pipeline");
  redirect(`/pipeline?${result}`);
}

function fields(formData: FormData) {
  const deal = blank(formData.get("deal_size"));
  return {
    name: blank(formData.get("name")) ?? "",
    contact: blank(formData.get("contact")),
    state: blank(formData.get("state")),
    heat: blank(formData.get("heat")),
    call_date: blank(formData.get("call_date")),
    what_they_want: blank(formData.get("what_they_want")),
    objection: blank(formData.get("objection")),
    promised: blank(formData.get("promised")),
    follow_up_date: blank(formData.get("follow_up_date")),
    fathom_url: blank(formData.get("fathom_url")),
    deal_size: deal === null ? null : Number(deal.replace(/[$,\s]/g, "")),
    stage: formData.get("stage"),
  };
}

/** App owner adds a prospect. */
export async function addProspect(formData: FormData) {
  await requireOwner();
  const parsed = ProspectFields.safeParse(fields(formData));
  if (!parsed.success) back("error=invalid");
  const supabase = await createClient();
  const { contact, ...prospect } = parsed.data;
  const { data: created, error } = await supabase.from("prospects").insert(prospect).select("id").single();
  if (error || !created) back("error=save");
  if (contact) await supabase.from("prospect_contacts").insert({ prospect_id: created.id, contact });
  back("saved=added");
}

/** App owner edits a prospect's details. */
export async function editProspect(formData: FormData) {
  await requireOwner();
  const id = Id.safeParse(formData.get("id"));
  const parsed = ProspectFields.safeParse(fields(formData));
  if (!id.success || !parsed.success) back("error=invalid");
  const supabase = await createClient();
  const { contact, ...prospect } = parsed.data;
  const { data, error } = await supabase.from("prospects").update(prospect).eq("id", id.data).is("deleted_at", null).select("id");
  if (error || !data || data.length === 0) back("error=save");
  const { error: contactError } = await supabase.from("prospect_contacts").upsert({ prospect_id: id.data, contact }, { onConflict: "prospect_id" });
  if (contactError) back("error=save");
  back("saved=edited");
}

/** App owner moves a prospect to another stage. */
export async function moveProspect(formData: FormData) {
  await requireOwner();
  const id = Id.safeParse(formData.get("id"));
  const stage = Stage.safeParse(formData.get("stage"));
  if (!id.success || !stage.success) back("error=invalid");
  const supabase = await createClient();
  const { data, error } = await supabase.from("prospects").update({ stage: stage.data }).eq("id", id.data).is("deleted_at", null).select("id");
  if (error || !data || data.length === 0) back("error=save");
  back("saved=moved");
}

/** App owner sets (or clears) the follow-up date. */
export async function setFollowUp(formData: FormData) {
  await requireOwner();
  const id = Id.safeParse(formData.get("id"));
  const day = Day.nullable().safeParse(blank(formData.get("follow_up_date")));
  if (!id.success || !day.success) back("error=invalid");
  const supabase = await createClient();
  const { data, error } = await supabase.from("prospects").update({ follow_up_date: day.data }).eq("id", id.data).is("deleted_at", null).select("id");
  if (error || !data || data.length === 0) back("error=save");
  back("saved=follow_up");
}

// ---------------------------------------------------------------------------
// Closing a follow-up without doing it. The database functions make the change
// in one step (prospect_not_following_up, prospect_follow_up_later,
// prospect_follow_up_undo) and say what happened; this only passes the form on.
// ---------------------------------------------------------------------------
const Reason = z.enum(NOT_FOLLOWING_UP_REASONS.map((r) => r.key));
const DECISION_SAVED: Record<string, string> = { not_following_up: "closed", follow_up_later: "later", undone: "undone" };
const DECISION_ERRORS: Record<string, string> = {
  refused: "owner_only",
  not_open: "not_open",
  invalid_reason: "reason",
  reason_text_required: "reason_text",
  date_not_future: "date",
  nothing_to_undo: "no_undo",
};

/** Back to where the form was: the prospect's own page, or the Pipeline list. */
function afterDecision(formData: FormData, id: string | null, result: string): never {
  revalidatePath("/pipeline");
  if (id) revalidatePath(`/pipeline/${id}`);
  if (id && formData.get("from") === "prospect") redirect(`/pipeline/${id}?${result}`);
  redirect(`/pipeline?${result}${id ? `&p=${id}` : ""}`);
}

function decided(formData: FormData, id: string, outcome: { data: unknown; error: unknown }): never {
  const result = outcome.error ? null : (outcome.data as { result?: string } | null)?.result;
  const saved = result ? DECISION_SAVED[result] : undefined;
  if (saved) afterDecision(formData, id, `saved=${saved}`);
  afterDecision(formData, id, `error=${(result && DECISION_ERRORS[result]) || "save"}`);
}

/** App owner closes a follow-up: the prospect goes to Dead with a reason and its reminders stop. */
export async function notFollowingUp(formData: FormData) {
  await requireOwner();
  const id = Id.safeParse(formData.get("id"));
  if (!id.success) afterDecision(formData, null, "error=invalid");
  const reason = Reason.safeParse(formData.get("reason"));
  const text = z.string().max(1000).nullable().safeParse(blank(formData.get("reason_text")));
  if (!reason.success || !text.success) afterDecision(formData, id.data, "error=reason");
  const supabase = await createClient();
  decided(formData, id.data, await supabase.rpc("prospect_not_following_up", { p_prospect: id.data, p_reason: reason.data, p_reason_text: text.data }));
}

/** App owner moves the follow-up to a later day. Reminders pause until then. */
export async function followUpLater(formData: FormData) {
  await requireOwner();
  const id = Id.safeParse(formData.get("id"));
  if (!id.success) afterDecision(formData, null, "error=invalid");
  const day = Day.safeParse(blank(formData.get("follow_up_date")));
  if (!day.success) afterDecision(formData, id.data, "error=date");
  const supabase = await createClient();
  decided(formData, id.data, await supabase.rpc("prospect_follow_up_later", { p_prospect: id.data, p_date: day.data }));
}

/** App owner undoes the latest of those two decisions: stage and follow-up date go back. */
export async function undoFollowUpDecision(formData: FormData) {
  await requireOwner();
  const id = Id.safeParse(formData.get("id"));
  if (!id.success) afterDecision(formData, null, "error=invalid");
  const supabase = await createClient();
  decided(formData, id.data, await supabase.rpc("prospect_follow_up_undo", { p_prospect: id.data }));
}
