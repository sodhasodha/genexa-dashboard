import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { AUTH, asUser, freshDb, seedStaff, type TestPeople } from "./db";
import { pgliteRpc } from "./rpc";
import type { Rpc } from "@/lib/jobs/rpc";
import type { Classification } from "@/lib/router/classify";
import { ingestClientMessage } from "@/lib/router/ingest";
import { processPending, processRequest, sendDueReplies, type RouteResult } from "@/lib/router/process";
import { runBackfill } from "@/lib/router/backfill";
import { sweepHandled } from "@/lib/router/handled";
import { fetchChannelHistory, fetchSlackUser, fetchThreadReplies } from "@/lib/router/slack";

// The request router against the in-process Postgres. Slack and the model are fakes.
let db: PGlite;
let rpc: Rpc;
let people: TestPeople;
let clinic: string;

const GENERAL = "C0GENERAL";
const SCHEDULING = "C0SCHED";
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const count = async (table: string, where = "true") => Number((await one<{ n: string }>(`select count(*) as n from ${table} where ${where}`)).n);
/** A Slack ts `daysAgo` days back (plus `n` seconds to keep messages apart). */
const tsAgo = (daysAgo: number, n = 0) => `${Math.floor(Date.now() / 1000) - Math.round(daysAgo * 86_400) + n}.000100`;

type Stored = { id: string; created: boolean; status: string };
const store = (ts: string, text: string, opts: { channel?: string; mode?: "live" | "backfill"; user?: string } = {}) =>
  rpc<Stored | null>("router_store_message", {
    p_channel: opts.channel ?? GENERAL, p_ts: ts, p_user: opts.user ?? "U_CLIENT", p_sender_name: "Dana Front Desk", p_text: text, p_thread_ts: null, p_mode: opts.mode ?? "live",
  });

const answer = (over: Partial<Classification> = {}): Classification => ({
  is_request: true, owner: "tech", title: "Block Wednesday 21 October on the calendar", due_at: null, urgency: "normal", confidence: 0.95, tech_type: "other", ...over,
});
const route = (id: string, over: Partial<Classification> = {}) => {
  const c = answer(over);
  return rpc<RouteResult>("route_client_request", {
    p_id: id, p_is_request: c.is_request, p_owner: c.owner, p_title: c.title, p_due_at: c.due_at, p_urgency: c.urgency, p_confidence: c.confidence, p_tech_type: c.tech_type,
  });
};
/** Store a live message and route it with the given classification. */
const ask = async (ts: string, text: string, over: Partial<Classification> = {}, opts: Parameters<typeof store>[2] = {}) => {
  const s = (await store(ts, text, opts))!;
  return { id: s.id, result: await route(s.id, over) };
};
const request = (id: string) =>
  one<{
    status: string; routed_table: string | null; routed_id: string | null; merged_into: string | null; triage_reason: string | null; permalink: string;
    received_at: Date; reply_logged_ts: string | null; reply_done_ts: string | null; owner: string | null; assigned_owner: string | null; attempts: number; classify_error: string | null;
  }>(`select * from client_requests where id = $1`, [id]);
const repliesOn = (on: boolean) => db.query(`update app_settings set value = $1::jsonb where key = 'client_workspace_thread_replies'`, [String(on)]);

beforeAll(async () => {
  db = await freshDb();
  rpc = pgliteRpc(db);
});

beforeEach(async () => {
  await db.exec(`
    truncate staff, clients, client_requests, slack_people, tasks, deleted_tasks, tech_jobs, exceptions, touches, notifications, audit_log cascade;
    update app_settings set value = 'false'::jsonb where key = 'client_workspace_thread_replies';
    select set_config('app.actor', '', false);`);
  people = await seedStaff(db);
  clinic = (await one<{ id: string }>(
    `insert into clients (name, stage, pod, slack_general_id, slack_scheduling_id) values ('Pivotal Health', 'live', 'pod_1', $1, $2) returning id`, [GENERAL, SCHEDULING])).id;
});

describe("storing a client message", () => {
  it("stores once per channel + ts; a Slack retry adds nothing", async () => {
    const ts = tsAgo(0);
    const first = await store(ts, "Can you block Wednesday 21st October?");
    const again = await store(ts, "Can you block Wednesday 21st October?");
    expect(first).toMatchObject({ created: true, status: "new" });
    expect(again).toEqual({ id: first!.id, created: false, status: "new" });
    expect(await count("client_requests")).toBe(1);
    expect(await count("touches")).toBe(1);
    const r = await one<{ channel_kind: string; permalink: string; mode: string; client_id: string }>(`select * from client_requests`);
    expect(r).toMatchObject({ channel_kind: "general", mode: "live", client_id: clinic, permalink: `https://slack.com/archives/${GENERAL}/p${ts.replace(".", "")}` });
  });

  it("a live message moves the clinic's last reply and logs a touch, without counting as us contacting them", async () => {
    const ts = tsAgo(0);
    await store(ts, "Thanks, all good here", { channel: SCHEDULING });
    const c = await one<{ last_reply_client: Date; last_contact_us: Date | null }>(`select last_reply_client, last_contact_us from clients where id = $1`, [clinic]);
    expect(Math.abs(c.last_reply_client.getTime() - Number(ts) * 1000)).toBeLessThan(5);
    expect(c.last_contact_us).toBeNull();
    const t = await one<{ kind: string; by_id: string | null; note: string; external_ref: string; at: Date }>(`select * from touches`);
    expect(t).toMatchObject({ kind: "slack", by_id: null, external_ref: `slack:${SCHEDULING}:${ts}` });
    expect(t.note).toBe(`Client message in #scheduling https://slack.com/archives/${SCHEDULING}/p${ts.replace(".", "")}`);
    // An older message arriving late does not move the date back.
    await store(tsAgo(3), "older message");
    const after = await one<{ last_reply_client: Date }>(`select last_reply_client from clients where id = $1`, [clinic]);
    expect(after.last_reply_client.getTime()).toBe(c.last_reply_client.getTime());
  });

  it("a touch we log ourselves still moves last contact (us)", async () => {
    await db.query(`insert into touches (client_id, kind, by_id, note) values ($1, 'call', $2, 'Weekly call')`, [clinic, people.ryan]);
    expect((await one<{ last_contact_us: Date | null }>(`select last_contact_us from clients where id = $1`, [clinic])).last_contact_us).not.toBeNull();
  });

  it("a backfilled message changes nothing on the clinic", async () => {
    const s = await store(tsAgo(2), "Please pause the ads", { mode: "backfill" });
    expect(s).toMatchObject({ created: true });
    expect(await count("touches")).toBe(0);
    expect((await one<{ last_reply_client: Date | null }>(`select last_reply_client from clients where id = $1`, [clinic])).last_reply_client).toBeNull();
  });

  it("refuses a channel that is not a client's General or Scheduling channel", async () => {
    expect(await store(tsAgo(0), "hello", { channel: "C0RANDOM" })).toBeNull();
    expect(await rpc("router_sender", { p_channel: "C0RANDOM", p_user: "U1" })).toBeNull();
    expect(await count("client_requests")).toBe(0);
  });

  it("knows staff by a staff email or a Genexa address; a failed lookup is a client with no email", async () => {
    expect(await rpc("router_save_person", { p_user: "U_SAMEER", p_email: "Sameer@Example.test", p_real_name: "Sameer" })).toBe(true);
    expect(await rpc("router_save_person", { p_user: "U_VA", p_email: "someone@genexascaling.com", p_real_name: "New VA" })).toBe(true);
    expect(await rpc("router_save_person", { p_user: "U_DANA", p_email: "dana@pivotalhealth.test", p_real_name: "Dana" })).toBe(false);
    expect(await rpc("router_save_person", { p_user: "U_UNKNOWN", p_email: null, p_real_name: null })).toBe(false);
    const unknown = await one<{ email: string | null; is_staff: boolean }>(`select email, is_staff from slack_people where slack_user_id = 'U_UNKNOWN'`);
    expect(unknown).toEqual({ email: null, is_staff: false });
    const sender = await rpc<{ client_id: string; channel_kind: string; person: { is_staff: boolean } }>("router_sender", { p_channel: SCHEDULING, p_user: "U_SAMEER" });
    expect(sender).toMatchObject({ client_id: clinic, channel_kind: "scheduling", person: { is_staff: true } });
  });
});

describe("route_client_request", () => {
  it("tech fix -> a tech job for the tech person, due by the fix SLA", async () => {
    const ts = tsAgo(0);
    const { id, result } = await ask(ts, "The booking form is not sending confirmations", { title: "Fix booking form confirmations", tech_type: "fix", due_at: "2026-12-01T05:00:00.000Z" });
    expect(result).toMatchObject({ status: "routed", routed_table: "tech_jobs", owner: "tech", urgent_dm: false });
    const r = await request(id);
    const job = await one<{ type: string; owner_id: string; client_id: string; title: string; notes: string; requested_at: Date; due_at: Date; source_url: string; expected_due: Date }>(
      `select j.*, tech_job_due_at('fix', j.requested_at) as expected_due from tech_jobs j where id = $1`, [r.routed_id]);
    expect(job).toMatchObject({ type: "fix", owner_id: people.sameer, client_id: clinic, title: "Fix booking form confirmations", source_url: r.permalink });
    expect(job.requested_at.getTime()).toBe(r.received_at.getTime());
    // The SLA decides, not the date in the message.
    expect(job.due_at.getTime()).toBe(job.expected_due.getTime());
    expect(job.notes).toBe(`The booking form is not sending confirmations\n${r.permalink}`);
    expect(await count("audit_log", `table_name = 'tech_jobs' and actor = 'request-router'`)).toBe(1);
  });

  it("tech other -> a tech job due when the client said", async () => {
    const { id } = await ask(tsAgo(0), "Please block Wednesday 21st October, Dr P is away", { due_at: "2026-10-21T04:00:00.000Z" });
    const job = await one<{ type: string; due_at: Date }>(`select type, due_at from tech_jobs where id = $1`, [(await request(id)).routed_id]);
    expect(job.type).toBe("other");
    expect(job.due_at.toISOString()).toBe("2026-10-21T04:00:00.000Z");
  });

  it("ads -> a task for the media buyer, inside their remit", async () => {
    const { id, result } = await ask(tsAgo(0), "Can we drop the radius to 15 miles from Friday?", { owner: "ads", title: "Cut targeting radius to 15 miles", tech_type: null, due_at: "2026-10-09T04:00:00.000Z" });
    expect(result).toMatchObject({ status: "routed", routed_table: "tasks", owner: "ads" });
    const r = await request(id);
    const task = await one<{ owner_id: string; category: string; source: string; client_id: string; due: string; notes: string; source_url: string; priority: string }>(
      `select owner_id, category, source, client_id, due::text as due, notes, source_url, priority from tasks where id = $1`, [r.routed_id]);
    // 04:00 UTC on the 9th is midnight on the 9th in New York.
    expect(task).toEqual({
      owner_id: people.aditya, category: "ads", source: "slack", client_id: clinic, due: "2026-10-09", priority: "medium",
      notes: `Can we drop the radius to 15 miles from Friday?\n${r.permalink}`, source_url: r.permalink,
    });
    expect(await count("tech_jobs")).toBe(0);
  });

  it("uses the clinic's own timezone for the task's due date", async () => {
    await db.query(`update clients set timezone = 'America/Los_Angeles' where id = $1`, [clinic]);
    const { id } = await ask(tsAgo(0), "Pause ads from Friday", { owner: "ads", title: "Pause ads", tech_type: null, due_at: "2026-10-09T04:00:00.000Z" });
    const task = await one<{ due: string }>(`select due::text as due from tasks where id = $1`, [(await request(id)).routed_id]);
    expect(task.due).toBe("2026-10-08");
  });

  it("ryan -> an amber exception for the owner, with its DM queued like any other exception", async () => {
    const { id, result } = await ask(tsAgo(0), "Could you resend the September invoice?", { owner: "ryan", title: "Resend the September invoice", tech_type: null });
    expect(result).toMatchObject({ status: "routed", routed_table: "exceptions", urgent_dm: false });
    const r = await request(id);
    const ex = await one<{ type: string; owner_id: string; client_id: string; severity: string; reason: string; record_table: string; record_id: string; status: string; source_url: string; notes: string }>(
      `select * from exceptions where id = $1`, [r.routed_id]);
    expect(ex).toMatchObject({
      type: "client_request", owner_id: people.ryan, client_id: clinic, severity: "amber", reason: "Pivotal Health: Resend the September invoice",
      record_table: "client_requests", record_id: id, status: "open", source_url: r.permalink,
    });
    expect(ex.notes).toContain("Could you resend the September invoice?");
    const n = await one<{ rule_key: string; staff_id: string; channel: string | null; payload: unknown; sent_at: Date | null }>(`select * from notifications where record_id = $1`, [r.routed_id]);
    expect(n).toMatchObject({ rule_key: "exception_opened", staff_id: people.ryan, channel: null, payload: null, sent_at: null });
    // Not a rule the engine knows, so the engine never resolves it on its own.
    expect(await count("exception_rules", `type = 'client_request'`)).toBe(0);
    await db.query(`select * from run_exceptions_engine()`);
    expect((await one<{ status: string }>(`select status from exceptions where id = $1`, [r.routed_id])).status).toBe("open");
  });

  it("urgent: a refund request is a red exception and its DM is marked to go at once", async () => {
    const { id, result } = await ask(tsAgo(0), "This is unacceptable. I want a refund.", { owner: "ryan", title: "Handle refund demand", urgency: "urgent", tech_type: null });
    expect(result).toMatchObject({ status: "routed", routed_table: "exceptions", urgent_dm: true });
    const r = await request(id);
    expect((await one<{ severity: string }>(`select severity from exceptions where id = $1`, [r.routed_id])).severity).toBe("red");
    const n = await one<{ payload: Record<string, unknown> }>(`select payload from notifications where record_id = $1`, [r.routed_id]);
    expect(n.payload).toEqual({ reason: "Pivotal Health: Handle refund demand", severity: "red", type: "client_request", _urgent: true });
    // Ready for delivery now, whatever the owner's shift.
    const ready = await rpc<{ items: { record_id: string; payload: { reason: string } }[] }>("reminders_deliverable", { p_now: new Date().toISOString(), p_rule: "exception_opened" });
    expect(ready.items.map((i) => i.record_id)).toContain(r.routed_id);
  });

  it("urgent ads request -> a high priority task", async () => {
    const { id } = await ask(tsAgo(0), "Stop the ads NOW, the offer is wrong", { owner: "ads", title: "Pause all ads", urgency: "urgent", tech_type: null });
    expect((await one<{ priority: string }>(`select priority from tasks where id = $1`, [(await request(id)).routed_id])).priority).toBe("high");
  });

  it("confidence under 0.8 goes to Triage and creates nothing", async () => {
    const { id, result } = await ask(tsAgo(0), "Can you sort that thing from last week?", { confidence: 0.79 });
    expect(result).toMatchObject({ status: "triage", routed_table: null, triage_reason: "Low confidence (79%)" });
    const exact = await ask(tsAgo(0, 1), "Please add Dr Lee to the calendar", { title: "Add Dr Lee to the calendar", confidence: 0.8 });
    expect(exact.result.status).toBe("routed");
    expect(await count("tech_jobs")).toBe(1);
    expect((await request(id)).routed_id).toBeNull();
    // A shaky "not a request" is checked by a person too.
    expect((await ask(tsAgo(0, 2), "hmm ok", { is_request: false, owner: null, tech_type: null, confidence: 0.5 })).result.status).toBe("triage");
  });

  it("a request with no owner goes to Triage; a non-request is stored and creates nothing", async () => {
    const noOwner = await ask(tsAgo(0), "Can someone help with our website SEO?", { owner: null, tech_type: null });
    expect(noOwner.result).toMatchObject({ status: "triage", triage_reason: "A request with no clear owner" });
    const chat = await ask(tsAgo(0, 1), "Thanks so much!", { is_request: false, owner: "tech", title: "Thanks", tech_type: "other", confidence: 0.99 });
    expect(chat.result).toMatchObject({ status: "not_request", routed_table: null, owner: null });
    expect(await count("tech_jobs") + await count("tasks") + await count("exceptions")).toBe(0);
    expect(await count("client_requests")).toBe(2);
  });

  it("routing the same message twice creates one item", async () => {
    const { id, result } = await ask(tsAgo(0), "Please block Wednesday 21st October");
    const again = await route(id, { owner: "ads", title: "Something else" });
    expect(again).toEqual(result);
    expect(await count("tech_jobs")).toBe(1);
    expect(await count("tasks")).toBe(0);
  });

  it("the same ask from the same clinic within 7 days is added to the open item", async () => {
    const first = await ask(tsAgo(3), "Please block Wednesday 21st October", { title: "Block Wednesday 21 October on the calendar" });
    const second = await ask(tsAgo(0), "Reminder: block Wed 21 Oct please!", { title: "Block Wed 21 October on calendar" });
    expect(second.result).toMatchObject({ status: "merged", merged_into: first.id, routed_table: "tech_jobs", routed_id: first.result.routed_id });
    expect(await count("tech_jobs")).toBe(1);
    const r2 = await request(second.id);
    const job = await one<{ notes: string }>(`select notes from tech_jobs where id = $1`, [first.result.routed_id]);
    const date = (await one<{ d: string }>(`select to_char($1::timestamptz at time zone 'America/New_York', 'Dy FMDD Mon') as d`, [r2.received_at])).d;
    expect(job.notes.split("\n").at(-1)).toBe(`Also asked ${date}: ${r2.permalink}`);
    expect(job.notes).toContain("Please block Wednesday 21st October");
  });

  it("does not merge across owners, across clinics, or into a finished item", async () => {
    const first = await ask(tsAgo(2), "Please block Wednesday 21st October");
    // Same words, but for the media buyer.
    expect((await ask(tsAgo(1), "block wed 21", { owner: "ads", tech_type: null })).result.status).toBe("routed");
    // Another clinic.
    await db.query(`insert into clients (name, stage, slack_general_id) values ('Multivita IV', 'live', 'C0OTHER')`);
    expect((await ask(tsAgo(1, 5), "Please block Wednesday 21st October", {}, { channel: "C0OTHER" })).result.status).toBe("routed");
    // The first job is done: asking again is new work.
    await db.query(`update tech_jobs set status = 'done' where id = $1`, [first.result.routed_id]);
    expect((await ask(tsAgo(0), "Please block Wednesday 21st October again")).result.status).toBe("routed");
    expect(await count("tech_jobs")).toBe(3);
    expect(await count("tasks")).toBe(1);
  });

  it("an 8-day-old twin does not merge", async () => {
    await ask(tsAgo(8), "Please block Wednesday 21st October");
    const second = await ask(tsAgo(0), "Please block Wednesday 21st October");
    expect(second.result).toMatchObject({ status: "routed", merged_into: null });
    expect(await count("tech_jobs")).toBe(2);
  });

  it("a repeat of a request for Ryan is added to the open exception", async () => {
    const first = await ask(tsAgo(1), "Please resend the September invoice", { owner: "ryan", title: "Resend the September invoice", tech_type: null });
    const second = await ask(tsAgo(0), "Still waiting on that September invoice", { owner: "ryan", title: "Resend September invoice", tech_type: null });
    expect(second.result.status).toBe("merged");
    expect(await count("exceptions")).toBe(1);
    expect((await one<{ notes: string }>(`select notes from exceptions where id = $1`, [first.result.routed_id])).notes).toContain("Also asked");
  });

  it("a task the media buyer already deleted is not re-created: Triage, with the reason", async () => {
    await db.query(`insert into deleted_tasks (owner_id, title) values ($1, 'Pause the ads for the holiday week')`, [people.aditya]);
    const { result } = await ask(tsAgo(0), "Pls pause ads over the holiday week", { owner: "ads", title: "Pause the ads for the holiday week", tech_type: null });
    expect(result).toMatchObject({ status: "triage", routed_table: null, triage_reason: "Looks like a task the media buyer already deleted, so it was not created again" });
    expect(await count("tasks")).toBe(0);
  });

  it("media buyer remit: the refusal is put in plain English, and no media buyer means Triage", async () => {
    expect(await rpc("router_refusal_reason", { p_error: "TASK_CATEGORY: media buyer tasks must be ads or call_centre" }))
      .toBe("Outside the media buyer's remit (their tasks must be ads or call centre)");
    expect(await rpc("router_refusal_reason", { p_error: "SOMETHING_ELSE: the clinic is archived" })).toBe("Could not be created: the clinic is archived");
    // The database still refuses anything outside the remit, whoever asks.
    await expect(db.query(`insert into tasks (owner_id, title, category, source) values ($1, 'Fix the form', 'tech', 'slack')`, [people.aditya])).rejects.toThrow(/TASK_CATEGORY/);
    await db.query(`update staff set status = 'left' where id = $1`, [people.aditya]);
    const { result } = await ask(tsAgo(0), "Raise the budget to $80 a day", { owner: "ads", title: "Raise daily budget to $80", tech_type: null });
    expect(result).toMatchObject({ status: "triage", triage_reason: "No one on the team holds the media buyer role" });
    expect(await count("tasks")).toBe(0);
  });

  it("nothing can be queued for a client channel (the guard is untouched)", async () => {
    await db.query(`insert into notifications (rule_key, channel, record_type) values ('outcome_overdue', $1, 'appointments')`, [GENERAL]);
    expect(await count("notifications")).toBe(0);
  });
});

describe("Triage and backfill decisions", () => {
  it("Assign from Triage routes it for that owner and keeps the model's own guess", async () => {
    const { id } = await ask(tsAgo(0), "Can you look at our budget and the form?", { owner: "tech", title: "Review budget and form", confidence: 0.6 });
    const r = await asUser(db, AUTH.ryan, () => rpc<RouteResult>("router_decide", { p_id: id, p_action: "assign", p_owner: "ads" }));
    expect(r).toMatchObject({ status: "routed", routed_table: "tasks", owner: "ads" });
    expect(await request(id)).toMatchObject({ owner: "tech", assigned_owner: "ads", triage_reason: null });
    expect((await one<{ owner_id: string; title: string }>(`select owner_id, title from tasks`))).toEqual({ owner_id: people.aditya, title: "Review budget and form" });
  });

  it("Not a request closes a Triage item without creating anything", async () => {
    const { id } = await ask(tsAgo(0), "ok", { confidence: 0.4 });
    const r = await asUser(db, AUTH.ryan, () => rpc<RouteResult>("router_decide", { p_id: id, p_action: "not_request", p_owner: null }));
    expect(r.status).toBe("not_request");
    expect(await count("tech_jobs")).toBe(0);
  });

  it("only the owner can decide or judge", async () => {
    const { id } = await ask(tsAgo(0), "ok", { confidence: 0.4 });
    await expect(asUser(db, AUTH.sameer, () => rpc("router_decide", { p_id: id, p_action: "assign", p_owner: "tech" }))).rejects.toThrow(/ROUTER_OWNER_ONLY/);
    await expect(asUser(db, AUTH.sameer, () => rpc("router_set_verdict", { p_id: id, p_verdict: "right" }))).rejects.toThrow(/ROUTER_OWNER_ONLY/);
    await expect(asUser(db, AUTH.sameer, () => rpc("route_client_request", { p_id: id, p_force_owner: "tech" }))).rejects.toThrow(/permission denied/);
    expect((await request(id)).status).toBe("triage");
    // Staff can read the requests; they cannot change them.
    expect(await asUser(db, AUTH.sameer, () => count("client_requests"))).toBe(1);
  });

  it("a backfilled request waits for approval; Approve routes it without a reply", async () => {
    await repliesOn(true);
    const s = (await store(tsAgo(4), "The calendar link is broken", { mode: "backfill" }))!;
    const r = await route(s.id, { title: "Fix broken calendar link", tech_type: "fix" });
    expect(r).toMatchObject({ status: "pending_approval", routed_table: null });
    expect(await count("tech_jobs")).toBe(0);
    // Low confidence and non-requests from a backfill go where live ones go.
    const low = (await store(tsAgo(4, 1), "maybe change something?", { mode: "backfill" }))!;
    expect((await route(low.id, { confidence: 0.5 })).status).toBe("triage");
    const chat = (await store(tsAgo(4, 2), "thank you", { mode: "backfill" }))!;
    expect((await route(chat.id, { is_request: false, owner: null, tech_type: null })).status).toBe("not_request");

    const approved = await asUser(db, AUTH.ryan, () => rpc<RouteResult>("router_decide", { p_id: s.id, p_action: "approve", p_owner: null }));
    expect(approved).toMatchObject({ status: "routed", routed_table: "tech_jobs", mode: "backfill" });
    expect(await count("tech_jobs")).toBe(1);
    expect((await request(s.id)).reply_logged_ts).toBe("skipped:backfill");
    expect((await rpc<{ items: unknown[] }>("router_replies_due", {})).items).toEqual([]);
    expect(await count("touches")).toBe(0);
  });

  it("Reject closes a backfilled request; a rejected one cannot be approved", async () => {
    const s = (await store(tsAgo(4), "Please add a second location", { mode: "backfill" }))!;
    await route(s.id, { title: "Add a second location" });
    expect((await rpc<RouteResult>("router_decide", { p_id: s.id, p_action: "reject", p_owner: null })).status).toBe("rejected");
    await expect(rpc("router_decide", { p_id: s.id, p_action: "approve", p_owner: null })).rejects.toThrow(/ROUTER_STATE/);
    expect(await count("tech_jobs")).toBe(0);
  });
});

describe("classifying (database side)", () => {
  const deps = (classify: () => Promise<Classification>) => ({ rpc, classify, reply: async () => ({ ok: true, ts: "9.9" }) });

  it("a failed classification leaves the message waiting with the error; the fifth failure sends it to Triage", async () => {
    const s = (await store(tsAgo(0), "Please block Wednesday"))!;
    const failing = deps(async () => { throw new Error("Anthropic HTTP 529"); });
    for (let i = 1; i <= 4; i++) {
      expect(await processRequest(s.id, failing)).toMatchObject({ outcome: "failed", status: "new" });
      expect(await request(s.id)).toMatchObject({ status: "new", attempts: i, classify_error: "Anthropic HTTP 529" });
    }
    expect(await processRequest(s.id, failing)).toMatchObject({ outcome: "failed", status: "triage" });
    expect(await request(s.id)).toMatchObject({ status: "triage", attempts: 5, triage_reason: "could not be classified" });
    // A person can still place it; the title falls back to the message.
    const r = await rpc<RouteResult>("router_decide", { p_id: s.id, p_action: "assign", p_owner: "tech" });
    expect(r.status).toBe("routed");
    expect((await one<{ title: string; type: string }>(`select title, type from tech_jobs`))).toEqual({ title: "Please block Wednesday", type: "other" });
  });

  it("the job picks up stored messages that were never classified, and a held message is not taken twice", async () => {
    const a = (await store(tsAgo(0), "Please block Wednesday 21st October"))!;
    await store(tsAgo(0, 1), "Thanks!");
    // Another worker has the first one right now.
    expect(await rpc("router_claim", { p_id: a.id, p_now: new Date().toISOString() })).not.toBeNull();
    expect(await rpc("router_claim", { p_id: a.id, p_now: new Date().toISOString() })).toBeNull();
    let calls = 0;
    const r = await processPending(deps(async () => { calls++; return answer({ is_request: false, owner: null, tech_type: null, title: "Thanks" }); }));
    expect(r).toMatchObject({ picked: 1, not_request: 1 });
    // Once the hold has gone stale the job takes it.
    await db.query(`update client_requests set claimed_at = now() - interval '10 minutes' where id = $1`, [a.id]);
    const r2 = await processPending(deps(async () => { calls++; return answer(); }));
    expect(r2).toMatchObject({ picked: 1, routed: 1 });
    expect(calls).toBe(2);
    expect((await processPending(deps(async () => answer()))).picked).toBe(0);
  });

  it("listening end to end: staff and unknown channels are dropped, a client's message is stored once", async () => {
    const lookups: string[] = [];
    const ingest = (user: string, ts: string, channel = GENERAL) =>
      ingestClientMessage({ channel, ts, user, text: "Please block Wednesday", threadTs: null }, {
        rpc,
        lookupUser: async (id) => {
          lookups.push(id);
          if (id === "U_FAIL") throw new Error("timeout");
          return id === "U_SAMEER" ? { email: "sameer@example.test", realName: "Sameer" } : { email: "dana@pivotal.test", realName: "Dana Front Desk" };
        },
      });
    expect(await ingest("U_SAMEER", tsAgo(0))).toEqual({ action: "ignored", reason: "staff" });
    expect(await ingest("U_SAMEER", tsAgo(0, 1))).toEqual({ action: "ignored", reason: "staff" });
    expect(await ingest("U_DANA", tsAgo(0, 2), "C0RANDOM")).toEqual({ action: "ignored", reason: "unknown_channel" });
    const ts = tsAgo(0, 3);
    const stored = await ingest("U_DANA", ts);
    expect(stored.action).toBe("stored");
    expect(await ingest("U_DANA", ts)).toMatchObject({ action: "duplicate" });
    // One lookup per person, however many messages.
    expect(lookups).toEqual(["U_SAMEER", "U_DANA"]);
    // The lookup failing = a client, with no email on record.
    expect((await ingest("U_FAIL", tsAgo(0, 4))).action).toBe("stored");
    expect(await one(`select email, is_staff from slack_people where slack_user_id = 'U_FAIL'`)).toEqual({ email: null, is_staff: false });
    expect(await count("client_requests")).toBe(2);
    expect((await one<{ sender_name: string }>(`select sender_name from client_requests where slack_ts = $1`, [ts])).sender_name).toBe("Dana Front Desk");
  });

  it("a backfill stores and classifies silently: no touch, no reply, no work", async () => {
    await repliesOn(true);
    const now = Math.floor(Date.now() / 1000);
    const history = [
      { type: "message", user: "U_DANA", text: "Please block Wednesday 21st October", ts: `${now - 3 * 86_400}.000100` },
      { type: "message", user: "U_DANA", text: "Thanks!", ts: `${now - 2 * 86_400}.000100` },
      { type: "message", subtype: "channel_join", user: "U_DANA", text: "joined", ts: `${now - 86_400}.000100` },
      { type: "message", user: "U_SAMEER", text: "Done, blocked", ts: `${now - 86_000}.000100` },
    ];
    const replies: unknown[] = [];
    const r = await runBackfill({
      rpc, days: 14,
      channels: [{ clientName: "Pivotal Health", channel: GENERAL, kind: "general" }],
      history: async () => history,
      lookupUser: async (id) => (id === "U_SAMEER" ? { email: "sameer@example.test", realName: "Sameer" } : { email: "dana@pivotal.test", realName: "Dana" }),
      classify: async (input) => (input.text.startsWith("Thanks") ? answer({ is_request: false, owner: null, tech_type: null, title: "Thanks" }) : answer()),
    });
    expect(r).toMatchObject({ read: 4, stored: 2, ignored: 2, failed: 0 });
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]).toMatchObject({ clinic: "Pivotal Health", status: "pending_approval", owner: "tech" });
    expect(await count("client_requests", `mode = 'backfill'`)).toBe(2);
    expect(await count("tech_jobs") + await count("tasks") + await count("exceptions") + await count("touches") + await count("notifications")).toBe(0);
    expect(replies).toEqual([]);
    expect((await one<{ last_reply_client: Date | null }>(`select last_reply_client from clients where id = $1`, [clinic])).last_reply_client).toBeNull();
    // Running it again stores nothing new.
    const again = await runBackfill({ rpc, days: 14, channels: [{ clientName: "Pivotal Health", channel: GENERAL, kind: "general" }], history: async () => history, lookupUser: async () => null, classify: async () => answer() });
    expect(again).toMatchObject({ stored: 0, alreadyStored: 2 });
  });
});

describe("thread replies", () => {
  let sent: { channel: string; threadTs: string; text: string }[];
  const reply = async (o: { channel: string; threadTs: string; text: string }) => {
    sent.push({ channel: o.channel, threadTs: o.threadTs, text: o.text });
    return { ok: true, ts: `${1_800_000_000 + sent.length}.000200` };
  };
  beforeEach(() => { sent = []; });

  it("off: nothing is sent, and nothing is left to send when it is switched on later", async () => {
    const { id, result } = await ask(tsAgo(0), "Please block Wednesday 21st October");
    expect((await request(id)).reply_logged_ts).toBe("off");
    expect(await sendDueReplies({ rpc, reply })).toEqual({ enabled: false, sent: 0, failed: 0 });
    await db.query(`update tech_jobs set status = 'done' where id = $1`, [result.routed_id]);
    await repliesOn(true);
    expect(await sendDueReplies({ rpc, reply })).toEqual({ enabled: true, sent: 0, failed: 0 });
    expect(sent).toEqual([]);
  });

  it("on: Logged once when routed, Done once when the work is closed", async () => {
    await repliesOn(true);
    const ts = tsAgo(0);
    const { id, result } = await ask(ts, "Please block Wednesday 21st October", { due_at: "2026-10-21T04:00:00.000Z" });
    expect((await request(id)).reply_logged_ts).toBeNull();
    expect(await sendDueReplies({ rpc, reply })).toEqual({ enabled: true, sent: 1, failed: 0 });
    expect(sent).toEqual([{ channel: GENERAL, threadTs: ts, text: "Logged ✓ — Sameer will block Wednesday 21 October on the calendar by Wed 21 Oct" }]);
    expect((await request(id)).reply_logged_ts).toBe("1800000001.000200");
    // Nothing more until the job is done.
    expect((await sendDueReplies({ rpc, reply })).sent).toBe(0);
    await db.query(`update tech_jobs set status = 'done' where id = $1`, [result.routed_id]);
    expect((await sendDueReplies({ rpc, reply })).sent).toBe(1);
    expect(sent[1]).toEqual({ channel: GENERAL, threadTs: ts, text: "Done ✓" });
    expect((await sendDueReplies({ rpc, reply })).sent).toBe(0);
    expect(sent).toHaveLength(2);
  });

  it("a fix quotes its SLA time; Triage, merged and non-requests get no reply", async () => {
    await repliesOn(true);
    const fix = await ask(tsAgo(0), "The form is broken", { title: "Fix the booking form", tech_type: "fix" });
    await ask(tsAgo(0, 1), "The form is still broken!", { title: "Fix the booking form", tech_type: "fix" }); // merged
    await ask(tsAgo(0, 2), "eh?", { confidence: 0.3 }); // triage
    await ask(tsAgo(0, 3), "Thanks", { is_request: false, owner: null, tech_type: null }); // not a request
    const due = await rpc<{ items: { id: string; kind: string; due_at: string }[] }>("router_replies_due", {});
    expect(due.items.map((i) => [i.id, i.kind])).toEqual([[fix.id, "logged"]]);
    const job = await one<{ due_at: Date }>(`select due_at from tech_jobs where id = $1`, [fix.result.routed_id]);
    expect(new Date(due.items[0].due_at).getTime()).toBe(job.due_at.getTime());
  });

  it("switching replies off before the work closes means no Done later; a failed send is tried again", async () => {
    await repliesOn(true);
    const { id, result } = await ask(tsAgo(0), "Please block Wednesday 21st October");
    const failing = async () => ({ ok: false, error: "ratelimited" });
    expect(await sendDueReplies({ rpc, reply: failing })).toEqual({ enabled: true, sent: 0, failed: 1 });
    expect((await request(id)).reply_logged_ts).toBeNull();
    expect((await sendDueReplies({ rpc, reply })).sent).toBe(1);
    await repliesOn(false);
    await db.query(`update tech_jobs set status = 'done' where id = $1`, [result.routed_id]);
    await sendDueReplies({ rpc, reply });
    expect((await request(id)).reply_done_ts).toBe("off");
    await repliesOn(true);
    expect((await sendDueReplies({ rpc, reply })).sent).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("an exception resolved and a task done both count as closed", async () => {
    await repliesOn(true);
    const ex = await ask(tsAgo(0), "Please resend the invoice", { owner: "ryan", title: "Resend the invoice", tech_type: null });
    const task = await ask(tsAgo(0, 1), "Raise the budget", { owner: "ads", title: "Raise the daily budget", tech_type: null });
    expect((await sendDueReplies({ rpc, reply })).sent).toBe(2);
    expect(sent.map((s) => s.text)).toEqual(["Logged ✓ — Ryan will resend the invoice", "Logged ✓ — Aditya will raise the daily budget"]);
    await db.query(`update exceptions set status = 'resolved', resolved_at = now() where id = $1`, [ex.result.routed_id]);
    await db.query(`update tasks set status = 'done' where id = $1`, [task.result.routed_id]);
    expect((await sendDueReplies({ rpc, reply })).sent).toBe(2);
    expect(sent.slice(2).map((s) => s.text)).toEqual(["Done ✓", "Done ✓"]);
  });
});

describe("router_accuracy", () => {
  it("counts classified, judged, right and wrong, overall and per owner, for 7 and 30 days", async () => {
    const tech1 = await ask(tsAgo(1), "Block Monday", { title: "Block Monday on the calendar" });
    const tech2 = await ask(tsAgo(2), "Add Dr Lee", { title: "Add Dr Lee as a provider" });
    const ads = await ask(tsAgo(3), "Raise budget", { owner: "ads", title: "Raise the budget", tech_type: null });
    const chat = await ask(tsAgo(4), "Thanks", { is_request: false, owner: null, tech_type: null });
    const old = await ask(tsAgo(20), "Refund please", { owner: "ryan", title: "Handle refund", urgency: "urgent", tech_type: null });
    await store(tsAgo(0), "not classified yet");
    const judge = (id: string, verdict: string) => asUser(db, AUTH.ryan, () => rpc("router_set_verdict", { p_id: id, p_verdict: verdict }));
    await judge(tech1.id, "right");
    await judge(tech2.id, "wrong");
    await judge(ads.id, "right");
    await judge(chat.id, "right");
    await judge(old.id, "wrong");
    expect(await one(`select verdict, verdict_by, verdict_at is not null as at from client_requests where id = $1`, [tech1.id])).toEqual({ verdict: "right", verdict_by: people.ryan, at: true });

    const rows = (await db.query<{ window_days: number; owner: string; classified: number; judged: number; right_count: number; wrong_count: number; accuracy_pct: string | null }>(
      `select * from router_accuracy`)).rows;
    const get = (days: number, owner: string) => {
      const r = rows.find((x) => x.window_days === days && x.owner === owner)!;
      return [r.classified, r.judged, r.right_count, r.wrong_count, r.accuracy_pct === null ? null : Number(r.accuracy_pct)];
    };
    expect(rows).toHaveLength(10);
    expect(get(7, "all")).toEqual([4, 4, 3, 1, 75]);
    expect(get(7, "tech")).toEqual([2, 2, 1, 1, 50]);
    expect(get(7, "ads")).toEqual([1, 1, 1, 0, 100]);
    expect(get(7, "ryan")).toEqual([0, 0, 0, 0, null]);
    expect(get(7, "none")).toEqual([1, 1, 1, 0, 100]);
    expect(get(30, "all")).toEqual([5, 5, 3, 2, 60]);
    expect(get(30, "ryan")).toEqual([1, 1, 0, 1, 0]);
  });
});

describe("angry follow-up on a logged request", () => {
  it("raises the original to urgent and queues one DM for the owner, once", async () => {
    const d = await freshDb();
    const p = await seedStaff(d);
    const c = (await d.query<{ id: string }>(`insert into clients (name, stage) values ('Angry Clinic', 'live') returning id`)).rows[0].id;
    const task = (await d.query<{ id: string }>(`insert into tasks (owner_id, title, category, source) values ($1, 'Lower the ad price', 'ads', 'slack') returning id`, [p.aditya])).rows[0].id;
    const req = (ts: string, extra: string) =>
      d.query<{ id: string }>(
        `insert into client_requests (client_id, channel, channel_kind, slack_ts, text, permalink, received_at, title, owner, ${extra.split("|")[0]})
         values ($1, 'CANGRY', 'general', $2, 'msg', 'https://slack.com/archives/CANGRY/p' || $2, now(), 'Lower the ad price', 'ads', ${extra.split("|")[1]}) returning id`, [c, ts]);
    const orig = (await req("1.1", `status, routed_table, routed_id, urgency|'routed', 'tasks', '${task}', 'normal'`)).rows[0].id;
    const calm = (await req("1.2", "urgency|'normal'")).rows[0].id;
    const angry = (await req("1.3", "urgency|'urgent'")).rows[0].id;
    const again = (await req("1.4", "urgency|'urgent'")).rows[0].id;
    const merge = (id: string) => d.query(`update client_requests set status = 'merged', merged_into = $2 where id = $1`, [id, orig]);
    const state = async () => ({
      urgency: (await d.query<{ urgency: string }>(`select urgency from client_requests where id = $1`, [orig])).rows[0].urgency,
      priority: (await d.query<{ priority: string }>(`select priority from tasks where id = $1`, [task])).rows[0].priority,
      escalations: (await d.query(`select 1 from exceptions where type = 'client_escalation'`)).rows.length,
      dms: (await d.query<{ staff_id: string }>(`select staff_id from notifications where rule_key = 'exception_opened' and payload->>'type' = 'client_escalation'`)).rows.map((r) => r.staff_id),
    });
    await merge(calm);
    expect(await state()).toEqual({ urgency: "normal", priority: "medium", escalations: 0, dms: [] });
    await merge(angry);
    expect(await state()).toEqual({ urgency: "urgent", priority: "high", escalations: 1, dms: [p.ryan] });
    await merge(again);
    expect(await state()).toEqual({ urgency: "urgent", priority: "high", escalations: 1, dms: [p.ryan] });
  });
});

describe("Triage handled in Slack", () => {
  // Fixed, close-together timestamps so "before" and "after" are exact.
  const T = (n: number, micro = "000100") => `${1_790_000_000 + n}.${micro}`;
  type Opts = { channel?: string; thread?: string | null; mode?: "live" | "backfill" };
  const put = async (ts: string, o: Opts = {}) =>
    (await rpc<Stored>("router_store_message", {
      p_channel: o.channel ?? GENERAL, p_ts: ts, p_user: "U_CLIENT", p_sender_name: "Dana Front Desk", p_text: "Can someone look at this?", p_thread_ts: o.thread ?? null, p_mode: o.mode ?? "live",
    })).id;
  /** A client message the model was not sure about: it waits in Triage. */
  const triage = async (ts: string, o: Opts = {}) => {
    const id = await put(ts, o);
    expect((await route(id, { confidence: 0.5 })).status).toBe("triage");
    return id;
  };
  const mark = (ts: string, o: { channel?: string; thread?: string | null; by?: string } = {}) =>
    rpc<number>("router_mark_handled", { p_channel: o.channel ?? GENERAL, p_ts: ts, p_thread_ts: o.thread ?? null, p_by: o.by ?? "Sameer" });
  const status = async (id: string) => (await request(id)).status;
  const handled = (id: string) =>
    one<{ status: string; handled_reason: string | null; handled_by: string | null; handled_ts: string | null; handled_at: Date | null; triage_reason: string | null }>(
      `select status, handled_reason, handled_by, handled_ts, handled_at, triage_reason from client_requests where id = $1`, [id]);

  it("a staff reply in a thread handles the thread's root and earlier messages in that thread, nothing else", async () => {
    const root = await triage(T(0));
    const earlier = await triage(T(10), { thread: T(0) });
    const later = await triage(T(30), { thread: T(0) });
    const otherThread = await triage(T(5));
    const otherThreadReply = await triage(T(12), { thread: T(5) });
    const topLevel = await triage(T(15));

    expect(await mark(T(20), { thread: T(0) })).toBe(2);
    expect(await handled(root)).toMatchObject({ status: "handled", handled_reason: "Handled in Slack", handled_by: "Sameer", handled_ts: T(20), triage_reason: "Low confidence (50%)" });
    expect((await handled(root)).handled_at).toBeInstanceOf(Date);
    expect(await status(earlier)).toBe("handled");
    for (const id of [later, otherThread, otherThreadReply, topLevel]) expect(await status(id)).toBe("triage");
    expect(await handled(later)).toMatchObject({ handled_reason: null, handled_by: null, handled_ts: null, handled_at: null });
    // The same reply again (a Slack retry, or the sweep after the webhook) changes nothing.
    expect(await mark(T(20), { thread: T(0), by: "Someone Else" })).toBe(0);
    expect((await handled(root)).handled_by).toBe("Sameer");
    // The row is still there: hidden with a reason, not deleted.
    expect(await count("client_requests")).toBe(6);
  });

  it("a staff post in the channel handles earlier Triage rows there: not later ones, not other channels, not other statuses", async () => {
    const before = await triage(T(0));
    const beforeInThread = await triage(T(5), { thread: T(1) });
    const after = await triage(T(40));
    const otherChannel = await triage(T(2), { channel: SCHEDULING });
    const fresh = await put(T(3));
    const pending = await put(T(4), { mode: "backfill" });
    expect((await route(pending)).status).toBe("pending_approval");
    const routed = (await ask(T(6), "Please block Wednesday 21st October")).id;
    const notRequest = (await ask(T(7), "Thanks!", { is_request: false, owner: null, tech_type: null, title: "Thanks" })).id;

    expect(await mark(T(20))).toBe(2);
    expect(await status(before)).toBe("handled");
    expect(await status(beforeInThread)).toBe("handled");
    expect(await status(after)).toBe("triage");
    expect(await status(otherChannel)).toBe("triage");
    expect(await status(fresh)).toBe("new");
    expect(await status(pending)).toBe("pending_approval");
    expect(await status(routed)).toBe("routed");
    expect(await status(notRequest)).toBe("not_request");
    expect(await count("client_requests", `status <> 'handled' and (handled_at is not null or handled_by is not null or handled_reason is not null or handled_ts is not null)`)).toBe(0);
    expect(await count("tech_jobs")).toBe(1);
    // A post in a channel that is no client's, or before everything, handles nothing.
    expect(await mark(T(99), { channel: "C0RANDOM" })).toBe(0);
    expect(await mark(T(-50), { channel: SCHEDULING })).toBe(0);
    expect(await status(otherChannel)).toBe("triage");
  });

  it("compares Slack timestamps as numbers, not as text", async () => {
    // As text '999999999.000100' sorts after '1000000000.000100'; as a number it is earlier.
    const old = await triage("999999999.000100");
    const newer = await triage("1000000005.000100");
    expect(await mark("1000000000.000100")).toBe(1);
    expect(await status(old)).toBe("handled");
    expect(await status(newer)).toBe("triage");
    // Same second: only the microseconds differ.
    const a = await triage("1000000010.000200");
    const b = await triage("1000000010.000900");
    expect(await mark("1000000010.000500")).toBe(2);
    expect(await status(a)).toBe("handled");
    expect(await status(b)).toBe("triage");
    await expect(mark("yesterday")).rejects.toThrow(/ROUTER_BAD_TS/);
  });

  it("a handled row is out of the Triage queue, cannot be assigned afterwards, and still counts in the router's totals", async () => {
    const id = await triage(tsAgo(1));
    await mark(tsAgo(0));
    expect(await count("client_requests", `status = 'triage'`)).toBe(0);
    expect(await rpc("router_open_triage")).toEqual([]);
    await asUser(db, AUTH.ryan, async () => {
      await expect(db.query(`select router_decide($1, 'assign', 'tech')`, [id])).rejects.toThrow(/ROUTER_STATE/);
      await expect(db.query(`select router_decide($1, 'not_request')`, [id])).rejects.toThrow(/ROUTER_STATE/);
      const seen = await db.query<{ status: string; handled_by: string }>(`select status, handled_by from client_requests where id = $1`, [id]);
      expect(seen.rows).toEqual([{ status: "handled", handled_by: "Sameer" }]);
      const acc = await db.query<{ classified: number }>(`select classified from router_accuracy where window_days = 7 and owner = 'all'`);
      expect(acc.rows[0].classified).toBe(1);
    });
    // Routing it again as if it were new changes nothing.
    expect((await route(id)).status).toBe("handled");
    expect(await count("tech_jobs") + await count("tasks") + await count("exceptions")).toBe(0);
    // The change is in the audit log like any other.
    expect(await count("audit_log", `table_name = 'client_requests' and actor = 'request-router' and field = 'status' and new_value like '%handled%'`)).toBeGreaterThan(0);
  });

  it("only the server can mark rows handled or read the sweep's list", async () => {
    const id = await triage(T(0));
    for (const who of [AUTH.ryan, AUTH.sameer]) {
      await asUser(db, who, async () => {
        await expect(db.query(`select router_mark_handled($1, $2, null, 'x')`, [GENERAL, T(20)])).rejects.toThrow(/permission denied/);
        await expect(db.query(`select router_open_triage()`)).rejects.toThrow(/permission denied/);
      });
    }
    expect(await status(id)).toBe("triage");
    await db.exec(`set role service_role`);
    try {
      expect((await db.query<{ n: number }>(`select router_mark_handled($1, $2, null, 'x') as n`, [GENERAL, T(20)])).rows[0].n).toBe(1);
    } finally {
      await db.exec(`reset role`);
    }
  });

  it("live: a staff message arriving at the webhook clears the Triage rows it answers; a client's never does", async () => {
    const lookupUser = async (id: string) => (id === "U_SAMEER" ? { email: "sameer@example.test", realName: "Sameer" } : { email: "dana@pivotal.test", realName: "Dana Front Desk" });
    const arrive = (user: string, ts: string, threadTs: string | null = null, text = "On it") => ingestClientMessage({ channel: GENERAL, ts, user, text, threadTs }, { rpc, lookupUser });
    const first = await triage(T(0));
    const second = await triage(T(5));

    // Another client message, in the thread and in the channel: stored, clears nothing.
    expect((await arrive("U_DANA", T(8), T(0))).action).toBe("stored");
    expect((await arrive("U_DANA", T(9))).action).toBe("stored");
    expect(await count("client_requests", `status = 'handled'`)).toBe(0);

    // Staff reply in the first message's thread: only that one.
    expect(await arrive("U_SAMEER", T(10), T(0))).toEqual({ action: "ignored", reason: "staff" });
    expect(await handled(first)).toMatchObject({ status: "handled", handled_by: "Sameer", handled_ts: T(10) });
    expect(await status(second)).toBe("triage");
    // Staff post in the channel (a file with no text): the rest that came before it.
    expect(await arrive("U_SAMEER", T(20), null, "")).toEqual({ action: "ignored", reason: "staff" });
    expect(await handled(second)).toMatchObject({ status: "handled", handled_ts: T(20) });
    // Staff messages are still never stored as client requests; the two client messages wait to be classified.
    expect(await count("client_requests")).toBe(4);
    expect(await count("client_requests", `slack_user_id = 'U_SAMEER'`)).toBe(0);
    expect(await count("client_requests", `status = 'new'`)).toBe(2);
  });

  it("the sweep reads history and threads with GET only and marks the rows staff have answered", async () => {
    const other = (await one<{ id: string }>(
      `insert into clients (name, stage, pod, slack_general_id) values ('Multivita IV', 'live', 'pod_1', 'C0MULTI') returning id`)).id;
    const answeredInThread = await triage(T(0));
    const clientOnlyThread = await triage(T(10));
    const answeredInChannel = await triage(T(20), { channel: SCHEDULING });
    const unanswered = await triage(T(40), { channel: SCHEDULING });
    const elsewhere = await triage(T(1), { channel: "C0MULTI" });
    expect(other).toBeTruthy();

    const msg = (user: string, ts: string, over: Record<string, unknown> = {}) => ({ type: "message", user, text: "hello", ts, ...over });
    const slack: Record<string, unknown[]> = {
      // History starts after the oldest open row, so T(0) itself is not in it.
      [`conversations.history:${GENERAL}`]: [msg("U_DANA", T(10), { thread_ts: T(10), reply_count: 1 })],
      [`conversations.replies:${GENERAL}:${T(0)}`]: [msg("U_DANA", T(0), { thread_ts: T(0), reply_count: 1 }), msg("U_SAMEER", T(3), { thread_ts: T(0) })],
      [`conversations.replies:${GENERAL}:${T(10)}`]: [msg("U_DANA", T(10), { thread_ts: T(10), reply_count: 1 }), msg("U_DANA", T(12), { thread_ts: T(10) })],
      [`conversations.history:${SCHEDULING}`]: [
        msg("U_DANA", T(40)), msg("U_SAMEER", T(30)), msg("U_DANA", T(25)),
        { type: "message", subtype: "bot_message", bot_id: "B_GENEXA", text: "Logged ✓", ts: T(45) },
      ],
      "conversations.history:C0MULTI": [msg("U_ERIN", T(50))],
    };
    const calls: { url: string; method: string | undefined; body: unknown }[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url: String(input), method: init?.method, body: init?.body });
      const method = url.pathname.replace("/api/", "");
      const q = url.searchParams;
      if (method === "users.info") {
        const id = q.get("user");
        const profile = id === "U_SAMEER" ? { email: "sameer@example.test" } : { email: `${id}@clinic.test` };
        return { json: async () => ({ ok: true, user: { real_name: id === "U_SAMEER" ? "Sameer" : "Front Desk", profile } }) };
      }
      const key = method === "conversations.replies" ? `${method}:${q.get("channel")}:${q.get("ts")}` : `${method}:${q.get("channel")}`;
      return { json: async () => ({ ok: true, messages: slack[key] ?? [], has_more: false }) };
    }) as unknown as typeof fetch;
    const deps = { token: "xoxb-client", fetch: fakeFetch };
    const sweep = () => sweepHandled({
      rpc,
      history: (channel, oldest) => fetchChannelHistory(channel, oldest, deps),
      replies: (channel, threadTs) => fetchThreadReplies(channel, threadTs, deps),
      lookupUser: (id) => fetchSlackUser(id, deps),
    });

    const r = await sweep();
    expect(r).toMatchObject({ channels: 3, handled: 2, skippedChannels: [] });
    expect(r.byClinic).toEqual([{ clinic: "Multivita IV", handled: 0 }, { clinic: "Pivotal Health", handled: 2 }]);
    expect(await handled(answeredInThread)).toMatchObject({ status: "handled", handled_reason: "Handled in Slack", handled_by: "Sameer", handled_ts: T(3) });
    expect(await handled(answeredInChannel)).toMatchObject({ status: "handled", handled_by: "Sameer", handled_ts: T(30) });
    for (const id of [clientOnlyThread, unanswered, elsewhere]) expect(await status(id)).toBe("triage");

    // Read-only towards Slack: every call is a GET to a read method, with no body.
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.method).toBeUndefined();
      expect(c.body).toBeUndefined();
      expect(c.url).toMatch(/^https:\/\/slack\.com\/api\/(conversations\.history|conversations\.replies|users\.info)\?/);
    }
    expect(calls.filter((c) => c.url.includes("conversations.history")).map((c) => new URL(c.url).searchParams.get("oldest")).sort())
      .toEqual([T(0), T(1), T(20)].sort());
    // Staff are never stored as requests, and nothing else was touched.
    expect(await count("client_requests")).toBe(5);
    expect(await count("tech_jobs") + await count("tasks") + await count("exceptions")).toBe(0);

    // Running it again changes nothing; a row that reaches Triage after our reply is picked up next time.
    expect((await sweep()).handled).toBe(0);
    const late = await triage(T(26), { channel: SCHEDULING });
    expect(await status(late)).toBe("triage");
    expect((await sweep()).handled).toBe(1);
    expect(await handled(late)).toMatchObject({ status: "handled", handled_ts: T(30) });
    expect(await status(unanswered)).toBe("triage");
  });
});
