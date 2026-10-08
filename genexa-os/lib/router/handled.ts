// "Handled in Slack": a Triage item we have already answered in Slack leaves the queue.
// The webhook does this as staff messages arrive (ingest.ts). This sweep does it
// for what the webhook did not see: items already in Triage when this shipped,
// items that only reached Triage after we had replied, and missed events.
// It reads each channel (and thread) that has open Triage rows and, for every
// message written by staff, calls router_mark_handled, which holds the rules (0042).
// Read-only towards Slack: nothing is ever posted.
import type { Rpc } from "../jobs/rpc";
import { FATAL } from "./backfill";
import { toPost, type ClientMessage } from "./events";
import { markHandled, resolveSender } from "./ingest";
import { SlackApiError, type SlackUser } from "./slack";

export type HandledDeps = {
  rpc: Rpc;
  /** conversations.history from `oldest` to now. */
  history: (channel: string, oldest: string) => Promise<unknown[]>;
  /** conversations.replies for one thread (root + replies). */
  replies: (channel: string, threadTs: string) => Promise<unknown[]>;
  /** users.info on the client workspace, for a user not seen before. */
  lookupUser: (userId: string) => Promise<SlackUser | null>;
  now?: Date;
  log?: (line: string) => void;
};

/** One channel with open Triage rows (router_open_triage). */
export type OpenTriageChannel = {
  channel: string; client_name: string; open: number; oldest_ts: string;
  /** Open rows that are not in a thread: each may be the root of one. */
  roots: string[] | null;
  /** Threads that open rows were posted in. */
  threads: string[];
};

export type HandledResult = {
  channels: number; read: number; handled: number;
  byClinic: { clinic: string; handled: number }[];
  /** Channels or threads Slack would not let the bot read (e.g. not_in_channel). */
  skippedChannels: { channel: string; clinic: string; error: string }[];
};

const tsOf = (raw: unknown): string | null => {
  const ts = (raw as { ts?: unknown } | null)?.ts;
  return typeof ts === "string" ? ts : null;
};

/**
 * Which threads to read. Every thread an open row was posted in, plus every open
 * top-level row that has replies. A row missing from the history read (it starts
 * just after the oldest row) is read too, to be safe.
 */
export function threadsToRead(open: Pick<OpenTriageChannel, "roots" | "threads">, history: unknown[]): string[] {
  const replyCount = new Map<string, number>();
  for (const raw of history) {
    const ts = tsOf(raw);
    if (ts) replyCount.set(ts, Number((raw as { reply_count?: unknown }).reply_count ?? 0) || 0);
  }
  const roots = (open.roots ?? []).filter((ts) => !replyCount.has(ts) || replyCount.get(ts)! > 0);
  return [...new Set([...open.threads, ...roots])];
}

/** Every message a person wrote, once each (a broadcast reply is in both reads), oldest first. */
export function postsInOrder(messages: unknown[], channel: string): ClientMessage[] {
  const byTs = new Map<string, ClientMessage>();
  for (const raw of messages) {
    const found = toPost(raw, channel);
    if ("message" in found) byTs.set(found.message.ts, { ...found.message, channel });
  }
  return [...byTs.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
}

export async function sweepHandled(deps: HandledDeps): Promise<HandledResult> {
  const out: HandledResult = { channels: 0, read: 0, handled: 0, byClinic: [], skippedChannels: [] };
  const open = (await deps.rpc<OpenTriageChannel[] | null>("router_open_triage")) ?? [];
  const perClinic = new Map<string, number>();
  // Who is staff is asked once per person (the same check the webhook makes).
  const people = new Map<string, { isStaff: boolean; name: string | null } | null>();
  const skip = (ch: OpenTriageChannel, err: unknown) => {
    if (!(err instanceof SlackApiError) || FATAL.has(err.code)) throw err;
    out.skippedChannels.push({ channel: ch.channel, clinic: ch.client_name, error: err.code });
    deps.log?.(`  skipped ${ch.client_name} ${ch.channel}: Slack said ${err.code}`);
  };

  for (const ch of open) {
    out.channels++;
    perClinic.set(ch.client_name, perClinic.get(ch.client_name) ?? 0);
    const messages: unknown[] = [];
    try {
      messages.push(...(await deps.history(ch.channel, ch.oldest_ts)));
    } catch (err) {
      skip(ch, err);
      continue;
    }
    for (const thread of threadsToRead(ch, messages)) {
      try {
        messages.push(...(await deps.replies(ch.channel, thread)));
      } catch (err) {
        skip(ch, err);
      }
    }
    out.read += messages.length;

    let remaining = Number(ch.open);
    for (const post of postsInOrder(messages, ch.channel)) {
      if (remaining <= 0) break;
      if (!people.has(post.user)) people.set(post.user, await resolveSender(ch.channel, post.user, { rpc: deps.rpc, lookupUser: deps.lookupUser, now: deps.now }));
      const who = people.get(post.user);
      if (!who?.isStaff) continue;
      const n = await markHandled(post, who.name, deps.rpc);
      if (n === 0) continue;
      remaining -= n;
      out.handled += n;
      perClinic.set(ch.client_name, (perClinic.get(ch.client_name) ?? 0) + n);
    }
  }
  out.byClinic = [...perClinic].map(([clinic, handled]) => ({ clinic, handled }));
  return out;
}
