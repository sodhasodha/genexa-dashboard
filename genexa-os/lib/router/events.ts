// What counts as a client message. Pure: no database, no network.

export type ClientMessage = { channel: string; ts: string; user: string; text: string; threadTs: string | null };

export type IgnoreReason =
  | "not_a_message" | "subtype" | "bot" | "no_user" | "empty"
  | "unknown_channel" | "staff";

/**
 * Subtypes that are still a person writing a message: one with a file attached,
 * and a thread reply also sent to the channel. Every other subtype (edits,
 * deletions, joins, bot messages, ...) is ignored.
 */
const HUMAN_SUBTYPES = new Set(["file_share", "thread_broadcast"]);

type RawMessage = {
  type?: unknown; subtype?: unknown; bot_id?: unknown; user?: unknown; text?: unknown;
  ts?: unknown; channel?: unknown; thread_ts?: unknown;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * A Slack message object -> who posted what, where. The text may be empty (a file
 * on its own): that is no client request, but it is still a staff reply.
 */
export function toPost(raw: unknown, channel?: string): { message: ClientMessage } | { ignored: IgnoreReason } {
  const m = (raw ?? {}) as RawMessage;
  if (m.type !== "message") return { ignored: "not_a_message" };
  if (m.subtype !== undefined && m.subtype !== null && !HUMAN_SUBTYPES.has(String(m.subtype))) return { ignored: "subtype" };
  if (m.bot_id) return { ignored: "bot" };
  const user = str(m.user);
  const ts = str(m.ts);
  const ch = str(m.channel) ?? channel ?? null;
  if (!ts || !ch) return { ignored: "not_a_message" };
  if (!user) return { ignored: "no_user" };
  const text = typeof m.text === "string" ? m.text.trim() : "";
  const threadTs = str(m.thread_ts);
  return { message: { channel: ch, ts, user, text, threadTs: threadTs && threadTs !== ts ? threadTs : null } };
}

/** A Slack message object (from an event or from conversations.history) -> a client message, or why not. */
export function toClientMessage(raw: unknown, channel?: string): { message: ClientMessage } | { ignored: IgnoreReason } {
  const found = toPost(raw, channel);
  if ("message" in found && !found.message.text) return { ignored: "empty" };
  return found;
}

/** An Events API body -> the client message in it, or why there is none. */
export function messageFromEventBody(body: unknown): { message: ClientMessage } | { ignored: IgnoreReason } {
  const b = (body ?? {}) as { type?: unknown; event?: unknown };
  if (b.type !== "event_callback") return { ignored: "not_a_message" };
  return toClientMessage(b.event);
}

/** An Events API body -> the post in it, text or not (the webhook: a staff reply with only a file still counts). */
export function postFromEventBody(body: unknown): { message: ClientMessage } | { ignored: IgnoreReason } {
  const b = (body ?? {}) as { type?: unknown; event?: unknown };
  if (b.type !== "event_callback") return { ignored: "not_a_message" };
  return toPost(b.event);
}

/** Link to a message, built from its channel and ts (no API call). */
export const permalink = (channel: string, ts: string): string => `https://slack.com/archives/${channel}/p${ts.replace(".", "")}`;

/** A Slack ts ("1760000000.000100") as an instant. */
export const tsToDate = (ts: string): Date => new Date(Math.round(Number(ts) * 1000));
