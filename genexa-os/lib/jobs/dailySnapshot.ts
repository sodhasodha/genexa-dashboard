import { addDays } from "@/lib/time";
import type { JobResult, Rpc } from "@/lib/jobs/rpc";

/**
 * 00:05 ET. Stores the scorecards of the week containing yesterday, and on the
 * 1st of the month freezes last month. Pass `month` (any day in it) to freeze a
 * specific month as a back-fill. The numbers are all built in SQL.
 */
export async function runDailySnapshot(opts: { rpc: Rpc; today: string; month?: string }): Promise<JobResult> {
  const { rpc, today, month } = opts;
  const scores = await rpc<{ week_start: string; rows: number }>("snapshot_person_scores", { p_day: addDays(today, -1) });
  const target = month ?? (today.endsWith("-01") ? addDays(today, -1) : null);
  const frozen = target
    ? await rpc<{ frozen: boolean; month: string; reason?: string }>("freeze_agency_month", { p_month: target })
    : null;
  return { ok: true, summary: { scores, agency_month: frozen } };
}
