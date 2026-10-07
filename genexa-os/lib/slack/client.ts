import "server-only";

export type SlackResult = { ok: true; ts: string; channel: string } | { ok: false; error: string };

/** True once the Genexa OS Slack app's bot token is set. */
export const slackConfigured = () => !!process.env.SLACK_BOT_TOKEN;

async function slack<T>(method: string, body: Record<string, unknown>): Promise<T & { ok: boolean; error?: string }> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T & { ok: boolean; error?: string };
}

/** Post to a channel id or DM a user id. */
export async function postMessage(channelOrUser: string, text: string, blocks?: unknown[]): Promise<SlackResult> {
  if (!slackConfigured()) return { ok: false, error: "slack_not_configured" };
  const r = await slack<{ ts: string; channel: string }>("chat.postMessage", { channel: channelOrUser, text, blocks, unfurl_links: false });
  return r.ok ? { ok: true, ts: r.ts, channel: r.channel } : { ok: false, error: r.error ?? "unknown_error" };
}

/**
 * Answer a button press through the response_url Slack sent with it. Only Slack's
 * own hooks host is ever called, so a payload cannot point this anywhere else.
 */
export async function respondToInteraction(responseUrl: string, body: object): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(responseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com") return false;
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
  return res.ok;
}

export async function lookupUserIdByEmail(email: string): Promise<string | null> {
  if (!slackConfigured()) return null;
  const res = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  });
  const r = (await res.json()) as { ok: boolean; user?: { id: string } };
  return r.ok && r.user ? r.user.id : null;
}
