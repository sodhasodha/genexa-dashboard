"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/staff";
import { createClient } from "@/lib/supabase/server";

const Id = z.uuid();

/**
 * Save what was done about an ad exception. Written as the logged-in user, so
 * RLS decides who may (the exception's owner or the app owner) and the audit
 * log records who did.
 */
export async function saveActionTaken(formData: FormData) {
  await requireStaff();
  const id = Id.parse(formData.get("id"));
  const text = String(formData.get("action_taken") ?? "").trim().slice(0, 2000);
  const supabase = await createClient();
  const { error } = await supabase.from("exceptions").update({ action_taken: text || null }).eq("id", id);
  if (error) throw new Error(`exceptions: ${error.message}`);
  revalidatePath("/media-buying");
  revalidatePath("/overview");
}
