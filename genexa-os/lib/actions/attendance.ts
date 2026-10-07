"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOwner, requireStaff } from "@/lib/auth/staff";
import { createClient } from "@/lib/supabase/server";

export type ClockState = { error: string | null };

/** "ATTENDANCE_ALREADY_IN: already clocked in for Wed 07 Oct at 09:03" -> a sentence for the person. */
function clockError(message: string): string {
  if (message.includes("ATTENDANCE_ALREADY_IN")) {
    const detail = message.split("ATTENDANCE_ALREADY_IN: ")[1] ?? "already clocked in today";
    return `You have ${detail}. A second clock-in is not allowed; ask the owner to correct it.`;
  }
  if (message.includes("ATTENDANCE_NOT_IN")) return "You are not clocked in.";
  return "That did not save. Try again.";
}

/** The database stamps the time (now()) and acts on the caller only: nothing is passed in. */
export async function clockIn(): Promise<ClockState> {
  await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase.rpc("clock_in");
  if (error) return { error: clockError(error.message) };
  revalidatePath("/", "layout");
  return { error: null };
}

export async function clockOut(): Promise<ClockState> {
  await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase.rpc("clock_out");
  if (error) return { error: clockError(error.message) };
  revalidatePath("/", "layout");
  return { error: null };
}

const blank = (v: FormDataEntryValue | null) => (v === null || String(v).trim() === "" ? null : String(v).trim());
const LocalDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const Edit = z.object({
  id: z.uuid(),
  status: z.enum(["on_time", "late", "no_show", "excused"]).nullable(),
  clock_in: LocalDateTime.nullable(),
  clock_out: LocalDateTime.nullable(),
  overtime_approved: z.boolean(),
  note: z.string().min(1).max(500),
});

/**
 * Owner corrects an attendance row. The SQL function requires the note, marks
 * the row manual (so the 5-minute tick leaves it alone) and records who approved it.
 * Times are typed in the person's own timezone and converted in the database.
 */
export async function editAttendance(formData: FormData) {
  await requireOwner();
  const note = blank(formData.get("note"));
  const parsed = Edit.safeParse({
    id: formData.get("id"),
    status: blank(formData.get("status")),
    clock_in: blank(formData.get("clock_in")),
    clock_out: blank(formData.get("clock_out")),
    overtime_approved: formData.get("overtime_approved") === "on",
    note: note ?? "",
  });
  if (!parsed.success) redirect(`/team?att_error=${note ? "edit_invalid" : "note"}#attendance-log`);
  const e = parsed.data;
  const supabase = await createClient();
  const { error } = await supabase.rpc("attendance_owner_edit", {
    p_id: e.id,
    p_status: e.status,
    p_clock_in: e.clock_in,
    p_clock_out: e.clock_out,
    p_overtime_approved: e.overtime_approved,
    p_note: e.note,
  });
  if (error) {
    const key = error.message.includes("ATTENDANCE_NOTE_REQUIRED")
      ? "note"
      : error.message.includes("ATTENDANCE_TIMES") || error.message.includes("attendance_check")
        ? "times"
        : "edit_save";
    redirect(`/team?att_error=${key}#attendance-log`);
  }
  revalidatePath("/", "layout");
  redirect("/team?att_saved=edit#attendance-log");
}

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const Override = z.object({
  staff_id: z.uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  kind: z.enum(["sick", "holiday", "swap", "custom"]),
  shift_start: Time.nullable(),
  shift_end: Time.nullable(),
  note: z.string().max(500).nullable(),
});

/** Owner adds a one-day change to someone's shift. Written as the owner, so RLS and the audit log apply. */
export async function addOverride(formData: FormData) {
  const me = await requireOwner();
  const parsed = Override.safeParse({
    staff_id: formData.get("staff_id"),
    date: formData.get("date"),
    kind: formData.get("kind"),
    shift_start: blank(formData.get("shift_start")),
    shift_end: blank(formData.get("shift_end")),
    note: blank(formData.get("note")),
  });
  if (!parsed.success) redirect("/team?att_error=override_invalid#overrides");
  const o = parsed.data;
  if ((o.shift_start === null) !== (o.shift_end === null)) redirect("/team?att_error=override_both_times#overrides");
  if ((o.kind === "sick" || o.kind === "holiday") && o.shift_start !== null) redirect("/team?att_error=override_no_hours#overrides");

  const supabase = await createClient();
  const { error } = await supabase.from("shift_overrides").insert({ ...o, created_by: me.id });
  if (error) redirect(`/team?att_error=${error.message.includes("shift_overrides_one_per_day") ? "override_exists" : "override_save"}#overrides`);
  revalidatePath("/", "layout");
  redirect("/team?att_saved=override#overrides");
}

/** Soft delete: the row stays, with deleted_at set, and the normal shift applies again. */
export async function removeOverride(formData: FormData) {
  await requireOwner();
  const id = z.uuid().safeParse(formData.get("id"));
  if (!id.success) redirect("/team?att_error=override_invalid#overrides");
  const supabase = await createClient();
  const { error } = await supabase.from("shift_overrides").update({ deleted_at: new Date().toISOString() }).eq("id", id.data).is("deleted_at", null);
  if (error) redirect("/team?att_error=override_save#overrides");
  revalidatePath("/", "layout");
  redirect("/team?att_saved=override_removed#overrides");
}
