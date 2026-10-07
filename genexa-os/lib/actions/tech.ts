"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/staff";
import { createClient } from "@/lib/supabase/server";

// Every write goes through the logged-in user's Supabase client, so RLS decides
// who may do it (anyone requests; only the job's owner or the app owner works a
// job) and the audit log records who did.

const blank = (v: FormDataEntryValue | null) => (v === null || String(v).trim() === "" ? null : String(v).trim());
const fail = (code: string): never => redirect(`/tech?error=${code}`);
const ok = (code: string): never => {
  revalidatePath("/tech");
  redirect(`/tech?saved=${code}`);
};

const Request = z.object({
  type: z.enum(["launch", "fix", "build", "other"]),
  client_id: z.uuid().nullable(),
  title: z.string().min(1).max(200),
  notes: z.string().max(4000).nullable(),
});

/** Any staff member asks for tech work. It goes to the tech person; the database sets the due time. */
export async function requestTechWork(formData: FormData) {
  const me = await requireStaff();
  const parsed = Request.safeParse({
    type: formData.get("type"),
    client_id: blank(formData.get("client_id")),
    title: blank(formData.get("title")) ?? "",
    notes: blank(formData.get("notes")),
  });
  if (!parsed.success) fail("request_invalid");

  const supabase = await createClient();
  const holder = await supabase.rpc("app_role_holder", { p_role: "tech" });
  if (holder.error || !holder.data) fail("no_tech");
  const { error } = await supabase.from("tech_jobs").insert({ ...parsed.data!, requested_by: me.id, owner_id: holder.data as string });
  if (error) fail("request_save");
  ok("requested");
}

const Status = z.object({ job_id: z.uuid(), status: z.enum(["todo", "working", "stuck", "done"]) });

export async function setJobStatus(formData: FormData) {
  await requireStaff();
  const parsed = Status.safeParse({ job_id: formData.get("job_id"), status: formData.get("status") });
  if (!parsed.success) fail("invalid");
  const supabase = await createClient();
  const { data, error } = await supabase.from("tech_jobs").update({ status: parsed.data!.status }).eq("id", parsed.data!.job_id).select("id");
  if (error) fail("save");
  if (!data || data.length === 0) fail("not_yours");
  ok("status");
}

const Blocked = z.object({ job_id: z.uuid(), blocked_on: z.string().max(500).nullable() });

export async function setBlockedOn(formData: FormData) {
  await requireStaff();
  const parsed = Blocked.safeParse({ job_id: formData.get("job_id"), blocked_on: blank(formData.get("blocked_on")) });
  if (!parsed.success) fail("invalid");
  const supabase = await createClient();
  const { data, error } = await supabase.from("tech_jobs").update({ blocked_on: parsed.data!.blocked_on }).eq("id", parsed.data!.job_id).select("id");
  if (error) fail("save");
  if (!data || data.length === 0) fail("not_yours");
  ok("blocked");
}

const Pause = z.object({
  job_id: z.uuid(),
  reason: z.enum(["client_access", "client_approval", "client_assets", "third_party"]),
  evidence_note: z.string().min(1).max(1000),
});

/** Stop the SLA clock while waiting on someone outside Genexa. Needs a reason and evidence. */
export async function pauseJob(formData: FormData) {
  const me = await requireStaff();
  const parsed = Pause.safeParse({
    job_id: formData.get("job_id"),
    reason: formData.get("reason"),
    evidence_note: blank(formData.get("evidence_note")) ?? "",
  });
  if (!parsed.success) fail("pause_invalid");
  const { job_id, reason, evidence_note } = parsed.data!;
  const supabase = await createClient();
  const { error } = await supabase.from("sla_pauses").insert({ tech_job_id: job_id, reason, evidence_note, paused_by: me.id });
  if (error) {
    if (error.code === "23505") fail("already_paused");
    if (error.code === "42501") fail("not_yours");
    fail("save");
  }
  ok("paused");
}

const Resume = z.object({ job_id: z.uuid() });

export async function resumeJob(formData: FormData) {
  await requireStaff();
  const parsed = Resume.safeParse({ job_id: formData.get("job_id") });
  if (!parsed.success) fail("invalid");
  const supabase = await createClient();
  // The database closes the pause on its own clock; RLS limits it to the job's owner or the app owner.
  const { data, error } = await supabase.rpc("resume_tech_job", { p_job_id: parsed.data!.job_id });
  if (error) fail("save");
  if (!data) fail("not_paused");
  ok("resumed");
}
