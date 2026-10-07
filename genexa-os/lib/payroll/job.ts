// The Sunday pay-run job, without its plumbing: the database and Slack are
// passed in, so tests run it against a real Postgres and a fake sender.
import { usd } from "./format";
import { payRunWeek } from "./week";

export type PayRunBuilt = { runId: string; total: number; people: number; flags: number };
export type SendResult = { ok: true; ts: string; channel: string } | { ok: false; error: string };
export type PayRunSender = (slackUserId: string, text: string) => Promise<SendResult>;

export type PayRunStore = {
  /** build_pay_run for the week, then its totals. */
  build(weekStart: string): Promise<PayRunBuilt>;
  owner(): Promise<{ id: string; slackUserId: string | null } | null>;
  /**
   * Record the "pay run ready" notification for this run and owner. The unique
   * index allows one row; `sent` says whether that row has already gone out.
   */
  claim(runId: string, staffId: string): Promise<{ id: string; sent: boolean }>;
  markSent(notificationId: string, ts: string, channel: string): Promise<void>;
};

export type PayRunJobResult = {
  ok: boolean;
  summary: {
    week_start: string;
    run_id: string;
    total: number;
    people: number;
    flags: number;
    notified: string; // sent | already_sent | no_owner | no_slack_id | failed:<slack error>
  };
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function payRunMessage(built: PayRunBuilt, weekStart: string, appUrl: string): string {
  return `Pay run ready: ${usd(built.total)} across ${plural(built.people, "person", "people")}, ${plural(built.flags, "flag", "flags")}\n${appUrl}/payroll?week=${weekStart}`;
}

/**
 * Builds the draft for the ET week ending on the coming Sunday and tells the
 * owner once. The notification row is written before the message goes out, so
 * a second run in the same week sends nothing; a send that failed is retried.
 */
export async function runPayRunJob(deps: { store: PayRunStore; send: PayRunSender; today: string; appUrl: string }): Promise<PayRunJobResult> {
  const weekStart = payRunWeek(deps.today);
  const built = await deps.store.build(weekStart);
  const base = { week_start: weekStart, run_id: built.runId, total: built.total, people: built.people, flags: built.flags };

  const owner = await deps.store.owner();
  if (!owner) return { ok: true, summary: { ...base, notified: "no_owner" } };
  const note = await deps.store.claim(built.runId, owner.id);
  if (note.sent) return { ok: true, summary: { ...base, notified: "already_sent" } };
  if (!owner.slackUserId) return { ok: true, summary: { ...base, notified: "no_slack_id" } };

  const sent = await deps.send(owner.slackUserId, payRunMessage(built, weekStart, deps.appUrl));
  if (!sent.ok) return { ok: true, summary: { ...base, notified: `failed:${sent.error}` } };
  await deps.store.markSent(note.id, sent.ts, sent.channel);
  return { ok: true, summary: { ...base, notified: "sent" } };
}
