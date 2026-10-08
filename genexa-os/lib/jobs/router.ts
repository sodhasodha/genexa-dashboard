import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { processPending, sendDueReplies } from "@/lib/router/process";
import { sweepHandled } from "@/lib/router/handled";
import { classifierConfigured, handledDeps, processDeps } from "@/lib/router/runtime";

type JobResult = { ok: boolean; summary: Record<string, unknown> };

async function logged(job: string, run: () => Promise<JobResult & { rows?: number }>): Promise<JobResult> {
  const db = createAdminClient();
  const started_at = new Date().toISOString();
  try {
    const { rows, ...result } = await run();
    await db.from("job_runs").insert({ job, started_at, finished_at: new Date().toISOString(), ok: result.ok, rows_processed: rows ?? null });
    return result;
  } catch (err) {
    await db.from("job_runs").insert({ job, started_at, finished_at: new Date().toISOString(), ok: false, error: (err as Error).message.slice(0, 900) });
    throw err;
  }
}

/**
 * The client request router's scheduled work. Routing itself is decided in SQL
 * (route_client_request, 0035); these only pick up and deliver.
 */
export const JOBS_ROUTER: Record<string, () => Promise<{ ok: boolean; summary: Record<string, unknown> }>> = {
  // Every few minutes: classify and route any stored client message that has not
  // been yet (the webhook's own follow-up was cut short, or the model failed).
  "router-process": async () => {
    // Without a key nothing is attempted, so messages wait instead of using up their 5 tries.
    if (!classifierConfigured()) return { ok: true, summary: { anthropic: "not_configured", picked: 0 } };
    return logged("router-process", async () => {
      const r = await processPending(processDeps());
      return { ok: true, summary: { ...r }, rows: r.picked };
    });
  },
  // Every few minutes: "Logged ✓" replies that failed to send, and "Done ✓" for
  // requests whose task, tech job or exception has since been closed. Sends
  // nothing unless client_workspace_thread_replies is on.
  "router-replies": async () =>
    logged("router-replies", async () => {
      const r = await sendDueReplies(processDeps());
      return { ok: r.failed === 0, summary: { ...r }, rows: r.sent };
    }),
  // Triage items we have already answered in Slack (a staff reply in the thread, or a
  // staff post in the channel afterwards) are marked "Handled in Slack". The webhook
  // does this as replies arrive; this catches the ones it missed and the items that
  // only reached Triage after we had replied. Reads Slack, posts nothing.
  "router-handled": async () => {
    const deps = handledDeps();
    if (!deps) return { ok: true, summary: { slack: "not_configured", handled: 0 } };
    return logged("router-handled", async () => {
      const r = await sweepHandled(deps);
      return { ok: r.skippedChannels.length === 0, summary: { ...r }, rows: r.handled };
    });
  },
};
