import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import type { Rpc } from "@/lib/jobs/rpc";
import {
  CLASSIFICATION_JSON_SCHEMA, ClassifyError, ROUTER_MODEL, ROUTER_SYSTEM_PROMPT, buildClassifyRequest, classifyMessage, type ClassifyInput,
} from "@/lib/router/classify";
import { messageFromEventBody, permalink, toClientMessage, tsToDate } from "@/lib/router/events";
import { ingestClientMessage } from "@/lib/router/ingest";
import { processRequest, sendDueReplies } from "@/lib/router/process";
import { formatDue, isClientThreadText, loggedReplyText } from "@/lib/router/replies";
import { SlackApiError, fetchChannelHistory, fetchSlackUser } from "@/lib/router/slack";
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
    const db = fakeRpc({ router_sender: sender({ is_staff: true, email: "sameer@genexascaling.com", real_name: "Sameer", checked_at: new Date().toISOString() }) });
    const lookupUser = vi.fn();
    expect(await ingestClientMessage(msg, { rpc: db.rpc, lookupUser })).toEqual({ action: "ignored", reason: "staff" });
    expect(lookupUser).not.toHaveBeenCalled();
    expect(db.called("router_store_message")).toHaveLength(0);
  });

  it("looks a new user up once; staff found that way are dropped too", async () => {
    const db = fakeRpc({ router_sender: sender(null), router_save_person: true });
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
