import "server-only";
import { verifySlackSignature } from "@/lib/slack/signature";

/**
 * Two installs of the same Slack app.
 *  - team:   alerts, reminders, digests, Done / Snooze buttons. Everything the app sends goes here.
 *  - client: clients' workspace. Listen-only. The app sends nothing there except a
 *            request-router thread reply, and only when that setting is switched on.
 */
export type Workspace = "team" | "client";

const config = (): Record<Workspace, { teamId?: string; token?: string; secret?: string }> => ({
  team: { teamId: process.env.SLACK_TEAM_ID, token: process.env.SLACK_BOT_TOKEN, secret: process.env.SLACK_SIGNING_SECRET },
  client: { teamId: process.env.SLACK_CLIENT_TEAM_ID, token: process.env.SLACK_CLIENT_BOT_TOKEN, secret: process.env.SLACK_CLIENT_SIGNING_SECRET },
});

export const workspaceByTeamId = (teamId: string | null | undefined): Workspace | null => {
  const c = config();
  if (teamId && teamId === c.team.teamId) return "team";
  if (teamId && teamId === c.client.teamId) return "client";
  return null;
};

/** Which workspace signed this request? Each install has its own signing secret. */
export function workspaceFromSignature(input: { timestamp: string | null; signature: string | null; body: string }): Workspace | null {
  const c = config();
  for (const w of ["team", "client"] as const) {
    if (c[w].secret && verifySlackSignature({ secret: c[w].secret, ...input }).ok) return w;
  }
  return null;
}

/**
 * The only way to post into the client workspace: a reply inside an existing
 * thread, refused unless the owner has switched thread replies on.
 */
export async function replyInClientThread(opts: { channel: string; threadTs: string; text: "Logged ✓" | "Done ✓"; repliesEnabled: boolean }): Promise<{ ok: boolean; error?: string }> {
  if (!opts.repliesEnabled) return { ok: false, error: "client_thread_replies_off" };
  const token = config().client.token;
  if (!token) return { ok: false, error: "client_workspace_not_configured" };
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: opts.channel, thread_ts: opts.threadTs, text: opts.text, unfurl_links: false }),
  });
  const json = (await res.json()) as { ok: boolean; error?: string };
  return { ok: json.ok, error: json.error };
}
