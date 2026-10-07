// Read-only calls to the CLIENT workspace: who a user is, and a channel's history.
// The token and fetch are passed in. Nothing here can post a message.

export type SlackUser = { email: string | null; realName: string | null };

export class SlackApiError extends Error {
  constructor(public method: string, public code: string) {
    super(`Slack ${method}: ${code}`);
    this.name = "SlackApiError";
  }
}

type Deps = { token: string; fetch?: typeof fetch; timeoutMs?: number };

async function get<T>(method: string, params: Record<string, string>, deps: Deps): Promise<T> {
  const res = await (deps.fetch ?? fetch)(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${deps.token}` },
    signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
  });
  const json = (await res.json()) as T & { ok: boolean; error?: string };
  if (!json.ok) throw new SlackApiError(method, json.error ?? "unknown_error");
  return json;
}

/** users.info. Throws SlackApiError when Slack refuses (e.g. missing_scope). */
export async function fetchSlackUser(userId: string, deps: Deps): Promise<SlackUser> {
  const r = await get<{ user?: { real_name?: string; profile?: { email?: string; real_name?: string } } }>("users.info", { user: userId }, deps);
  return { email: r.user?.profile?.email ?? null, realName: r.user?.real_name ?? r.user?.profile?.real_name ?? null };
}

/** conversations.history from `oldest` (a Slack ts) to now, every page. Messages are returned as Slack sent them. */
export async function fetchChannelHistory(channel: string, oldest: string, deps: Deps & { maxPages?: number }): Promise<unknown[]> {
  const out: unknown[] = [];
  let cursor = "";
  for (let page = 0; page < (deps.maxPages ?? 50); page++) {
    const r = await get<{ messages?: unknown[]; has_more?: boolean; response_metadata?: { next_cursor?: string } }>(
      "conversations.history", { channel, oldest, limit: "200", ...(cursor ? { cursor } : {}) }, deps);
    out.push(...(r.messages ?? []));
    cursor = r.response_metadata?.next_cursor ?? "";
    if (!r.has_more || !cursor) break;
  }
  return out;
}
