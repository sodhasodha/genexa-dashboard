// The reminder run: queue what is due (SQL), then deliver what may go out now.
// Everything that touches the outside world is passed in, so tests use a fake
// sender, a fake clock and the in-process Postgres.
import type { SupabaseClient } from "@supabase/supabase-js";
import { composeAll, type Block, type Pending } from "./compose";

/** Calls a Postgres function by name with named arguments and returns its value. */
export type Rpc = <T = unknown>(fn: string, args?: Record<string, unknown>) => Promise<T>;

export const supabaseRpc =
  (db: SupabaseClient): Rpc =>
  async <T>(fn: string, args?: Record<string, unknown>) => {
    const { data, error } = await db.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  };

export type SendResult = { ok: true; ts: string; channel: string } | { ok: false; error: string };
/** Posts to a Slack user id (DM) or channel id. */
export type Send = (target: string, text: string, blocks?: Block[]) => Promise<SendResult>;

export type DeliverDeps = {
  rpc: Rpc;
  send: Send;
  appUrl: string;
  now?: Date;
  /** Only deliver this rule (the exception engine delivers its own DMs this way). */
  rule?: string;
  /** Finds a Slack user id for a staff member who has none stored yet. */
  lookupUserIdByEmail?: (email: string) => Promise<string | null>;
  /** Pause between messages (Slack allows about one a second). */
  pauseMs?: number;
  maxMessages?: number;
};

export type DeliverResult = {
  /** Slack messages posted. */
  messages: number;
  /** Notification rows those messages covered. */
  sent: number;
  /** Waiting for the recipient's shift, a snooze, or a Slack account to match. */
  held: number;
  failed: number;
};

/** Sends every reminder that is allowed out now. Who and when is decided by reminders_deliverable. */
export async function deliverReminders(deps: DeliverDeps): Promise<DeliverResult> {
  const now = (deps.now ?? new Date()).toISOString();
  const ready = await deps.rpc<{ held: number; items: Pending[] }>("reminders_deliverable", { p_now: now, p_rule: deps.rule ?? null });
  const result: DeliverResult = { messages: 0, sent: 0, held: Number(ready?.held ?? 0), failed: 0 };
  const slackIds = new Map<string, string | null>();

  for (const group of composeAll(ready?.items ?? [], deps.appUrl)) {
    if (result.messages >= (deps.maxMessages ?? 150)) {
      result.held += group.items.length;
      continue;
    }
    let target: string | null = group.target;
    if (!group.isChannel) {
      const person = group.items[0];
      if (!slackIds.has(group.target)) {
        let slackId = person.slack_user_id;
        if (!slackId && person.email && deps.lookupUserIdByEmail) {
          slackId = await deps.lookupUserIdByEmail(person.email);
          if (slackId) await deps.rpc("reminders_set_slack_id", { p_staff: group.target, p_slack_user: slackId });
        }
        slackIds.set(group.target, slackId);
      }
      target = slackIds.get(group.target) ?? null;
    }
    if (!target) {
      result.held += group.items.length;
      continue;
    }

    // Claim first: a row another run has already taken is not sent again.
    const ids = group.items.map((i) => i.id);
    const claimed = (await deps.rpc<string[]>("reminders_claim", { p_ids: ids, p_now: now })) ?? [];
    if (claimed.length !== ids.length) {
      if (claimed.length) await deps.rpc("reminders_release", { p_ids: claimed });
      continue;
    }
    if (result.messages > 0 && (deps.pauseMs ?? 0) > 0) await new Promise((r) => setTimeout(r, deps.pauseMs));
    let sent: SendResult;
    try {
      sent = await deps.send(target, group.message.text, group.message.blocks);
    } catch (err) {
      sent = { ok: false, error: (err as Error).message };
    }
    if (sent.ok) {
      await deps.rpc("reminders_finish", { p_ids: ids, p_ts: sent.ts, p_channel: sent.channel });
      result.messages++;
      result.sent += ids.length;
    } else {
      await deps.rpc("reminders_release", { p_ids: ids });
      result.failed += ids.length;
    }
  }
  return result;
}

export type RunResult = DeliverResult & { queued: number };

/** One scheduled run: queue, then deliver. */
export async function runReminders(deps: DeliverDeps): Promise<RunResult> {
  const now = (deps.now ?? new Date()).toISOString();
  const queued = await deps.rpc<number>("reminders_enqueue", { p_now: now });
  const delivered = await deliverReminders(deps);
  return { queued: Number(queued ?? 0), ...delivered };
}
