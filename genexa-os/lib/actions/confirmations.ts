"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireDeskUser } from "@/lib/auth/staff";
import { requireEnv } from "@/lib/env";
import { readPatientInformation } from "@/lib/integrations/ghl/confirmations";
import type { GhlKeys } from "@/lib/integrations/ghl/sync";
import { createClient } from "@/lib/supabase/server";

const Input = z.object({ appointment_id: z.uuid(), outcome: z.enum(["confirmed", "no_answer", "voicemail", "rescheduled"]) });
export type LogResult = { ok: true; attempt: number; status: string } | { ok: false; message: string };

const MESSAGE: Record<string, string> = {
  DESK_LIMIT: "This appointment already has 10 attempts.",
  DESK_CLOSED: "This appointment no longer takes calls.",
  DESK_NOT_FOUND: "That appointment is no longer on the desk.",
  DESK_REFUSED: "You can't log calls.",
};

/** Log one call attempt. The database numbers it, caps it at 10 and sets the status. */
export async function logCall(input: { appointment_id: string; outcome: string }): Promise<LogResult> {
  await requireDeskUser();
  const parsed = Input.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Pick an outcome." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("confirmation_log_call", { p_appointment: parsed.data.appointment_id, p_outcome: parsed.data.outcome });
  if (error) {
    const code = Object.keys(MESSAGE).find((k) => error.message.includes(k));
    return { ok: false, message: code ? MESSAGE[code] : "Not saved. Try again." };
  }
  revalidatePath("/confirmations");
  const r = data as { attempt: number; status: string };
  return { ok: true, attempt: r.attempt, status: r.status };
}

export type PatientInfo = { ok: true; text: string | null } | { ok: false; message: string };

/**
 * The open patient's "Patient Information" from GHL. The desk view decides whether
 * this person may see the appointment (CSRs and the owner); the key stays on the server.
 */
export async function getPatientInfo(appointmentId: string): Promise<PatientInfo> {
  await requireDeskUser();
  const id = z.uuid().safeParse(appointmentId);
  if (!id.success) return { ok: false, message: "Unknown appointment." };
  const supabase = await createClient();
  const { data } = await supabase.from("confirmation_desk").select("ghl_contact_id, ghl_location_id").eq("id", id.data).maybeSingle();
  if (!data) return { ok: false, message: "That appointment is no longer on the desk." };
  if (!data.ghl_contact_id || !data.ghl_location_id) return { ok: true, text: null };
  const keys = JSON.parse(requireEnv("GHL_API_KEYS_JSON")) as GhlKeys;
  const apiKey = Object.values(keys).find((k) => k.location_id === data.ghl_location_id)?.api_key;
  if (!apiKey) return { ok: false, message: "This clinic has no GoHighLevel key." };
  try {
    return { ok: true, text: await readPatientInformation({ locationId: data.ghl_location_id, contactId: data.ghl_contact_id, apiKey }) };
  } catch (err) {
    console.error("patient information: GHL read failed", err);
    return { ok: false, message: "Couldn't load it from GoHighLevel. Open the contact instead." };
  }
}
