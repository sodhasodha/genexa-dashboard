import { resolvePeriod } from "@/lib/periods";
import { addDays } from "@/lib/time";
import type { JobResult, Rpc } from "@/lib/jobs/rpc";
import { composeClientWeekReport, shortDate, type ClientWeekRow } from "@/lib/reports/clientWeek";

export type SendResult = { ok: true; ts: string; channel: string } | { ok: false; error: string };
export type SendMessage = (slackUserId: string, text: string) => Promise<SendResult>;

type Digest = {
  owner_id: string | null;
  slack_user_id: string | null;
  owner_email: string | null;
  red: { name: string; reasons: string | null }[];
};

export type DmOutcome = "sent" | "already_sent" | "failed" | "no_owner" | "no_slack_user";

/** The owner's Monday message: red clinics with reasons, and how many reports are ready. */
export function composeOwnerMessage(opts: { weekStart: string; weekEnd: string; prepared: number; red: Digest["red"]; clientsUrl: string }): string {
  const { weekStart, weekEnd, prepared, red, clientsUrl } = opts;
  const reports = `${prepared} client ${prepared === 1 ? "report" : "reports"} prepared for ${shortDate(weekStart)} to ${shortDate(weekEnd)}.`;
  const reds = red.length === 0
    ? ["No red clinics."]
    : [`Red clinics (${red.length}):`, ...red.map((r) => `• ${r.name}: ${r.reasons ?? "no reason recorded"}`)];
  return [reports, ...reds, clientsUrl].join("\n");
}

/**
 * Monday 09:00 ET. Writes last week's report for every live, verified clinic
 * into client_reports (nothing is emailed), then sends the owner one Slack
 * message. The week's message is claimed in `notifications` before it is sent,
 * so a second run in the same week sends nothing.
 */
export async function runWeeklyClientReport(opts: {
  rpc: Rpc;
  send: SendMessage;
  /** Finds a Slack user id when the owner's is not stored yet. */
  lookupSlackId?: (email: string) => Promise<string | null>;
  /** Current ET date, YYYY-MM-DD. */
  today: string;
  appUrl: string;
  /** Monday of the week to report on. Default: the week before `today`'s. */
  weekStart?: string;
}): Promise<JobResult> {
  const { rpc, send, lookupSlackId, today, appUrl } = opts;
  const weekStart = opts.weekStart ?? resolvePeriod("week", today).prevFrom;

  const rows = await rpc<ClientWeekRow[]>("client_week_report", { p_week_start: weekStart });
  for (const row of rows) {
    await rpc("store_client_report", {
      p_client_id: row.client_id, p_week_start: row.week_start, p_body: composeClientWeekReport(row), p_numbers: row,
    });
  }
  const summary = { week_start: weekStart, reports: rows.length };

  const digest = await rpc<Digest>("weekly_report_digest");
  const done = (dm: DmOutcome, extra: Record<string, unknown> = {}): JobResult =>
    ({ ok: dm !== "failed", summary: { ...summary, red: digest.red.length, dm, ...extra } });

  if (!digest.owner_id) return done("no_owner");
  const slackId = digest.slack_user_id
    ?? (digest.owner_email && lookupSlackId ? await lookupSlackId(digest.owner_email) : null);
  if (!slackId) return done("no_slack_user");

  const claim = await rpc<string | null>("weekly_report_claim", { p_week_start: weekStart, p_staff_id: digest.owner_id });
  if (!claim) return done("already_sent");

  const text = composeOwnerMessage({
    weekStart, weekEnd: addDays(weekStart, 6), prepared: rows.length, red: digest.red, clientsUrl: `${appUrl}/clients`,
  });
  let sent: SendResult;
  try {
    sent = await send(slackId, text);
  } catch (err) {
    sent = { ok: false, error: (err as Error).message };
  }
  await rpc("weekly_report_sent", sent.ok
    ? { p_id: claim, p_ok: true, p_slack_ts: sent.ts, p_channel: sent.channel }
    : { p_id: claim, p_ok: false, p_error: sent.error });
  return sent.ok ? done("sent") : done("failed", { error: sent.error });
}
