import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import type { Rpc } from "@/lib/jobs/rpc";
import {
  CLASSIFICATION_JSON_SCHEMA, ClassifyError, ROUTER_MODEL, ROUTER_SYSTEM_PROMPT, buildClassifyRequest, classifyMessage, type ClassifyInput,
} from "@/lib/router/classify";
import { messageFromEventBody, permalink, postFromEventBody, toClientMessage, tsToDate } from "@/lib/router/events";
import { postsInOrder, sweepHandled, threadsToRead } from "@/lib/router/handled";
import { ingestClientMessage } from "@/lib/router/ingest";
import { processRequest, sendDueReplies } from "@/lib/router/process";
import { formatDue, isClientThreadText, loggedReplyText } from "@/lib/router/replies";
import { SlackApiError, fetchChannelHistory, fetchSlackUser, fetchThreadReplies } from "@/lib/router/slack";
import { replyInClientThread } from "@/lib/slack/workspaces";

const event = (over: Record<string, unknown> = {}) => ({
  type: "event_callback", team_id: "T_CLIENT",
  event: { type: "message", channel: "C0GENERAL", user: "U_DANA", text: "Please block Wednesday 21st October", ts: "1760000000.000100", ...over },
});

/** A fake database: answers each function from a table and records the calls. */
function fakeRpc(answers: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rpc: Rpc = async <T>(fn: string, args: Record<string, unknown> = {}) => {
    calls.push({ fn, args });
    if (!(fn in answers)) throw new Error(`unexpected rpc ${fn}`);
    const a = answers[fn];
    return (typeof a === "function" ? (a as (x: Record<string, unknown>) => unknown)(args) : a) as T;
  };
  return { rpc, calls, called: (fn: string) => calls.filter((c) => c.fn === fn) };
}

describe("which Slack events are client messages", () => {
  it("accepts a plain message from a person", () => {
    expect(messageFromEventBody(event())).toEqual({
      message: { channel: "C0GENERAL", ts: "1760000000.000100", user: "U_DANA", text: "Please block Wednesday 21st October", threadTs: null },
    });
  });

  it("ignores edits, joins, deletions and bot messages", () => {
    for (const subtype of ["message_changed", "channel_join", "message_deleted", "bot_message", "channel_topic"]) {
      expect(messageFromEventBody(event({ subtype }))).toEqual({ ignored: "subtype" });
    }
    expect(messageFromEventBody(event({ bot_id: "B123" }))).toEqual({ ignored: "bot" });
    expect(messageFromEventBody(event({ user: undefined }))).toEqual({ ignored: "no_user" });
    expect(messageFromEventBody(event({ text: "   " }))).toEqual({ ignored: "empty" });
  });

  it("ignores anything that is not a message event", () => {
    expect(messageFromEventBody({ type: "event_callback", event: { type: "reaction_added", user: "U1" } })).toEqual({ ignored: "not_a_message" });
    expect(messageFromEventBody({ type: "url_verification", challenge: "x" })).toEqual({ ignored: "not_a_message" });
    expect(messageFromEventBody(null)).toEqual({ ignored: "not_a_message" });
  });

  it("keeps a message with a file attached, and remembers the thread of a threaded message", () => {
    expect("message" in messageFromEventBody(event({ subtype: "file_share" }))).toBe(true);
    const threaded = messageFromEventBody(event({ thread_ts: "1759990000.000200" }));
    expect("message" in threaded && threaded.message.threadTs).toBe("1759990000.000200");
    // A thread's first message carries its own ts as thread_ts.
    const root = messageFromEventBody(event({ thread_ts: "1760000000.000100" }));
    expect("message" in root && root.message.threadTs).toBeNull();
  });

  it("reads a history message, which carries no channel of its own", () => {
    const m = toClientMessage({ type: "message", user: "U1", text: "hi", ts: "1.2" }, "C9");
    expect("message" in m && m.message.channel).toBe("C9");
  });

  it("builds the permalink from channel and ts", () => {
    expect(permalink("C0GENERAL", "1760000000.000100")).toBe("https://slack.com/archives/C0GENERAL/p1760000000000100");
    expect(tsToDate("1760000000.000100").toISOString()).toBe("2025-10-09T08:53:20.000Z");
  });
});

describe("storing a client message", () => {
  const msg = { channel: "C0GENERAL", ts: "1760000000.000100", user: "U_DANA", text: "Please block Wednesday", threadTs: null };
  const sender = (person: unknown) => ({ client_id: "c1", channel_kind: "general", person });

  it("drops a message in a channel that is no client's", async () => {
    const db = fakeRpc({ router_sender: null });
    const lookupUser = vi.fn();
    expect(await ingestClientMessage(msg, { rpc: db.rpc, lookupUser })).toEqual({ action: "ignored", reason: "unknown_channel" });
    expect(lookupUser).not.toHaveBeenCalled();
    expect(db.called("router_store_message")).toHaveLength(0);
  });

  it("drops a message from Genexa staff without storing it", async () => {
    const db = fakeRpc({ router_sender: sender({ is_staff: true, email: "sameer@genexascaling.com", real_name: "Sameer", checked_at: new Date().toISOString() }), router_mark_handled: 0 });
    const lookupUser = vi.fn();
    expect(await ingestClientMessage(msg, { rpc: db.rpc, lookupUser })).toEqual({ action: "ignored", reason: "staff" });
    expect(lookupUser).not.toHaveBeenCalled();
    expect(db.called("router_store_message")).toHaveLength(0);
  });

  it("a staff message clears the Triage rows it answers: channel, ts, thread and the staff member's name go to the database", async () => {
    const staff = sender({ is_staff: true, email: "sameer@genexascaling.com", real_name: "Sameer", checked_at: new Date().toISOString() });
    const db = fakeRpc({ router_sender: staff, router_mark_handled: 2 });
    const reply = { ...msg, user: "U_SAMEER", ts: "1760000100.000200", threadTs: "1760000000.000100" };
    expect(await ingestClientMessage(reply, { rpc: db.rpc, lookupUser: vi.fn() })).toEqual({ action: "ignored", reason: "staff" });
    expect(db.called("router_mark_handled")).toHaveLength(1);
    expect(db.called("router_mark_handled")[0].args).toEqual({ p_channel: "C0GENERAL", p_ts: "1760000100.000200", p_thread_ts: "1760000000.000100", p_by: "Sameer" });
    // A staff reply that is only a file (no text) counts too; with no name on record the Slack user id is kept.
    const nameless = fakeRpc({ router_sender: sender({ is_staff: true, email: "va@genexascaling.com", real_name: null, checked_at: new Date().toISOString() }), router_mark_handled: 1 });
    expect(await ingestClientMessage({ ...reply, text: "" }, { rpc: nameless.rpc, lookupUser: vi.fn() })).toEqual({ action: "ignored", reason: "staff" });
    expect(nameless.called("router_mark_handled")[0].args).toMatchObject({ p_by: "U_SAMEER" });
  });

  it("a client's message never clears anything, and a client's file with no words is not stored", async () => {
    const known = sender({ is_staff: false, email: "dana@clinic.test", real_name: "Dana", checked_at: new Date().toISOString() });
    // router_mark_handled is not in the fake: calling it would throw.
    const db = fakeRpc({ router_sender: known, router_store_message: { id: "r1", created: true } });
    expect(await ingestClientMessage({ ...msg, threadTs: "1759990000.000100" }, { rpc: db.rpc, lookupUser: vi.fn() })).toEqual({ action: "stored", id: "r1" });
    expect(await ingestClientMessage({ ...msg, text: "" }, { rpc: db.rpc, lookupUser: vi.fn() })).toEqual({ action: "ignored", reason: "empty" });
    expect(db.called("router_mark_handled")).toHaveLength(0);
    expect(db.called("router_store_message")).toHaveLength(1);
  });

  it("looks a new user up once; staff found that way are dropped too", async () => {
    const db = fakeRpc({ router_sender: sender(null), router_save_person: true, router_mark_handled: 0 });
    const lookupUser = vi.fn().mockResolvedValue({ email: "sameer@example.test", realName: "Sameer" });
    expect(await ingestClientMessage(msg, { rpc: db.rpc, lookupUser })).toEqual({ action: "ignored", reason: "staff" });
    expect(lookupUser).toHaveBeenCalledWith("U_DANA");
    expect(db.called("router_save_person")[0].args).toEqual({ p_user: "U_DANA", p_email: "sameer@example.test", p_real_name: "Sameer" });
  });

  it("when the lookup fails the sender is a client, recorded with no email", async () => {
    const db = fakeRpc({ router_sender: sender(null), router_save_person: false, router_store_message: { id: "r1", created: true } });
    const lookupUser = vi.fn().mockRejectedValue(new Error("timeout"));
    expect(await ingestClientMessage(msg, { rpc: db.rpc, lookupUser })).toEqual({ action: "stored", id: "r1" });
    expect(db.called("router_save_person")[0].args).toEqual({ p_user: "U_DANA", p_email: null, p_real_name: null });
    expect(db.called("router_store_message")[0].args).toEqual({
      p_channel: "C0GENERAL", p_ts: "1760000000.000100", p_user: "U_DANA", p_sender_name: null, p_text: "Please block Wednesday", p_thread_ts: null, p_mode: "live",
    });
  });

  it("a Slack retry of a stored message is a duplicate, not a second row", async () => {
    const known = sender({ is_staff: false, email: "dana@clinic.test", real_name: "Dana", checked_at: new Date().toISOString() });
    let stored = false;
    const db = fakeRpc({ router_sender: known, router_store_message: () => { const created = !stored; stored = true; return { id: "r1", created }; } });
    const deps = { rpc: db.rpc, lookupUser: vi.fn() };
    expect(await ingestClientMessage(msg, deps)).toEqual({ action: "stored", id: "r1" });
    // x-slack-retry-num: 1 delivers the same event again.
    expect(await ingestClientMessage(msg, deps)).toEqual({ action: "duplicate", id: "r1" });
    expect(deps.lookupUser).not.toHaveBeenCalled();
  });
});

describe("the classifier", () => {
  const input: ClassifyInput = {
    text: "Can you block Wednesday 21st October? Dr Patel is away.", clientName: "Pivotal Health and Wellness", timezone: "America/New_York",
    channelKind: "scheduling", sentAt: new Date("2026-10-07T18:32:00Z"),
  };
  const good = { is_request: true, owner: "tech", title: "Block Dr Patel's calendar on Wed 21 Oct", due_at: "2026-10-21T00:00:00-04:00", urgency: "normal", confidence: 0.93, tech_type: "other" };
  const reply = (json: unknown, over: Record<string, unknown> = {}) =>
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: typeof json === "string" ? json : JSON.stringify(json) }], ...over }), { status: 200 }));

  it("sends one Messages API request: model, prompt, the message with its date and timezone, and a JSON schema", async () => {
    const fetchMock = reply(good);
    await classifyMessage(input, { apiKey: "sk-test", fetch: fetchMock });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "x-api-key": "sk-test", "anthropic-version": "2023-06-01", "content-type": "application/json", "anthropic-beta": "server-side-fallback-2026-07-01" });
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      model: ROUTER_MODEL,
      max_tokens: 4096,
      system: ROUTER_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          "Clinic: Pivotal Health and Wellness",
          "Clinic timezone: America/New_York",
          "Channel: Scheduling",
          "Sent: Wednesday 7 October 2026 at 14:32 clinic time (2026-10-07T18:32:00.000Z)",
          "",
          "<message>",
          "Can you block Wednesday 21st October? Dr Patel is away.",
          "</message>",
        ].join("\n"),
      }],
      output_config: { effort: "low", format: { type: "json_schema", schema: CLASSIFICATION_JSON_SCHEMA } },
      fallbacks: "default",
    });
    expect(ROUTER_MODEL).toBe("claude-opus-5-5");
    // The owner guide and the urgency rule are in the prompt.
    for (const phrase of ["calendar blocks", "budget", "refunds", "angry", "Never include a patient's surname", "clinic's timezone"]) expect(ROUTER_SYSTEM_PROMPT).toContain(phrase);
    // Nothing the API rejects: no sampling parameters, no thinking budget, no prefill.
    expect(Object.keys(body)).not.toEqual(expect.arrayContaining(["temperature", "top_p", "thinking", "tool_choice"]));
  });

  it("leaves out the fallback for a model that does not take it", () => {
    const r = buildClassifyRequest(input, "claude-haiku-4-5");
    expect(r.headers).toEqual({});
    expect(r.body).not.toHaveProperty("fallbacks");
    expect(r.body.model).toBe("claude-haiku-4-5");
  });

  it("returns the validated answer, with the due time as a UTC instant", async () => {
    expect(await classifyMessage(input, { apiKey: "k", fetch: reply(good) })).toEqual({ ...good, due_at: "2026-10-21T04:00:00.000Z" });
  });

  it("tidies fields that depend on each other", async () => {
    const chat = await classifyMessage(input, { apiKey: "k", fetch: reply({ ...good, is_request: false, owner: "tech", title: "Thanks" }) });
    expect(chat).toMatchObject({ is_request: false, owner: null, tech_type: null, due_at: null });
    const ads = await classifyMessage(input, { apiKey: "k", fetch: reply({ ...good, owner: "ads", tech_type: "fix" }) });
    expect(ads.tech_type).toBeNull();
    const tech = await classifyMessage(input, { apiKey: "k", fetch: reply({ ...good, tech_type: null }) });
    expect(tech.tech_type).toBe("other");
  });

  it("rejects JSON that does not fit: wrong owner, confidence out of range, missing field, a date that is not one", async () => {
    for (const bad of [{ ...good, owner: "sales" }, { ...good, confidence: 1.4 }, { ...good, urgency: "high" }, { ...good, title: "" }, { ...good, due_at: "next Wednesday" }, { is_request: true }]) {
      await expect(classifyMessage(input, { apiKey: "k", fetch: reply(bad) })).rejects.toMatchObject({ name: "ClassifyError", kind: "invalid" });
    }
  });

  it("rejects an answer that is not JSON, a refusal and a cut-off answer", async () => {
    await expect(classifyMessage(input, { apiKey: "k", fetch: reply("Sure! Here is the JSON") })).rejects.toMatchObject({ kind: "invalid" });
    await expect(classifyMessage(input, { apiKey: "k", fetch: reply(good, { stop_reason: "refusal" }) })).rejects.toMatchObject({ kind: "refusal" });
    await expect(classifyMessage(input, { apiKey: "k", fetch: reply(good, { stop_reason: "max_tokens" }) })).rejects.toMatchObject({ kind: "invalid" });
  });

  it("an HTTP error or a network failure is a ClassifyError", async () => {
    const overloaded = vi.fn().mockResolvedValue(new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error" } }), { status: 529 }));
    await expect(classifyMessage(input, { apiKey: "k", fetch: overloaded })).rejects.toThrow(/Anthropic HTTP 529/);
    await expect(classifyMessage(input, { apiKey: "k", fetch: vi.fn().mockRejectedValue(new Error("socket hang up")) })).rejects.toBeInstanceOf(ClassifyError);
  });

  it("a failed classification is recorded for retry and nothing is routed", async () => {
    const db = fakeRpc({
      router_claim: { id: "r1", text: input.text, channel_kind: "scheduling", received_at: "2026-10-07T18:32:00Z", mode: "live", client_name: "Pivotal", timezone: "America/New_York" },
      router_classify_failed: "new",
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("overloaded", { status: 529 }));
    const reply = vi.fn();
    const r = await processRequest("r1", { rpc: db.rpc, classify: (i) => classifyMessage(i, { apiKey: "k", fetch: fetchMock }), reply });
    expect(r).toMatchObject({ outcome: "failed", status: "new" });
    expect(db.called("router_classify_failed")[0].args).toEqual({ p_id: "r1", p_error: "Anthropic HTTP 529: overloaded" });
    expect(db.called("route_client_request")).toHaveLength(0);
    expect(reply).not.toHaveBeenCalled();
  });

  it("a valid classification is handed to route_client_request as it is", async () => {
    const db = fakeRpc({
      router_claim: { id: "r1", text: input.text, channel_kind: "scheduling", received_at: "2026-10-07T18:32:00Z", mode: "live", client_name: "Pivotal", timezone: "America/New_York" },
      route_client_request: { id: "r1", status: "triage", mode: "live", owner: "tech", routed_table: null, routed_id: null, merged_into: null, triage_reason: "Low confidence (60%)", urgent_dm: false },
    });
    const r = await processRequest("r1", { rpc: db.rpc, classify: (i) => classifyMessage(i, { apiKey: "k", fetch: reply({ ...good, confidence: 0.6 }) }), reply: vi.fn() });
    expect(r.outcome).toBe("routed");
    expect(db.called("route_client_request")[0].args).toEqual({
      p_id: "r1", p_is_request: true, p_owner: "tech", p_title: "Block Dr Patel's calendar on Wed 21 Oct", p_due_at: "2026-10-21T04:00:00.000Z",
      p_urgency: "normal", p_confidence: 0.6, p_tech_type: "other",
    });
    // Triage: no reply is looked for, no DM.
    expect(db.called("router_replies_due")).toHaveLength(0);
  });

  it("an urgent request for Ryan triggers the owner's DM delivery at once", async () => {
    const db = fakeRpc({
      router_claim: { id: "r1", text: "I want a refund", channel_kind: "general", received_at: "2026-10-07T18:32:00Z", mode: "live", client_name: "Pivotal", timezone: "America/New_York" },
      route_client_request: { id: "r1", status: "routed", mode: "live", owner: "ryan", routed_table: "exceptions", routed_id: "e1", merged_into: null, triage_reason: null, urgent_dm: true },
      router_replies_due: { enabled: false, items: [] },
    });
    const deliverOwnerDms = vi.fn().mockResolvedValue(undefined);
    await processRequest("r1", { rpc: db.rpc, classify: async () => ({ ...good, owner: "ryan", urgency: "urgent", tech_type: null, due_at: null } as never), reply: vi.fn(), deliverOwnerDms });
    expect(deliverOwnerDms).toHaveBeenCalledTimes(1);
  });

  it("a message someone else is already classifying is skipped", async () => {
    const db = fakeRpc({ router_claim: null });
    const classify = vi.fn();
    expect(await processRequest("r1", { rpc: db.rpc, classify, reply: vi.fn() })).toEqual({ outcome: "skipped" });
    expect(classify).not.toHaveBeenCalled();
  });
});

describe("thread replies to the client workspace", () => {
  const env = { SLACK_BOT_TOKEN: "xoxb-team", SLACK_CLIENT_BOT_TOKEN: "xoxb-client" };
  const due = { id: "r1", kind: "logged", channel: "C0GENERAL", thread_ts: "1760000000.000100", owner_name: "Sameer", title: "Block Dr Patel's calendar on Wed 21 Oct", due_at: "2026-10-21T04:00:00.000Z", timezone: "America/New_York" };
  beforeEach(() => Object.assign(process.env, env));
  afterEach(() => vi.unstubAllGlobals());

  it("off: no Slack call at all, and nothing is claimed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const db = fakeRpc({ router_replies_due: { enabled: false, items: [] } });
    expect(await sendDueReplies({ rpc: db.rpc, reply: replyInClientThread })).toEqual({ enabled: false, sent: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.calls.map((c) => c.fn)).toEqual(["router_replies_due"]);
    // Even handed a reply directly, the gate inside refuses.
    expect(await replyInClientThread({ channel: "C1", threadTs: "1.2", text: "Logged ✓ — Sameer will fix it", repliesEnabled: false })).toEqual({ ok: false, error: "client_thread_replies_off" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("on: exactly one reply, inside the message's thread, with the client install's token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ ok: true, ts: "1760000050.000300" }) });
    vi.stubGlobal("fetch", fetchMock);
    const db = fakeRpc({ router_replies_due: { enabled: true, items: [due] }, router_reply_claim: true, router_reply_finish: null });
    expect(await sendDueReplies({ rpc: db.rpc, reply: replyInClientThread })).toEqual({ enabled: true, sent: 1, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(init.headers.Authorization).toBe("Bearer xoxb-client");
    expect(JSON.parse(init.body)).toEqual({
      channel: "C0GENERAL", thread_ts: "1760000000.000100", unfurl_links: false,
      text: "Logged ✓ — Sameer will block Dr Patel's calendar on Wed 21 Oct by Wed 21 Oct",
    });
    expect(db.called("router_reply_finish")[0].args).toEqual({ p_id: "r1", p_kind: "logged", p_ts: "1760000050.000300" });
  });

  it("a reply another run already took is not sent; a failed send is released", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ ok: false, error: "not_in_channel" }) });
    vi.stubGlobal("fetch", fetchMock);
    const taken = fakeRpc({ router_replies_due: { enabled: true, items: [due] }, router_reply_claim: false });
    expect(await sendDueReplies({ rpc: taken.rpc, reply: replyInClientThread })).toEqual({ enabled: true, sent: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    const failing = fakeRpc({ router_replies_due: { enabled: true, items: [{ ...due, kind: "done" }] }, router_reply_claim: true, router_reply_finish: null });
    expect(await sendDueReplies({ rpc: failing.rpc, reply: replyInClientThread })).toEqual({ enabled: true, sent: 0, failed: 1 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).text).toBe("Done ✓");
    expect(failing.called("router_reply_finish")[0].args).toEqual({ p_id: "r1", p_kind: "done", p_ts: null });
  });

  it("refuses any text but the router's two", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await replyInClientThread({ channel: "C1", threadTs: "1.2", text: "Your renewal is due" as never, repliesEnabled: true });
    expect(r).toEqual({ ok: false, error: "text_not_allowed" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isClientThreadText("Done ✓")).toBe(true);
    expect(isClientThreadText("Logged ✓ — Sameer will fix the form")).toBe(true);
    expect(isClientThreadText("Done ✓ and by the way")).toBe(false);
  });

  it("words the Logged reply with and without a due time", () => {
    const base = { ownerName: "Sameer", title: "Block Dr Patel's calendar on Wed 21 Oct.", timezone: "America/New_York" };
    expect(loggedReplyText({ ...base, dueAt: null })).toBe("Logged ✓ — Sameer will block Dr Patel's calendar on Wed 21 Oct");
    // Midnight clinic time = a date with no time.
    expect(loggedReplyText({ ...base, dueAt: "2026-10-21T04:00:00.000Z" })).toBe("Logged ✓ — Sameer will block Dr Patel's calendar on Wed 21 Oct by Wed 21 Oct");
    // A fix's SLA time, in the clinic's own timezone.
    expect(loggedReplyText({ ownerName: "Sameer", title: "Fix the booking form", dueAt: "2026-10-07T19:02:00.000Z", timezone: "America/New_York" }))
      .toBe("Logged ✓ — Sameer will fix the booking form by Wed 7 Oct, 3:02 PM EDT");
    expect(formatDue("2026-10-07T19:02:00.000Z", "America/Los_Angeles")).toBe("Wed 7 Oct, 12:02 PM PDT");
    expect(formatDue("2026-12-01T05:00:00.000Z", "America/New_York")).toBe("Tue 1 Dec");
    expect(formatDue("2026-10-07T19:02:00.000Z", "Not/AZone")).toBe("Wed 7 Oct, 3:02 PM EDT");
  });
});

describe("reading the client workspace", () => {
  const ok = (json: unknown) => ({ json: async () => json });

  it("users.info gives the email and name, with the client token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ ok: true, user: { real_name: "Dana Front Desk", profile: { email: "dana@clinic.test" } } }));
    expect(await fetchSlackUser("U_DANA", { token: "xoxb-client", fetch: fetchMock })).toEqual({ email: "dana@clinic.test", realName: "Dana Front Desk" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://slack.com/api/users.info?user=U_DANA");
    expect(init.headers.Authorization).toBe("Bearer xoxb-client");
  });

  it("history is read page by page, and missing_scope is reported as such", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ ok: true, messages: [{ ts: "3.0" }, { ts: "2.0" }], has_more: true, response_metadata: { next_cursor: "abc" } }))
      .mockResolvedValueOnce(ok({ ok: true, messages: [{ ts: "1.0" }], has_more: false }));
    expect(await fetchChannelHistory("C1", "0.5", { token: "t", fetch: fetchMock })).toHaveLength(3);
    expect(fetchMock.mock.calls[0][0]).toBe("https://slack.com/api/conversations.history?channel=C1&oldest=0.5&limit=200");
    expect(fetchMock.mock.calls[1][0]).toContain("cursor=abc");
    const denied = vi.fn().mockResolvedValue(ok({ ok: false, error: "missing_scope" }));
    await expect(fetchChannelHistory("C1", "0", { token: "t", fetch: denied })).rejects.toMatchObject({ name: "SlackApiError", code: "missing_scope", method: "conversations.history" });
    expect(new SlackApiError("users.info", "missing_scope").message).toBe("Slack users.info: missing_scope");
  });
});

describe("Triage handled in Slack: the sweep", () => {
  const ok = (json: unknown) => ({ json: async () => json });
  const m = (user: string, ts: string, over: Record<string, unknown> = {}) => ({ type: "message", user, text: "hello", ts, ...over });

  it("the webhook reads a post with no text (a file on its own); bots and edits are still ignored", () => {
    expect(postFromEventBody(event({ text: "", subtype: "file_share", thread_ts: "1759999000.000100" }))).toEqual({
      message: { channel: "C0GENERAL", ts: "1760000000.000100", user: "U_DANA", text: "", threadTs: "1759999000.000100" },
    });
    expect(messageFromEventBody(event({ text: "" }))).toEqual({ ignored: "empty" });
    expect(postFromEventBody(event({ bot_id: "B1" }))).toEqual({ ignored: "bot" });
    expect(postFromEventBody(event({ subtype: "message_changed" }))).toEqual({ ignored: "subtype" });
    expect(postFromEventBody({ type: "url_verification" })).toEqual({ ignored: "not_a_message" });
  });

  it("thread replies are read page by page with GET only", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ ok: true, messages: [{ ts: "1.0" }, { ts: "2.0" }], has_more: true, response_metadata: { next_cursor: "abc" } }))
      .mockResolvedValueOnce(ok({ ok: true, messages: [{ ts: "3.0" }], has_more: false }));
    expect(await fetchThreadReplies("C1", "1.0", { token: "xoxb-client", fetch: fetchMock })).toHaveLength(3);
    expect(fetchMock.mock.calls[0][0]).toBe("https://slack.com/api/conversations.replies?channel=C1&ts=1.0&limit=200");
    expect(fetchMock.mock.calls[1][0]).toContain("cursor=abc");
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.method).toBeUndefined();
      expect(init.body).toBeUndefined();
      expect(init.headers.Authorization).toBe("Bearer xoxb-client");
    }
    const gone = vi.fn().mockResolvedValue(ok({ ok: false, error: "thread_not_found" }));
    await expect(fetchThreadReplies("C1", "1.0", { token: "t", fetch: gone })).rejects.toMatchObject({ name: "SlackApiError", code: "thread_not_found", method: "conversations.replies" });
  });

  it("reads the threads open rows are in, and a top-level row's thread only when it has replies (or was not in the history read)", () => {
    const history = [m("U_DANA", "20.0"), m("U_DANA", "30.0", { reply_count: 2, thread_ts: "30.0" })];
    expect(threadsToRead({ roots: ["10.0", "20.0", "30.0"], threads: ["5.0"] }, history)).toEqual(["5.0", "10.0", "30.0"]);
    expect(threadsToRead({ roots: null, threads: [] }, history)).toEqual([]);
  });

  it("puts every person's message in time order once; ts is compared as a number", () => {
    const posts = postsInOrder([
      m("U_A", "1000.000200"), m("U_B", "999.000100"), m("U_A", "1000.000200", { subtype: "thread_broadcast", thread_ts: "999.000100" }),
      m("U_C", "998.0", { bot_id: "B1" }), { type: "message", subtype: "channel_join", user: "U_D", ts: "997.0" },
    ], "C1");
    expect(posts.map((p) => p.ts)).toEqual(["999.000100", "1000.000200"]);
    expect(posts.every((p) => p.channel === "C1")).toBe(true);
  });

  const openChannel = { channel: "C0GENERAL", client_name: "Pivotal Health", open: 2, oldest_ts: "1760000000.000100", roots: ["1760000000.000100", "1760000050.000100"], threads: [] };
  const person = (isStaff: boolean, name: string) => ({ client_id: "c1", channel_kind: "general", person: { is_staff: isStaff, email: "x@y.test", real_name: name, checked_at: new Date().toISOString() } });

  it("calls router_mark_handled for staff messages only, oldest first, and stops once the channel has no open rows left", async () => {
    const db = fakeRpc({
      router_open_triage: [openChannel],
      router_sender: (a: Record<string, unknown>) => person(a.p_user === "U_SAMEER", a.p_user === "U_SAMEER" ? "Sameer" : "Dana"),
      router_mark_handled: (a: Record<string, unknown>) => (a.p_ts === "1760000060.000100" ? 2 : 0),
    });
    const history = vi.fn().mockResolvedValue([
      m("U_SAMEER", "1760000090.000100"), m("U_SAMEER", "1760000060.000100"), m("U_DANA", "1760000050.000100"), m("U_DANA", "1760000070.000100"),
    ]);
    const replies = vi.fn().mockResolvedValue([m("U_DANA", "1760000000.000100"), m("U_DANA", "1760000010.000100", { thread_ts: "1760000000.000100" })]);
    const r = await sweepHandled({ rpc: db.rpc, history, replies, lookupUser: vi.fn() });
    expect(history).toHaveBeenCalledWith("C0GENERAL", "1760000000.000100");
    // The oldest row is not in the history read (it starts after it), so its thread is read; the other root has no replies.
    expect(replies.mock.calls).toEqual([["C0GENERAL", "1760000000.000100"]]);
    expect(db.called("router_mark_handled").map((c) => c.args)).toEqual([{ p_channel: "C0GENERAL", p_ts: "1760000060.000100", p_thread_ts: null, p_by: "Sameer" }]);
    // One staff check per person, however many messages.
    expect(db.called("router_sender")).toHaveLength(2);
    expect(r).toMatchObject({ channels: 1, read: 6, handled: 2, byClinic: [{ clinic: "Pivotal Health", handled: 2 }], skippedChannels: [] });
  });

  it("when only clients have written, nothing is handled", async () => {
    // router_mark_handled is not in the fake: calling it would throw.
    const db = fakeRpc({ router_open_triage: [openChannel], router_sender: person(false, "Dana") });
    const r = await sweepHandled({ rpc: db.rpc, history: async () => [m("U_DANA", "1760000070.000100"), m("U_ERIN", "1760000080.000100")], replies: async () => [], lookupUser: vi.fn() });
    expect(r).toMatchObject({ handled: 0, byClinic: [{ clinic: "Pivotal Health", handled: 0 }] });
  });

  it("nothing in Triage = Slack is not read at all; a channel Slack refuses is skipped, a bad install stops the run", async () => {
    const history = vi.fn();
    expect(await sweepHandled({ rpc: fakeRpc({ router_open_triage: [] }).rpc, history, replies: vi.fn(), lookupUser: vi.fn() })).toMatchObject({ channels: 0, handled: 0 });
    expect(history).not.toHaveBeenCalled();
    const db = fakeRpc({ router_open_triage: [openChannel] });
    const refused = await sweepHandled({ rpc: db.rpc, history: async () => { throw new SlackApiError("conversations.history", "not_in_channel"); }, replies: vi.fn(), lookupUser: vi.fn() });
    expect(refused.skippedChannels).toEqual([{ channel: "C0GENERAL", clinic: "Pivotal Health", error: "not_in_channel" }]);
    await expect(sweepHandled({ rpc: db.rpc, history: async () => { throw new SlackApiError("conversations.history", "missing_scope"); }, replies: vi.fn(), lookupUser: vi.fn() }))
      .rejects.toMatchObject({ code: "missing_scope" });
  });
});
