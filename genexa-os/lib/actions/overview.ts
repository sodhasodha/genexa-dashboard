"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOwner, requireStaff } from "@/lib/auth/staff";
import { createClient } from "@/lib/supabase/server";

const Id = z.uuid();
const done = () => {
  revalidatePath("/overview");
  revalidatePath("/data-review");
};

/** Owner resolves an exception with a note. */
export async function resolveException(formData: FormData) {
  const me = await requireStaff();
  const id = Id.parse(formData.get("id"));
  const note = String(formData.get("note") ?? "").trim();
  if (!note) return;
  const supabase = await createClient();
  await supabase.from("exceptions").update({ status: "resolved", resolved_at: new Date().toISOString(), resolved_by: me.name, resolution_note: note }).eq("id", id);
  done();
}

/** Owner snoozes an exception for 24h with a reason. */
export async function snoozeException(formData: FormData) {
  await requireStaff();
  const id = Id.parse(formData.get("id"));
  const reason = String(formData.get("note") ?? "").trim();
  if (!reason) return;
  const supabase = await createClient();
  await supabase.from("exceptions").update({ status: "snoozed", snoozed_until: new Date(Date.now() + 24 * 3_600_000).toISOString(), snooze_reason: reason }).eq("id", id);
  done();
}

const Attendance = z.enum(["showed", "no_show", "cancelled", "rescheduled_before_consult"]);

/** Log what happened at a consult the clinic has not logged. */
export async function setAttendance(formData: FormData) {
  await requireOwner();
  const id = Id.parse(formData.get("id"));
  const attendance = Attendance.parse(formData.get("attendance"));
  const supabase = await createClient();
  await supabase.from("appointments").update({ attendance, attendance_logged_at: new Date().toISOString(), attendance_logged_by: "genexa_csr" }).eq("id", id);
  done();
}

/** Match a Whop payment to a client. */
export async function assignPayment(formData: FormData) {
  await requireOwner();
  const id = Id.parse(formData.get("id"));
  const clientId = Id.parse(formData.get("client_id"));
  const supabase = await createClient();
  await supabase.from("payments").update({ client_id: clientId }).eq("id", id);
  done();
}

// Button label -> stored category, and whether it counts as a business expense.
const EXPENSE: Record<string, { category: string; included: boolean }> = {
  labor: { category: "payroll", included: true },
  ads: { category: "ads", included: true },
  software: { category: "software", included: true },
  coaching: { category: "coaching", included: false },
  personal: { category: "personal", included: false },
  other: { category: "other", included: true },
};

/**
 * Categorise a bank transaction. The choice is remembered for that vendor:
 * a rule is saved, and every other uncategorised transaction from the same
 * counterparty gets the same category now and on future syncs.
 */
export async function categoriseExpense(formData: FormData) {
  await requireOwner();
  const id = Id.parse(formData.get("id"));
  const choice = EXPENSE[String(formData.get("category"))];
  if (!choice) return;
  const supabase = await createClient();
  const { data: tx } = await supabase.from("finance_transactions").select("counterparty").eq("id", id).single();
  await supabase.from("finance_transactions").update(choice).eq("id", id);
  const vendor = tx?.counterparty?.trim();
  if (vendor) {
    const { data: rule } = await supabase.from("finance_rules").select("id").eq("match_field", "counterparty").eq("pattern", vendor).maybeSingle();
    if (rule) await supabase.from("finance_rules").update({ ...choice, enabled: true }).eq("id", rule.id);
    else await supabase.from("finance_rules").insert({ match_field: "counterparty", pattern: vendor, ...choice, note: "Set from the Overview" });
    await supabase.from("finance_transactions").update(choice).eq("counterparty", vendor).eq("category", "unclassified");
  }
  done();
}

/** A lead the filter flagged that is in fact a real patient. */
export async function markLeadReal(formData: FormData) {
  await requireOwner();
  const id = Id.parse(formData.get("id"));
  const supabase = await createClient();
  await supabase.from("leads").update({ is_test: false, test_reviewed: true }).eq("id", id);
  done();
}
