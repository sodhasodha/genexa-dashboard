import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { signSlackRequest } from "@/lib/slack/signature";
import { replyInClientThread, workspaceByTeamId, workspaceFromSignature } from "@/lib/slack/workspaces";

const env = { SLACK_TEAM_ID: "T_TEAM", SLACK_CLIENT_TEAM_ID: "T_CLIENT", SLACK_SIGNING_SECRET: "team-secret", SLACK_CLIENT_SIGNING_SECRET: "client-secret", SLACK_BOT_TOKEN: "xoxb-team", SLACK_CLIENT_BOT_TOKEN: "xoxb-client" };

describe("two Slack workspaces", () => {
  beforeEach(() => Object.assign(process.env, env));
  afterEach(() => vi.unstubAllGlobals());

  it("tells the workspaces apart by team id", () => {
    expect(workspaceByTeamId("T_TEAM")).toBe("team");
    expect(workspaceByTeamId("T_CLIENT")).toBe("client");
    expect(workspaceByTeamId("T_OTHER")).toBeNull();
    expect(workspaceByTeamId(null)).toBeNull();
  });

  it("recognises which install signed a request, and rejects anything else", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = "payload=%7B%7D";
    const sign = (secret: string) => ({ timestamp, body, signature: signSlackRequest(secret, timestamp, body) });
    expect(workspaceFromSignature(sign("team-secret"))).toBe("team");
    expect(workspaceFromSignature(sign("client-secret"))).toBe("client");
    expect(workspaceFromSignature(sign("someone-else"))).toBeNull();
    expect(workspaceFromSignature({ timestamp, body: `${body}x`, signature: signSlackRequest("team-secret", timestamp, body) })).toBeNull();
  });

  it("sends nothing to the client workspace while thread replies are off", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await replyInClientThread({ channel: "C1", threadTs: "1.2", text: "Logged ✓", repliesEnabled: false });
    expect(r).toEqual({ ok: false, error: "client_thread_replies_off" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("when switched on, the only thing it can send is a reply inside the thread, with the client install's token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    await replyInClientThread({ channel: "C1", threadTs: "1.2", text: "Done ✓", repliesEnabled: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer xoxb-client");
    expect(JSON.parse(init.body)).toEqual({ channel: "C1", thread_ts: "1.2", text: "Done ✓", unfurl_links: false });
  });
});
