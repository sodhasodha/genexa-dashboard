"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/staff";
import { referencedIds } from "@/lib/eod/describe";
import { eodDbErrorCode, isEodRole, parseEodForm } from "@/lib/eod/schema";
import { getEodForm } from "@/lib/queries/eod";
import { createClient } from "@/lib/supabase/server";

/**
 * File or edit the logged-in person's EOD for the day the form was opened on.
 * Written as that person, so RLS, the eods_rules trigger (own EOD, own day only)
 * and the audit log all apply. Who it is for comes from the session, never the form.
 */
export async function saveEod(formData: FormData) {
  const me = await requireStaff();
  const role = me.role;
  if (!isEodRole(role)) redirect("/eod?error=no_form");

  const date = z.iso.date().safeParse(formData.get("date"));
  if (!date.success) redirect("/eod?error=invalid");

  const parsed = parseEodForm(role, formData);
  if (!parsed.ok) redirect(`/eod?error=${parsed.error}`);

  // The form was opened on one day and sent on the next: that day has closed.
  const form = await getEodForm(me);
  if (date.data !== form.date) redirect("/eod?error=closed");

  // Everything ticked must be on this person's own lists.
  const allowed = {
    clients: new Set(form.clients.map((o) => o.id)),
    exceptions: new Set(form.exceptions.map((o) => o.id)),
    jobs: new Set(form.jobs.map((o) => o.id)),
  };
  const picked = referencedIds(role, parsed.value.answers);
  const offList =
    picked.clients.some((id) => !allowed.clients.has(id)) ||
    picked.exceptions.some((id) => !allowed.exceptions.has(id)) ||
    picked.jobs.some((id) => !allowed.jobs.has(id));
  if (offList) redirect("/eod?error=options");

  const supabase = await createClient();
  const { error } = await supabase
    .from("eods")
    .upsert({ staff_id: me.id, date: date.data, role, answers: parsed.value.answers }, { onConflict: "staff_id,date" });
  if (error) redirect(`/eod?error=${eodDbErrorCode(error.message)}`);

  revalidatePath("/eod");
  redirect("/eod?saved=1");
}
