"use server";

import { z } from "zod";
import { requireDeskUser } from "@/lib/auth/staff";
import { createClient } from "@/lib/supabase/server";

/** A CSR opened a lead in GHL: greyed out for everyone for 15 minutes. Writes nothing to GHL. */
export async function openLead(id: string): Promise<{ ok: boolean }> {
  await requireDeskUser();
  if (!z.uuid().safeParse(id).success) return { ok: false };
  const supabase = await createClient();
  const { error } = await supabase.rpc("hot_lead_open", { p_lead: id });
  return { ok: !error };
}
