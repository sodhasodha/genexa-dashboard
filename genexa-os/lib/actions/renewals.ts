"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/staff";
import { createClient } from "@/lib/supabase/server";

// The owner's hand-kept subscriptions on /renewals (renewal_plans). Not synced to Whop. Every
// write goes through the owner's own Supabase client, so RLS and the audit trigger apply.
// "Remove" archives: nothing is deleted.

const blank = (v: FormDataEntryValue | null) => (v === null || String(v).trim() === "" ? null : String(v).trim());
const Plan = z.object({
  client_id: z.uuid(),
  name: z.string().min(1).max(200),
  every_days: z.coerce.number().int().min(1).max(366),
  amount: z.coerce.number().min(0).max(1_000_000),
  next_due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(["active", "past_due", "cancelling", "ended"]),
  note: z.string().max(2000).nullable(),
});
const Back = z.string().regex(/^[a-z=&]*$/).nullable().catch(null);

const done = (formData: FormData, query: string): never => {
  const back = Back.parse(blank(formData.get("back")));
  revalidatePath("/renewals");
  redirect(`/renewals?${back ? `${back}&` : ""}${query}`);
};
const fields = (formData: FormData) =>
  Plan.safeParse(Object.fromEntries(Object.keys(Plan.shape).map((k) => [k, blank(formData.get(k))])));

export async function addPlan(formData: FormData) {
  const me = await requireOwner();
  const parsed = fields(formData);
  if (!parsed.success) done(formData, "error=invalid");
  const supabase = await createClient();
  const { error } = await supabase.from("renewal_plans").insert({ ...parsed.data!, created_by: me.id });
  if (error) done(formData, "error=save");
  done(formData, "saved=added");
}

export async function savePlan(formData: FormData) {
  await requireOwner();
  const id = z.uuid().safeParse(formData.get("id"));
  const parsed = fields(formData);
  if (!id.success || !parsed.success) done(formData, "error=invalid");
  const supabase = await createClient();
  const { data, error } = await supabase.from("renewal_plans").update(parsed.data!).eq("id", id.data!).is("archived_at", null).select("id");
  if (error || !data?.length) done(formData, "error=save");
  done(formData, "saved=saved");
}

/** Renewed: the next due date moves on one cycle and the status goes back to Active. */
export async function renewPlan(formData: FormData) {
  await requireOwner();
  const id = z.uuid().safeParse(formData.get("id"));
  if (!id.success) done(formData, "error=invalid");
  const supabase = await createClient();
  const { data: plan } = await supabase.from("renewal_plans").select("next_due, every_days").eq("id", id.data!).is("archived_at", null).maybeSingle();
  if (!plan) done(formData, "error=save");
  const next = new Date(`${plan!.next_due}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + plan!.every_days);
  const { error } = await supabase.from("renewal_plans").update({ next_due: next.toISOString().slice(0, 10), status: "active" }).eq("id", id.data!);
  if (error) done(formData, "error=save");
  done(formData, "saved=renewed");
}

export async function removePlan(formData: FormData) {
  await requireOwner();
  const id = z.uuid().safeParse(formData.get("id"));
  if (!id.success) done(formData, "error=invalid");
  const supabase = await createClient();
  const { error } = await supabase.from("renewal_plans").update({ archived_at: new Date().toISOString() }).eq("id", id.data!);
  if (error) done(formData, "error=save");
  done(formData, "saved=removed");
}
