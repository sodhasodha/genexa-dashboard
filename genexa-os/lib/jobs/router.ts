import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { processPending, sendDueReplies } from "@/lib/router/process";
import { classifierConfigured, processDeps } from "@/lib/router/runtime";

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
};
