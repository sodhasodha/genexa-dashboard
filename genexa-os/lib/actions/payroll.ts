"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/staff";
import { isDate, weekStartOf } from "@/lib/payroll/week";
import { createClient } from "@/lib/supabase/server";

// Payroll writes. Owner only: requireOwner() here, and RLS in the database
// (owner_all is the only policy on every payroll table). Written through the
// owner's own Supabase client so the audit log records who did it. All pay
// maths is in SQL (build_pay_run); these actions only store inputs and rebuild.

type Db = Awaited<ReturnType<typeof createClient>>;

const blank = (v: FormDataEntryValue | null) => (v === null || String(v).trim() === "" ? null : String(v).trim());
const weekOf = (formData: FormData) => {
  const w = formData.get("week");
  return isDate(w) ? weekStartOf(w) : null;
};
const back = (week: string | null, key: "saved" | "error", code: string): never => {
  revalidatePath("/payroll");
  redirect(`/payroll?${week ? `week=${week}&` : ""}${key}=${code}`);
};

const Money = z.coerce.number().finite().multipleOf(0.01);

/** Recompute the week's draft lines, but only if a run already exists (viewing or editing never creates one). */
async function rebuildIfBuilt(supabase: Db, week: string | null) {
  if (!week) return;
  const { data } = await supabase.from("pay_runs").select("id").eq("week_start", week).maybeSingle();
  if (data) await supabase.rpc("build_pay_run", { p_week_start: week });
}

/** "Build draft" / "Rebuild draft". */
export async function rebuildPayRun(formData: FormData) {
  await requireOwner();
  const week = weekOf(formData);
  if (!week) back(null, "error", "week");
  const supabase = await createClient();
  const { error } = await supabase.rpc("build_pay_run", { p_week_start: week });
  if (error) back(week, "error", "build");
  back(week, "saved", "built");
}

const LineId = z.object({ line_id: z.uuid() });

export async function approvePayLine(formData: FormData) {
  await requireOwner();
  const week = weekOf(formData);
  const parsed = LineId.safeParse({ line_id: formData.get("line_id") });
  if (!parsed.success) back(week, "error", "invalid");
  const supabase = await createClient();
  // The database refuses to approve a line with no computable pay (gross is null).
  const { data, error } = await supabase.from("pay_run_lines").update({ status: "approved" }).eq("id", parsed.data!.line_id).eq("status", "draft").select("id");
  if (error) back(week, "error", "cannot_approve");
  if (!data || data.length === 0) back(week, "error", "not_draft");
  back(week, "saved", "approved");
}

const RunId = z.object({ run_id: z.uuid() });

/** Approves every draft line that has a pay type and a rate, then the run. */
export async function approveAllPayLines(formData: FormData) {
  await requireOwner();
  const week = weekOf(formData);
  const parsed = RunId.safeParse({ run_id: formData.get("run_id") });
  if (!parsed.success) back(week, "error", "invalid");
  const supabase = await createClient();
  const { error } = await supabase.rpc("approve_pay_run", { p_run: parsed.data!.run_id });
  if (error) back(week, "error", "approve");
  back(week, "saved", "approved_all");
}

/** Records today's date on the run and on its approved lines. */
export async function markPayRunPaid(formData: FormData) {
  await requireOwner();
  const week = weekOf(formData);
  const parsed = RunId.safeParse({ run_id: formData.get("run_id") });
  if (!parsed.success) back(week, "error", "invalid");
  const supabase = await createClient();
  const { error } = await supabase.rpc("mark_pay_run_paid", { p_run: parsed.data!.run_id });
  if (error) back(week, "error", error.message.includes("PAY_RUN_NOT_APPROVED") ? "not_approved" : "paid");
  back(week, "saved", "paid");
}

const Adjustment = z.object({ line_id: z.uuid(), amount: Money, reason: z.string().max(300).nullable() });

/** A plus or minus amount on a draft line. A reason is required unless the amount is 0. */
export async function setPayAdjustment(formData: FormData) {
  await requireOwner();
  const week = weekOf(formData);
  const parsed = Adjustment.safeParse({
    line_id: formData.get("line_id"),
    amount: blank(formData.get("amount")) ?? "0",
    reason: blank(formData.get("reason")),
  });
  if (!parsed.success) back(week, "error", "adjustment_invalid");
  const { line_id, amount, reason } = parsed.data!;
  if (amount !== 0 && !reason) back(week, "error", "adjustment_reason");
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("pay_run_lines")
    .update({ adjustment: amount, adjustment_reason: amount === 0 ? null : reason })
    .eq("id", line_id)
    .eq("status", "draft")
    .select("id");
  if (error) back(week, "error", "adjustment_save");
  if (!data || data.length === 0) back(week, "error", "not_draft");
  back(week, "saved", "adjustment");
}

const Overtime = z.object({ attendance_id: z.uuid(), approved: z.boolean() });

/** The owner approves (or withdraws) overtime for one attendance day; the draft is recomputed. */
export async function setOvertimeApproved(formData: FormData) {
  const me = await requireOwner();
  const week = weekOf(formData);
  const parsed = Overtime.safeParse({ attendance_id: formData.get("attendance_id"), approved: formData.get("approved") === "on" });
  if (!parsed.success) back(week, "error", "invalid");
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("attendance")
    .update({ overtime_approved: parsed.data!.approved, approved_by: parsed.data!.approved ? me.id : null })
    .eq("id", parsed.data!.attendance_id)
    .select("id");
  if (error || !data || data.length === 0) back(week, "error", "overtime");
  await rebuildIfBuilt(supabase, week);
  back(week, "saved", "overtime");
}

const Job = z.object({
  staff_id: z.uuid(),
  date: z.string().refine(isDate),
  description: z.string().min(1).max(300),
  amount: Money.positive(),
});

export async function addFreelanceJob(formData: FormData) {
  await requireOwner();
  const week = weekOf(formData);
  const parsed = Job.safeParse({
    staff_id: formData.get("staff_id"),
    date: blank(formData.get("date")) ?? "",
    description: blank(formData.get("description")) ?? "",
    amount: blank(formData.get("amount")) ?? "",
  });
  if (!parsed.success) back(week, "error", "job_invalid");
  const supabase = await createClient();
  const { error } = await supabase.from("freelance_jobs").insert(parsed.data!);
  if (error) back(week, "error", "job_save");
  // The job belongs to the week of its own date, which may not be the week on screen.
  const jobWeek = weekStartOf(parsed.data!.date);
  await rebuildIfBuilt(supabase, jobWeek);
  back(jobWeek, "saved", "job");
}

const Pay = z.object({
  staff_id: z.uuid(),
  pay_type: z.enum(["hourly", "fixed_monthly", "freelance"]).nullable(),
  hourly_rate: Money.nonnegative().nullable(),
  monthly_amount: Money.nonnegative().nullable(),
});

/** A person's pay type, hourly rate and monthly amount. Blank stays blank: a missing rate is a flag, never $0. */
export async function updatePay(formData: FormData) {
  await requireOwner();
  const week = weekOf(formData);
  const parsed = Pay.safeParse({
    staff_id: formData.get("staff_id"),
    pay_type: blank(formData.get("pay_type")),
    hourly_rate: blank(formData.get("hourly_rate")),
    monthly_amount: blank(formData.get("monthly_amount")),
  });
  if (!parsed.success) back(week, "error", "pay_invalid");
  const supabase = await createClient();
  const { error } = await supabase.from("staff_pay").upsert(parsed.data!, { onConflict: "staff_id" });
  if (error) back(week, "error", "pay_save");
  await rebuildIfBuilt(supabase, week);
  back(week, "saved", "pay");
}
