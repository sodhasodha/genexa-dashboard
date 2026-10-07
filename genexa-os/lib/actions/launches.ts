"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/staff";
import { createClient } from "@/lib/supabase/server";
import { etMidnight, etToday } from "@/lib/time";

// Writes run as the logged-in user: RLS lets the launch's owner and the app owner
// through and nobody else. A refused write updates no rows and comes back as
// ?error=refused. The database also refuses QC passed / Live without all six
// checks (LAUNCH_QC) and a step back by anyone but the app owner (LAUNCH_BACK).

const Id = z.uuid();
const Stage = z.enum(["paid", "ob_call_booked", "ob_call_done", "ob_form_complete", "access_granted", "built", "qc_passed", "live"]);
/** The timestamp each stage is defined by. */
const STAMP: Record<z.infer<typeof Stage>, string> = {
  paid: "paid_at",
  ob_call_booked: "ob_call_booked_at",
  ob_call_done: "ob_call_done_at",
  ob_form_complete: "ob_form_done_at",
  access_granted: "access_done_at",
  built: "build_done_at",
  qc_passed: "qc_passed_at",
  live: "live_at",
};
const QC = ["qc_lead_access", "qc_calendar_tested", "qc_test_lead_deleted", "qc_pixel_firing", "qc_cortana_connected", "qc_clinic_sheet"] as const;

const back = (query: string): never => redirect(`/launches?${query}`);
const refreshed = () => {
  revalidatePath("/launches");
  revalidatePath("/clients");
};
const codeFor = (message: string) => (message.includes("LAUNCH_QC") ? "qc" : message.includes("LAUNCH_BACK") ? "back" : "save");

/** Move a card one stage forward (timestamps that stage) or back (clears the current stage's timestamp; owner only). */
export async function moveLaunch(formData: FormData) {
  const me = await requireStaff();
  const id = Id.parse(formData.get("launch_id"));
  const to = Stage.parse(formData.get("to"));
  const direction = z.enum(["forward", "back"]).parse(formData.get("direction"));
  const supabase = await createClient();
  const { data: card } = await supabase.from("launch_board").select("stage, next_stage, prev_stage").eq("launch_id", id).maybeSingle();
  if (!card) back("error=gone");
  // The page may be out of date: only ever move one step from where the launch is now.
  if ((direction === "forward" ? card!.next_stage : card!.prev_stage) !== to) back("error=moved");
  if (direction === "back" && me.role !== "owner") back("error=back");

  const change = direction === "forward"
    ? { [STAMP[to]]: new Date().toISOString() }
    : { [STAMP[Stage.parse(card!.stage)]]: null };
  const { data, error } = await supabase.from("launches").update(change).eq("id", id).select("id");
  if (error) back(`error=${codeFor(error.message)}`);
  if (!data || data.length === 0) back("error=refused");
  refreshed();
  back("saved=moved");
}

/** Save the six QC checkboxes. */
export async function saveQc(formData: FormData) {
  await requireStaff();
  const id = Id.parse(formData.get("launch_id"));
  const flags = Object.fromEntries(QC.map((f) => [f, formData.get(f) === "on"]));
  const supabase = await createClient();
  const { data, error } = await supabase.from("launches").update(flags).eq("id", id).select("id");
  if (error) back(`error=${codeFor(error.message)}`);
  if (!data || data.length === 0) back("error=refused");
  refreshed();
  back("saved=qc");
}

/** Flag or unflag a live launch as having broken in its first week. */
export async function setBrokeWeek1(formData: FormData) {
  await requireStaff();
  const id = Id.parse(formData.get("launch_id"));
  const broke = formData.get("broke") === "true";
  const supabase = await createClient();
  const { data, error } = await supabase.from("launches").update({ broke_week1: broke }).eq("id", id).not("live_at", "is", null).select("id");
  if (error) back("error=save");
  if (!data || data.length === 0) back("error=refused");
  refreshed();
  back("saved=flag");
}

const Pause = z.object({
  reason: z.enum(["client_access", "client_approval", "client_assets", "third_party"]),
  evidence_note: z.string().trim().min(1).max(2000),
});

/** Pause the launch SLA clock, with a reason and evidence. */
export async function pauseLaunch(formData: FormData) {
  const me = await requireStaff();
  const id = Id.parse(formData.get("launch_id"));
  const parsed = Pause.safeParse({ reason: formData.get("reason"), evidence_note: String(formData.get("evidence_note") ?? "") });
  if (!parsed.success) back("error=pause_invalid");
  const supabase = await createClient();
  const { error } = await supabase.from("sla_pauses").insert({ launch_id: id, paused_by: me.id, ...parsed.data! });
  // 23505 = there is already an open pause; 42501 = RLS refused (not this person's launch).
  if (error) back(`error=${error.code === "23505" ? "already_paused" : error.code === "42501" ? "refused" : "save"}`);
  refreshed();
  back("saved=paused");
}

/** Resume a paused launch SLA clock. */
export async function resumeLaunch(formData: FormData) {
  await requireStaff();
  const id = Id.parse(formData.get("launch_id"));
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sla_pauses").update({ resumed_at: new Date().toISOString() }).eq("launch_id", id).is("resumed_at", null).select("id");
  if (error) back("error=save");
  if (!data || data.length === 0) back("error=refused");
  refreshed();
  back("saved=resumed");
}

const Start = z.object({ client_id: z.uuid(), paid_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/** Owner starts a launch for a client that has no open one. The tech role holder owns it. */
export async function startLaunch(formData: FormData) {
  const me = await requireStaff();
  if (me.role !== "owner") back("error=owner_only");
  const parsed = Start.safeParse({ client_id: formData.get("client_id"), paid_date: formData.get("paid_date") });
  if (!parsed.success) back("error=start_invalid");
  const { client_id, paid_date } = parsed.data!;
  if (paid_date > etToday()) back("error=start_future");

  const supabase = await createClient();
  const { data: open, error: openError } = await supabase.from("launches").select("id").eq("client_id", client_id).is("live_at", null).limit(1);
  if (openError) back("error=save");
  if (open && open.length > 0) back("error=start_open");
  const { data: techId, error: techError } = await supabase.rpc("app_role_holder", { p_role: "tech" });
  if (techError) back("error=save");
  // Paid today = now. An earlier date is stored as noon ET, so it stays on that ET day.
  const paidAt = paid_date === etToday() ? new Date().toISOString() : new Date(etMidnight(paid_date).getTime() + 12 * 3_600_000).toISOString();
  const { error } = await supabase.from("launches").insert({ client_id, paid_at: paidAt, owner_id: techId ?? null });
  if (error) back(error.code === "42501" ? "error=owner_only" : "error=save");
  refreshed();
  back("saved=started");
}
