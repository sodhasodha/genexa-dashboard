"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/staff";
import { createClient } from "@/lib/supabase/server";

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const Shift = z.object({
  staff_id: z.uuid(),
  timezone: z.string().min(3).max(64),
  shift_start: Time.nullable(),
  shift_end: Time.nullable(),
  working_days: z.array(z.number().int().min(1).max(7)),
});

/** Owner sets a person's shift. Written as the owner, so RLS and the audit log apply. */
export async function updateShift(formData: FormData) {
  await requireOwner();
  const blank = (v: FormDataEntryValue | null) => (v === null || String(v).trim() === "" ? null : String(v).trim());
  const parsed = Shift.safeParse({
    staff_id: formData.get("staff_id"),
    timezone: blank(formData.get("timezone")) ?? "",
    shift_start: blank(formData.get("shift_start")),
    shift_end: blank(formData.get("shift_end")),
    working_days: formData.getAll("working_days").map(Number).sort(),
  });
  if (!parsed.success) redirect("/team?error=invalid");
  const { staff_id, ...shift } = parsed.data;
  if ((shift.shift_start === null) !== (shift.shift_end === null)) redirect("/team?error=both_times");

  const supabase = await createClient();
  const { error } = await supabase.from("staff").update(shift).eq("id", staff_id);
  if (error) redirect(`/team?error=${error.message.includes("STAFF_TIMEZONE") ? "timezone" : "save"}`);
  revalidatePath("/team");
  redirect("/team?saved=1");
}
