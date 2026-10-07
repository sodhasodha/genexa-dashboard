import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appUrl } from "@/lib/env";
import { runPayRunJob, type PayRunJobResult, type PayRunSender, type PayRunStore } from "@/lib/payroll/job";
import { postMessage } from "@/lib/slack/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { etToday } from "@/lib/time";

const RULE = "pay_run_ready";

/** The job's reads and writes, through the service-role client. */
export function supabasePayRunStore(db: SupabaseClient): PayRunStore {
  return {
    async build(weekStart) {
      const built = await db.rpc("build_pay_run", { p_week_start: weekStart });
      if (built.error || !built.data) throw new Error(`build_pay_run: ${built.error?.message ?? "no run returned"}`);
      const runId = built.data as string;
      const totals = await db.from("pay_run_totals").select("total, people, flag_count").eq("id", runId).single();
      if (totals.error) throw new Error(`pay_run_totals: ${totals.error.message}`);
      return { runId, total: Number(totals.data.total), people: Number(totals.data.people), flags: Number(totals.data.flag_count) };
    },
    async owner() {
      const holder = await db.rpc("app_role_holder", { p_role: "owner" });
      if (holder.error) throw new Error(`app_role_holder: ${holder.error.message}`);
      if (!holder.data) return null;
      const staff = await db.from("staff").select("id, slack_user_id").eq("id", holder.data as string).maybeSingle();
      if (staff.error) throw new Error(`staff: ${staff.error.message}`);
      return staff.data ? { id: staff.data.id as string, slackUserId: (staff.data.slack_user_id as string | null) ?? null } : null;
    },
    async claim(runId, staffId) {
      const key = { rule_key: RULE, staff_id: staffId, record_type: "pay_runs", record_id: runId };
      const inserted = await db.from("notifications").insert(key).select("id").single();
      if (!inserted.error) return { id: inserted.data.id as string, sent: false };
      if (inserted.error.code !== "23505") throw new Error(`notifications: ${inserted.error.message}`);
      const existing = await db.from("notifications").select("id, sent_at").match(key).eq("window_key", "").single();
      if (existing.error) throw new Error(`notifications: ${existing.error.message}`);
      return { id: existing.data.id as string, sent: existing.data.sent_at !== null };
    },
    async markSent(notificationId, ts, channel) {
      const { error } = await db.from("notifications").update({ sent_at: new Date().toISOString(), slack_ts: ts, channel }).eq("id", notificationId);
      if (error) throw new Error(`notifications: ${error.message}`);
    },
  };
}

/** Sunday evening: build the week's draft pay run and DM the owner once. The sender can be replaced in tests. */
export async function payRunJob(opts: { db?: SupabaseClient; send?: PayRunSender; today?: string } = {}): Promise<PayRunJobResult> {
  const db = opts.db ?? createAdminClient();
  const startedAt = new Date().toISOString();
  try {
    const result = await runPayRunJob({
      store: supabasePayRunStore(db),
      send: opts.send ?? ((slackUserId, text) => postMessage(slackUserId, text)),
      today: opts.today ?? etToday(),
      appUrl: appUrl(),
    });
    await db.from("job_runs").insert({ job: "pay-run", started_at: startedAt, finished_at: new Date().toISOString(), ok: true, rows_processed: result.summary.people });
    return result;
  } catch (err) {
    await db.from("job_runs").insert({ job: "pay-run", started_at: startedAt, finished_at: new Date().toISOString(), ok: false, error: (err as Error).message });
    throw err;
  }
}

export const JOBS_PAYROLL: Record<string, () => Promise<{ ok: boolean; summary: Record<string, unknown> }>> = {
  "pay-run": () => payRunJob(),
};
