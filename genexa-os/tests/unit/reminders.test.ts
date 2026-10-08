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

describe("prospect follow-up controls", () => {
  const id = "22222222-2222-4222-8222-222222222222";
  const blockId = `act:prospects:${id}`;
  const followUp = (over: Partial<Pending> = {}) => pending({
    rule_key: "prospect_follow_up", record_type: "prospects", record_id: id, template: "Prospect follow-up",
    payload: { name: "North <Clinic>", promised: "Send the case study", follow_up_date: "2026-10-05", days_overdue: 2 }, ...over,
  });
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const answering = (result: Record<string, unknown>) =>
    (async (fn: string, args?: Record<string, unknown>) => {
      calls.push({ fn, args: args ?? {} });
      return result;
    }) as Rpc;

  it("puts a reason menu and a date picker under each prospect, and nothing but name, promise and link in the line", () => {
    const other = "33333333-3333-4333-8333-333333333333";
    const [g] = composeAll([followUp(), followUp({ id: "n2", record_id: other, payload: { name: "South Clinic", promised: null, days_overdue: 0 } })], "https://ops.test");
    expect(g.message.text).toBe([
      "Prospect follow-up",
      `<https://ops.test/pipeline?prospect=${id}|North &lt;Clinic&gt;> · 2 days overdue · promised: Send the case study`,
      `<https://ops.test/pipeline?prospect=${other}|South Clinic> · today`,
    ].join("\n"));
    const controls = g.message.blocks.filter((b) => b.type === "actions");
    expect(controls.map((b) => b.block_id)).toEqual([blockId, `act:prospects:${other}`]);
    expect(controls[0].elements).toEqual([
      {
        type: "static_select",
        action_id: "prospect_not_following_up",
        placeholder: { type: "plain_text", text: "Not following up" },
        options: [
          { text: { type: "plain_text", text: "Not a fit" }, value: "not_a_fit" },
          { text: { type: "plain_text", text: "Went with someone else" }, value: "went_elsewhere" },
          { text: { type: "plain_text", text: "Gone cold" }, value: "gone_cold" },
          { text: { type: "plain_text", text: "Other" }, value: "other" },
        ],
      },
      { type: "datepicker", action_id: "prospect_follow_up_later", placeholder: { type: "plain_text", text: "Follow up later" } },
    ]);
  });

  it("the owner's digest lists late prospects as plain lines: it has no per-item buttons", () => {
    const [g] = composeAll([pending({
      rule_key: "ryan_morning_digest", record_type: null, record_id: null, template: "Morning digest",
      payload: { at_risk: 0, open_exceptions: 0, bottlenecks: [], renewals: [], guarantees: [], missing_eods: [], stale_sources: [],
        prospects: [{ id, name: "North Clinic", promised: "Send the case study", days_overdue: 2 }] },
    })], "https://ops.test");
    expect(g.message.text).toContain("Overdue prospect follow-ups");
    expect(g.message.text).toContain("North Clinic");
    expect(g.message.blocks.some((b) => b.type === "actions")).toBe(false);
  });

  it("a chosen reason goes to slack_prospect_action and the controls become one line saying what happened", async () => {
    calls.length = 0;
    const blocks = [{ type: "section", block_id: `item:prospects:${id}` }, { type: "actions", block_id: blockId }, { type: "actions", block_id: "act:prospects:other" }];
    const reply = await handleInteraction(
      { type: "block_actions", user: { id: "U1" }, actions: [{ action_id: "prospect_not_following_up", block_id: blockId, selected_option: { value: "gone_cold" } }], message: { blocks } },
      { rpc: answering({ result: "not_following_up", actor: "Ryan", name: "North Clinic", reason: "gone_cold" }) });
    expect(calls).toEqual([{ fn: "slack_prospect_action", args: { p_slack_user: "U1", p_action: "not_following_up", p_prospect: id, p_reason: "gone_cold", p_date: null } }]);
    expect(reply.replace_original).toBe(true);
    expect(reply.text).toBe("🚫 Not following up (Gone cold) · moved to Dead by Ryan. Undo on the prospect's page.: North Clinic");
    expect(reply.blocks?.map((b) => b.type)).toEqual(["section", "context", "actions"]);
  });

  it("a picked date goes to slack_prospect_action as the new follow-up date", async () => {
    calls.length = 0;
    const reply = await handleInteraction(
      { type: "block_actions", user: { id: "U1" }, actions: [{ action_id: "prospect_follow_up_later", block_id: blockId, selected_date: "2026-10-15" }], message: { blocks: [{ type: "actions", block_id: blockId }] } },
      { rpc: answering({ result: "follow_up_later", actor: "Ryan", name: "North Clinic", date: "2026-10-15" }) });
    expect(calls).toEqual([{ fn: "slack_prospect_action", args: { p_slack_user: "U1", p_action: "follow_up_later", p_prospect: id, p_reason: null, p_date: "2026-10-15" } }]);
    expect(reply.text).toBe("📅 Follow up moved to Thu 15 Oct by Ryan. Reminders pause until then.: North Clinic");
    expect(reply.blocks?.map((b) => b.type)).toEqual(["context"]);
  });

  it("words each refusal privately and leaves the message alone", async () => {
    const press = (result: string) => handleInteraction(
      { type: "block_actions", user: { id: "U1" }, actions: [{ action_id: "prospect_follow_up_later", block_id: blockId, selected_date: "2026-10-15" }] },
      { rpc: answering({ result, actor: "Sameer" }) });
    for (const [result, text] of [
      ["refused", "Only the owner can close a prospect follow-up. Nothing was changed."],
      ["unknown_user", "Your Slack account is not linked to a Genexa OS login, so nothing was changed."],
      ["not_found", "That prospect no longer exists. Nothing was changed."],
      ["date_not_future", "Pick a date after today. Nothing was changed."],
      ["something_else", "Nothing was changed."],
    ]) {
      expect(await press(result)).toEqual({ replace_original: false, response_type: "ephemeral", text });
    }
  });

  it("never calls the database for a malformed control", async () => {
    calls.length = 0;
    const rpc = answering({ result: "not_following_up" });
    const bad = [
      { action_id: "prospect_not_following_up", block_id: blockId, selected_option: { value: "bored" } },
      { action_id: "prospect_not_following_up", block_id: blockId },
      { action_id: "prospect_not_following_up", block_id: `act:tasks:${id}`, selected_option: { value: "gone_cold" } },
      { action_id: "prospect_not_following_up", block_id: "act:prospects:not-a-uuid", selected_option: { value: "gone_cold" } },
      { action_id: "prospect_not_following_up", selected_option: { value: "gone_cold" } },
      { action_id: "prospect_follow_up_later", block_id: blockId, selected_date: "15/10/2026" },
      { action_id: "prospect_follow_up_later", block_id: blockId, selected_date: null },
      { action_id: "prospect_follow_up_later", block_id: blockId, selected_date: "2026-10-15'; drop table prospects" },
    ];
    for (const action of bad) {
      const reply = await handleInteraction({ type: "block_actions", user: { id: "U1" }, actions: [action] }, { rpc });
      expect(reply.response_type).toBe("ephemeral");
    }
    expect(calls).toEqual([]);
  });
});
