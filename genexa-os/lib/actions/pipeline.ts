"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/staff";
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
  const { error } = await supabase.from("prospects").insert(parsed.data);
  if (error) back("error=save");
  back("saved=added");
}

/** App owner edits a prospect's details. */
export async function editProspect(formData: FormData) {
  await requireOwner();
  const id = Id.safeParse(formData.get("id"));
  const parsed = ProspectFields.safeParse(fields(formData));
  if (!id.success || !parsed.success) back("error=invalid");
  const supabase = await createClient();
  const { data, error } = await supabase.from("prospects").update(parsed.data).eq("id", id.data).is("deleted_at", null).select("id");
  if (error || !data || data.length === 0) back("error=save");
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
