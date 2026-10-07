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

/** Match a Whop customer to a client (one click covers all of that customer's payments). */
export async function assignPayment(formData: FormData) {
  await requireOwner();
  const id = Id.parse(formData.get("id"));
  const clientId = Id.parse(formData.get("client_id"));
  const supabase = await createClient();
  const { data: payment } = await supabase.from("payments").select("whop_user_id").eq("id", id).single();
  const userId = payment?.whop_user_id;
  if (!userId) {
    await supabase.from("payments").update({ client_id: clientId }).eq("id", id);
  } else {
    // Remember the customer on the client, so every past and future payment and membership follows.
    const { data: client } = await supabase.from("clients").select("whop_customer_ids").eq("id", clientId).single();
    const ids = new Set<string>([...(client?.whop_customer_ids ?? []), userId]);
    await supabase.from("clients").update({ whop_customer_ids: [...ids] }).eq("id", clientId);
    await supabase.from("payments").update({ client_id: clientId }).eq("whop_user_id", userId);
    await supabase.from("whop_memberships").update({ client_id: clientId }).eq("whop_user_id", userId);
  }
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

/** Hide a review item, with a reason. Nothing is deleted; the dismissal is its own audited record. */
export async function dismissReviewItem(formData: FormData) {
  const me = await requireOwner();
  const reason = String(formData.get("reason") ?? "").trim();
  const itemKey = String(formData.get("item_key") ?? "");
  if (!reason || !itemKey) return;
  const supabase = await createClient();
  await supabase.from("data_review_dismissals").insert({
    item_key: itemKey, kind: String(formData.get("kind") ?? ""), title: String(formData.get("title") ?? ""), reason, dismissed_by: me.id,
  });
  done();
}

/** Fee mismatch: either adopt what Whop charges, or confirm the fee on record. */
export async function resolveFeeMismatch(formData: FormData) {
  await requireOwner();
  const clientId = Id.parse(formData.get("id"));
  const choice = String(formData.get("choice"));
  const supabase = await createClient();
  if (choice === "keep") {
    await supabase.from("clients").update({ fee_locked: true, fee_note: "Fee on record confirmed by the owner" }).eq("id", clientId);
  } else if (choice === "whop") {
    const { data: fee } = await supabase.from("client_fees").select("whop_monthly, billing_cycle").eq("client_id", clientId).single();
    if (fee?.whop_monthly !== null && fee?.whop_monthly !== undefined) {
      const months = fee.billing_cycle === "90" ? 3 : 1;
      await supabase.from("clients").update({ cycle_fee: Math.round(Number(fee.whop_monthly) * months * 100) / 100, fee_locked: false, fee_note: "Fee taken from Whop" }).eq("id", clientId);
    }
  }
  done();
}

const LABELS: Record<string, string> = { rev_share: "Rev share", retainer: "Retainer", setup: "Set-up fee", other: "Other income" };

/** Say what an untitled Whop payment was, so it counts as cash collected. */
export async function classifyPayment(formData: FormData) {
  await requireOwner();
  const id = Id.parse(formData.get("id"));
  const label = LABELS[String(formData.get("label"))];
  if (!label) return;
  const supabase = await createClient();
  await supabase.from("payments").update({ title_override: label, product_title: label }).eq("id", id);
  done();
}
