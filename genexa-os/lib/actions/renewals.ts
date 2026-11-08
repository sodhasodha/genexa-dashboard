"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/staff";
import { createClient } from "@/lib/supabase/server";

// Owner edits to a Whop subscription on /renewals. They are kept in renewal_overrides so the Whop
// sync never overwrites them; a value equal to Whop's is stored as null ("use Whop"). Moving a
// subscription to another client locks it there (whop_memberships.client_locked). RLS and the
// audit trigger apply: every write goes through the owner's own Supabase client.

const blank = (v: FormDataEntryValue | null) => (v === null || String(v).trim() === "" ? null : String(v).trim());
const Edit = z.object({
  membership_id: z.uuid(),
  client_id: z.uuid(),
  every_days: z.coerce.number().int().min(1).max(366),
  next_due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.coerce.number().min(0).max(1_000_000),
  note: z.string().max(2000).nullable(),
  back: z.string().regex(/^[a-z=&0-9]*$/).nullable(),
});

const done = (back: string | null, query: string): never => {
  revalidatePath("/renewals");
  redirect(`/renewals?${back ? `${back}&` : ""}${query}`);
};

export async function saveRenewal(formData: FormData) {
  const me = await requireOwner();
  const parsed = Edit.safeParse({
    membership_id: formData.get("membership_id"), client_id: formData.get("client_id"), every_days: formData.get("every_days"),
    next_due: formData.get("next_due"), amount: formData.get("amount"), note: blank(formData.get("note")), back: blank(formData.get("back")),
  });
  if (!parsed.success) done(blank(formData.get("back")), "error=invalid");
  const e = parsed.data!;
  const supabase = await createClient();
  const { data: sub } = await supabase.from("renewal_subscriptions").select("client_id, whop_days, whop_amount, whop_due").eq("membership_id", e.membership_id).maybeSingle();
  if (!sub) done(e.back, "error=not_found");
  const { error } = await supabase.from("renewal_overrides").upsert({
    membership_id: e.membership_id,
    billing_period_days: e.every_days === sub!.whop_days ? null : e.every_days,
    amount: e.amount === Number(sub!.whop_amount) ? null : e.amount,
    next_due: e.next_due === sub!.whop_due ? null : e.next_due,
    next_due_whop_date: e.next_due === sub!.whop_due ? null : sub!.whop_due,
    note: e.note,
    updated_by: me.id,
  }, { onConflict: "membership_id" });
  if (error) done(e.back, "error=save");
  if (e.client_id !== sub!.client_id) {
    const moved = await supabase.from("whop_memberships").update({ client_id: e.client_id, client_locked: true }).eq("id", e.membership_id).select("id");
    if (moved.error || !moved.data?.length) done(e.back, "error=move");
  }
  done(e.back, "saved=1");
}

/** Every edited value back to Whop's (the note is kept). */
export async function resetRenewal(formData: FormData) {
  await requireOwner();
  const id = z.uuid().safeParse(formData.get("membership_id"));
  const back = blank(formData.get("back"));
  if (!id.success) done(back, "error=invalid");
  const supabase = await createClient();
  const { error } = await supabase.from("renewal_overrides")
    .update({ billing_period_days: null, amount: null, next_due: null, next_due_whop_date: null }).eq("membership_id", id.data!);
  if (error) done(back, "error=save");
  done(back, "reset=1");
}
