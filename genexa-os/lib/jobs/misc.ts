import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { appUrl } from "@/lib/env";
import { etToday } from "@/lib/time";
import { lookupUserIdByEmail, postMessage } from "@/lib/slack/client";
import { runDailySnapshot } from "@/lib/jobs/dailySnapshot";
import { runWeeklyClientReport } from "@/lib/reports/weeklyClientReport";
import type { JobResult, Rpc } from "@/lib/jobs/rpc";

const rpcOf = (db: SupabaseClient): Rpc => async <T>(fn: string, args?: Record<string, unknown>) => {
  const { data, error } = await db.rpc(fn, args ?? {});
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
};

/** Runs a job and records it in job_runs, whether it worked or not. */
async function logged(job: string, run: (rpc: Rpc) => Promise<JobResult>): Promise<JobResult> {
  const db = createAdminClient();
  const started_at = new Date().toISOString();
  try {
    const result = await run(rpcOf(db));
    await db.from("job_runs").insert({ job, started_at, finished_at: new Date().toISOString(), ok: result.ok });
    return result;
  } catch (err) {
    await db.from("job_runs").insert({ job, started_at, finished_at: new Date().toISOString(), ok: false, error: (err as Error).message.slice(0, 900) });
    throw err;
  }
}

/**
 * Freeze a specific month as a back-fill (any day in it, YYYY-MM-DD). Not
 * reachable over HTTP: call it from a script. A frozen month is never overwritten.
 */
export const backfillAgencyMonth = (month: string) =>
  logged("daily-snapshot", (rpc) => runDailySnapshot({ rpc, today: etToday(), month }));

export const JOBS_MISC: Record<string, () => Promise<{ ok: boolean; summary: Record<string, unknown> }>> = {
  // 00:05 ET: store the week's scorecards; on the 1st, freeze last month.
  "daily-snapshot": () => logged("daily-snapshot", (rpc) => runDailySnapshot({ rpc, today: etToday() })),
  // Monday 09:00 ET: last week's report per clinic (stored, not emailed) and one Slack message to the owner.
  "weekly-client-report": () =>
    logged("weekly-client-report", (rpc) =>
      runWeeklyClientReport({
        rpc, today: etToday(), appUrl: appUrl(),
        send: (slackUserId, text) => postMessage(slackUserId, text),
        lookupSlackId: lookupUserIdByEmail,
      })),
};
