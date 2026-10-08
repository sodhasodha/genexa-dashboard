// Listening: decide whether a Slack message is a client's, and store it.
// A message from Genexa staff is never stored: it clears the Triage rows it answers.
// Who is staff and which channel is whose are decided in SQL (router_sender,
// router_save_person, router_store_message); this only orchestrates.
import type { Rpc } from "../jobs/rpc";
import type { ClientMessage, IgnoreReason } from "./events";
import type { SlackUser } from "./slack";

export type IngestDeps = {
  rpc: Rpc;
  /** users.info on the client workspace. May throw or return null: the sender is then treated as a client. */
  lookupUser: (userId: string) => Promise<SlackUser | null>;
  now?: Date;
};

export type IngestResult =
  | { action: "stored"; id: string }
  | { action: "duplicate"; id: string }
  | { action: "ignored"; reason: IgnoreReason };

type SenderRow = {
  client_id: string;
  channel_kind: "general" | "scheduling";
  person: { is_staff: boolean; email: string | null; real_name: string | null; checked_at: string } | null;
};

// A user whose lookup failed is looked up again after this long.
const RECHECK_MS = 60 * 60 * 1000;

export type Sender = { isStaff: boolean; name: string | null };

/**
 * Who posted in a client channel: staff or client. Null when the channel is no
 * client's. A user not seen before (or whose lookup failed over an hour ago) is
 * looked up with users.info and remembered (router_save_person decides staff).
 */
export async function resolveSender(channel: string, userId: string, deps: IngestDeps): Promise<Sender | null> {
  const sender = await deps.rpc<SenderRow | null>("router_sender", { p_channel: channel, p_user: userId });
  if (!sender) return null;

  let isStaff = sender.person?.is_staff ?? false;
  let name = sender.person?.real_name ?? null;
  const now = (deps.now ?? new Date()).getTime();
  const stale = !!sender.person && sender.person.email === null && now - new Date(sender.person.checked_at).getTime() > RECHECK_MS;
  if (!sender.person || stale) {
    let user: SlackUser | null = null;
    try {
      user = await deps.lookupUser(userId);
    } catch {
      user = null;
    }
    isStaff = (await deps.rpc<boolean>("router_save_person", { p_user: userId, p_email: user?.email ?? null, p_real_name: user?.realName ?? null })) === true;
    name = user?.realName ?? name;
  }
  return { isStaff, name };
}

/** A staff message: clears the Triage rows it answers (0042). Returns how many. */
export const markHandled = async (msg: Pick<ClientMessage, "channel" | "ts" | "user" | "threadTs">, name: string | null, rpc: Rpc): Promise<number> =>
  Number(await rpc<number>("router_mark_handled", { p_channel: msg.channel, p_ts: msg.ts, p_thread_ts: msg.threadTs, p_by: name ?? msg.user })) || 0;

export async function ingestClientMessage(msg: ClientMessage, deps: IngestDeps, mode: "live" | "backfill" = "live"): Promise<IngestResult> {
  const sender = await resolveSender(msg.channel, msg.user, deps);
  if (!sender) return { action: "ignored", reason: "unknown_channel" };
  if (sender.isStaff) {
    // Never stored as a client request. Our reply is what clears a Triage item.
    await markHandled(msg, sender.name, deps.rpc);
    return { action: "ignored", reason: "staff" };
  }
  // A file with no words is not a request.
  if (!msg.text) return { action: "ignored", reason: "empty" };

  const stored = await deps.rpc<{ id: string; created: boolean } | null>("router_store_message", {
    p_channel: msg.channel, p_ts: msg.ts, p_user: msg.user, p_sender_name: sender.name, p_text: msg.text, p_thread_ts: msg.threadTs, p_mode: mode,
  });
  if (!stored) return { action: "ignored", reason: "unknown_channel" };
  return { action: stored.created ? "stored" : "duplicate", id: stored.id };
}
