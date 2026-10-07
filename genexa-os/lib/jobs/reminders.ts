import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { appUrl } from "@/lib/env";
import { lookupUserIdByEmail, postMessage, slackConfigured } from "@/lib/slack/client";
import { runReminders, supabaseRpc } from "@/lib/reminders/engine";

type JobResult = { ok: boolean; summary: Record<string, unknown> };

/**
 * Every 5 minutes: queue the reminders that are due and send the ones that may go
 * out now. What is due is decided in SQL (0027_reminders.sql); this only delivers.
 * Without a Slack bot token nothing is queued, so no backlog builds up to flood
 * people on the day the token is added.
 */
export const JOBS_REMINDERS: Record<string, () => Promise<JobResult>> = {
  reminders: async () => {
    if (!slackConfigured()) return { ok: true, summary: { slack: "not_configured", queued: 0, sent: 0 } };
    const db = createAdminClient();
    const startedAt = new Date().toISOString();
    try {
      const r = await runReminders({
        rpc: supabaseRpc(db),
        send: postMessage,
        lookupUserIdByEmail,
        appUrl: appUrl(),
        pauseMs: 1100, // Slack allows about one message a second
      });
      await db.from("job_runs").insert({ job: "reminders", started_at: startedAt, finished_at: new Date().toISOString(), ok: r.failed === 0, rows_processed: r.sent });
      return { ok: r.failed === 0, summary: { slack: "sent", ...r } };
    } catch (err) {
      await db.from("job_runs").insert({ job: "reminders", started_at: startedAt, finished_at: new Date().toISOString(), ok: false, error: (err as Error).message });
      throw err;
    }
  },
};
