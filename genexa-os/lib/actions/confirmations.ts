"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireDeskUser } from "@/lib/auth/staff";
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
