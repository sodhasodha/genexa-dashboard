import { describe, expect, it } from "vitest";
import { signSlackRequest, verifySlackSignature } from "@/lib/slack/signature";
import { composeAll, duration, esc, type Pending } from "@/lib/reminders/compose";
import { handleInteraction, parseInteractionBody } from "@/lib/reminders/interaction";
import type { Rpc } from "@/lib/reminders/engine";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const NOW = new Date("2026-10-07T15:00:00Z");
const TS = String(Math.floor(NOW.getTime() / 1000));
const BODY = `payload=${encodeURIComponent(JSON.stringify({ type: "block_actions", user: { id: "U1" } }))}`;

describe("Slack request signature", () => {
  it("accepts a request signed with the app's secret", () => {
    const signature = signSlackRequest(SECRET, TS, BODY);
    expect(signature).toMatch(/^v0=[0-9a-f]{64}$/);
    expect(verifySlackSignature({ secret: SECRET, timestamp: TS, signature, body: BODY, now: NOW })).toEqual({ ok: true });
  });

  it("matches Slack's documented example", () => {
    // https://api.slack.com/authentication/verifying-requests-from-slack
    const body = "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
    expect(signSlackRequest("8f742231b10e8888abcd99yyyzzz85a5", "1531420618", body))
      .toBe("v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503");
  });

  it("rejects the wrong secret, a changed body and a missing header", () => {
    const signature = signSlackRequest("another-secret", TS, BODY);
    expect(verifySlackSignature({ secret: SECRET, timestamp: TS, signature, body: BODY, now: NOW })).toEqual({ ok: false, reason: "mismatch" });
    const good = signSlackRequest(SECRET, TS, BODY);
    expect(verifySlackSignature({ secret: SECRET, timestamp: TS, signature: good, body: `${BODY}x`, now: NOW })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySlackSignature({ secret: SECRET, timestamp: TS, signature: "v0=short", body: BODY, now: NOW })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySlackSignature({ secret: SECRET, timestamp: TS, signature: null, body: BODY, now: NOW })).toEqual({ ok: false, reason: "missing" });
    expect(verifySlackSignature({ secret: undefined, timestamp: TS, signature: good, body: BODY, now: NOW })).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects a correctly signed request older than 5 minutes", () => {
    const old = String(Number(TS) - 301);
    const signature = signSlackRequest(SECRET, old, BODY);
    expect(verifySlackSignature({ secret: SECRET, timestamp: old, signature, body: BODY, now: NOW })).toEqual({ ok: false, reason: "stale" });
    const recent = String(Number(TS) - 299);
    expect(verifySlackSignature({ secret: SECRET, timestamp: recent, signature: signSlackRequest(SECRET, recent, BODY), body: BODY, now: NOW })).toEqual({ ok: true });
  });
});

const pending = (over: Partial<Pending>): Pending => ({
  id: "n1", rule_key: "task_assigned", staff_id: "s1", staff_name: "Sameer", slack_user_id: "U1", email: null, channel: null,
  record_type: "tasks", record_id: "11111111-1111-4111-8111-111111111111", window_key: "", template: "New task", payload: {}, ...over,
});

describe("composing messages", () => {
  it("puts one Done / Snooze 1h pair under each task and links to the record", () => {
    const [g] = composeAll([pending({ payload: { title: "Fix <the> form & calendar", due: "2026-10-09", assigned_by: "Ryan" } })], "https://ops.test");
    expect(g.target).toBe("s1");
    expect(g.message.text).toContain("New task");
    expect(g.message.text).toContain("https://ops.test/tasks?task=11111111-1111-4111-8111-111111111111");
    expect(g.message.text).toContain("Fix &lt;the&gt; form &amp; calendar");
    expect(g.message.text).toContain("from Ryan · due Fri 09 Oct");
    const actions = g.message.blocks.filter((b) => b.type === "actions");
    expect(actions.length).toBe(1);
    expect(actions[0]).toMatchObject({
      block_id: "act:tasks:11111111-1111-4111-8111-111111111111",
      elements: [{ action_id: "done", value: "tasks:11111111-1111-4111-8111-111111111111" }, { action_id: "snooze_1h" }],
    });
  });

  it("merges the start-of-shift rules into one message per person and keeps other rules separate", () => {
    const groups = composeAll([
      pending({ id: "a", rule_key: "start_of_shift_digest", record_type: null, record_id: null, template: "Start of shift",
        payload: { tasks_due: [{ id: "t1", title: "Due one" }], tasks_overdue: [], exceptions: [{ id: "e1", reason: "Zero spend", severity: "red", money: 5000 }], deadlines: [], eod_missing: true } }),
      pending({ id: "b", rule_key: "task_due_today", record_id: "t1", template: "Due today", payload: { title: "Due one" } }),
      pending({ id: "c", rule_key: "tech_job_new", record_type: "tech_jobs", record_id: "j1", template: "New tech job", payload: { title: "Pixel", type: "fix", client: "Pivot" } }),
      pending({ id: "d", staff_id: "s2", rule_key: "task_due_today", record_id: "t9", template: "Due today", payload: { title: "Other person" } }),
    ], "https://ops.test");
    expect(groups.map((g) => [g.target, g.items.map((i) => i.id).join("")])).toEqual([["s1", "ab"], ["s1", "c"], ["s2", "d"]]);
    const shiftStart = groups[0].message;
    expect(shiftStart.text.split("\n")[0]).toBe("Start of shift");
    expect(shiftStart.text).toContain("Due one");
    expect(shiftStart.text).toContain("$5,000 at risk");
    expect(shiftStart.text).toContain("Yesterday's EOD is missing");
    // The task appears once, with one button pair; the exception has its own.
    expect(shiftStart.blocks.filter((b) => b.type === "actions").map((b) => b.block_id)).toEqual(["act:tasks:t1", "act:exceptions:e1"]);
    expect(groups[1].message.blocks.some((b) => b.type === "actions")).toBe(false);
  });

  it("stays inside Slack's 50-block limit however long the list is", () => {
    const many = Array.from({ length: 80 }, (_, i) => pending({ id: `n${i}`, rule_key: "task_overdue", record_id: `t${i}`, template: "Overdue", payload: { title: `Task ${i}`, days_overdue: 2 } }));
    const [g] = composeAll(many, "https://ops.test");
    expect(g.message.blocks.length).toBeLessThanOrEqual(50);
    expect(g.items.length).toBe(80);
  });

  it("formats durations and escapes Slack control characters", () => {
    expect(duration(22.4)).toBe("22m");
    expect(duration(95)).toBe("1h 35m");
    expect(duration(4 * 1440)).toBe("4d");
    expect(esc("<!channel> & co")).toBe("&lt;!channel&gt; &amp; co");
  });
});

describe("Slack button payloads", () => {
  const calls: Record<string, unknown>[] = [];
  const rpc = (async (_fn: string, args?: Record<string, unknown>) => {
    calls.push(args ?? {});
    return { result: "done", actor: "Sameer", title: "Fix the form" };
  }) as Rpc;
  const id = "11111111-1111-4111-8111-111111111111";

  it("reads the payload form field and ignores anything else", () => {
    const body = `payload=${encodeURIComponent(JSON.stringify({ type: "block_actions", user: { id: "U1" } }))}`;
    expect(parseInteractionBody(body)).toEqual({ type: "block_actions", user: { id: "U1" } });
    expect(parseInteractionBody("ssl_check=1")).toBeNull();
    expect(parseInteractionBody("payload=%7Bnot-json")).toBeNull();
  });

  it("passes the Slack user and record to slack_action, and swaps the buttons for the outcome", async () => {
    const blocks = [{ type: "section", block_id: `item:tasks:${id}` }, { type: "actions", block_id: `act:tasks:${id}` }, { type: "actions", block_id: "act:tasks:other" }];
    const reply = await handleInteraction(
      { type: "block_actions", user: { id: "U1" }, actions: [{ action_id: "done", value: `tasks:${id}` }], message: { blocks } },
      { rpc, now: new Date("2026-10-07T15:00:00Z") });
    expect(calls[0]).toEqual({ p_slack_user: "U1", p_action: "done", p_record_type: "tasks", p_record_id: id, p_now: "2026-10-07T15:00:00.000Z" });
    expect(reply.replace_original).toBe(true);
    expect(reply.text).toBe("✅ Done by Sameer: Fix the form");
    expect(reply.blocks?.map((b) => b.type)).toEqual(["section", "context", "actions"]);
  });

  it("never calls the database for a malformed button", async () => {
    calls.length = 0;
    for (const value of ["tasks:not-a-uuid", `clients:${id}`, "", `tasks:${id}'; drop table tasks`]) {
      const reply = await handleInteraction({ type: "block_actions", user: { id: "U1" }, actions: [{ action_id: "done", value }] }, { rpc });
      expect(reply.response_type).toBe("ephemeral");
    }
    expect((await handleInteraction({ type: "view_submission", user: { id: "U1" }, actions: [{ action_id: "done", value: `tasks:${id}` }] }, { rpc })).response_type).toBe("ephemeral");
    expect(calls).toEqual([]);
  });
});
