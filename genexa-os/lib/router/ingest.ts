// Listening: decide whether a Slack message is a client's, and store it.
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

type Sender = {
  client_id: string;
  channel_kind: "general" | "scheduling";
  person: { is_staff: boolean; email: string | null; real_name: string | null; checked_at: string } | null;
};

// A user whose lookup failed is looked up again after this long.
const RECHECK_MS = 60 * 60 * 1000;

export async function ingestClientMessage(msg: ClientMessage, deps: IngestDeps, mode: "live" | "backfill" = "live"): Promise<IngestResult> {
  const sender = await deps.rpc<Sender | null>("router_sender", { p_channel: msg.channel, p_user: msg.user });
  if (!sender) return { action: "ignored", reason: "unknown_channel" };

  let isStaff = sender.person?.is_staff ?? false;
  let name = sender.person?.real_name ?? null;
  const now = (deps.now ?? new Date()).getTime();
  const stale = !!sender.person && sender.person.email === null && now - new Date(sender.person.checked_at).getTime() > RECHECK_MS;
  if (!sender.person || stale) {
    let user: SlackUser | null = null;
    try {
      user = await deps.lookupUser(msg.user);
    } catch {
      user = null;
    }
    isStaff = (await deps.rpc<boolean>("router_save_person", { p_user: msg.user, p_email: user?.email ?? null, p_real_name: user?.realName ?? null })) === true;
    name = user?.realName ?? name;
  }
  if (isStaff) return { action: "ignored", reason: "staff" };

  const stored = await deps.rpc<{ id: string; created: boolean } | null>("router_store_message", {
    p_channel: msg.channel, p_ts: msg.ts, p_user: msg.user, p_sender_name: name, p_text: msg.text, p_thread_ts: msg.threadTs, p_mode: mode,
  });
  if (!stored) return { action: "ignored", reason: "unknown_channel" };
  return { action: stored.created ? "stored" : "duplicate", id: stored.id };
}
