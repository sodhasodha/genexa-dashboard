import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshDb, seedStaff, type TestPeople } from "./db";
import { deliverReminders, runReminders, type Rpc, type SendResult } from "@/lib/reminders/engine";
import { handleInteraction } from "@/lib/reminders/interaction";
import type { Block } from "@/lib/reminders/compose";

// The engine against the in-process Postgres, with a fake Slack and a clock the test sets.
let db: PGlite;
let people: TestPeople;
let sent: { target: string; text: string; blocks: Block[] }[];
let failSends = false;

const APP = "https://ops.test";
const rpc: Rpc = async <T>(fn: string, args: Record<string, unknown> = {}) => {
  const keys = Object.keys(args);
  const r = await db.query<{ r: T }>(`select ${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]));
  return r.rows[0].r;
};
const send = async (target: string, text: string, blocks: Block[] = []): Promise<SendResult> => {
  if (failSends) return { ok: false, error: "channel_not_found" };
  sent.push({ target, text, blocks });
  return { ok: true, ts: `${sent.length}.000`, channel: `D_${target}` };
};
const run = (now: string) => runReminders({ rpc, send, appUrl: APP, now: new Date(now) });
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];

/** An instant: ET day (today + offset) at HH:MM ET. */
const at = async (dayOffset: number, time: string) =>
  (await one<{ t: Date }>(`select ((app_today() + $1::int + $2::time) at time zone 'America/New_York') as t`, [dayOffset, time])).t.toISOString();
const plus = (iso: string, minutes: number) => new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
const to = (who: keyof TestPeople) => sent.filter((m) => m.target === `U_${who}`);
const shift = (who: keyof TestPeople, start = "09:00", end = "17:00") =>
  db.query(`update staff set shift_start = $2, shift_end = $3, working_days = '{1,2,3,4,5,6,7}' where id = $1`, [people[who], start, end]);
const enable = (key: string, on = true) => db.query(`update reminder_rules set enabled = $2 where key = $1`, [key, on]);
const notes = (where: string, params: unknown[] = []) =>
  db.query<{ rule_key: string; sent_at: Date | null; held_until: Date | null; channel: string | null; slack_ts: string | null; acknowledged_at: Date | null }>(
    `select rule_key, sent_at, held_until, channel, slack_ts, acknowledged_at from notifications where ${where} order by created_at`, params);

// One database for the file. Each test starts from empty data tables and the seeded rules
// (truncate is test-only: the app never deletes).
beforeAll(async () => {
  db = await freshDb();
  await db.exec(`create table _rules_seed as select key, enabled, urgent, quiet_hours_respected from reminder_rules`);
});

beforeEach(async () => {
  await db.exec(`
    drop view if exists attendance_week_flags;
    truncate staff, clients, notifications, audit_log, prospects, exceptions cascade;
    update reminder_rules r set enabled = s.enabled, urgent = s.urgent, quiet_hours_respected = s.quiet_hours_respected
      from _rules_seed s where s.key = r.key;
    update integration_sync_status set last_success_at = null, last_attempt_at = null, error = null, status = 'stale';
    select set_config('app.actor', '', false);`);
  people = await seedStaff(db);
  sent = [];
  failSends = false;
  await db.query(`update staff set slack_user_id = 'U_' || split_part(email, '@', 1)`);
  await shift("sameer");
  // Keeps the suite independent of the day it runs on: no Monday scorecard, no go-live date yet.
  await enable("weekly_scorecard", false);
  await db.query(`update app_settings set value = null where key = 'go_live_date'`);
});

describe("seeded rules", () => {
  it("every rule in the brief is a row; the three waiting on data are off", async () => {
    const rows = (await db.query<{ key: string; enabled: boolean; timing: string }>(`select key, enabled, timing from reminder_rules`)).rows;
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    for (const key of ["start_of_shift_digest", "ryan_morning_digest", "eod_due", "eod_missed", "task_due_today", "task_overdue", "task_assigned",
      "tech_job_new", "tech_job_sla_warning", "tech_job_sla_breached", "launch_sla_warning", "exception_opened", "renewal_due",
      "guarantee_deadline", "prospect_follow_up", "sync_failure"]) {
      expect(by[key]?.enabled, key).toBe(true);
    }
    expect(by.unconfirmed_tomorrow).toMatchObject({ enabled: false });
    expect(by.unconfirmed_tomorrow.timing).toContain("Retired");
    expect(by.outcome_overdue.enabled).toBe(false);
    expect(by.outcome_overdue.timing).toContain("Retired");
    expect(by.lead_not_called).toMatchObject({ enabled: false, timing: "waiting for Hot Prospector" });
  });
});

describe("acceptance 1: a task due today", () => {
  it("produces exactly one shift-start DM, and nothing more that day", async () => {
    const task = await one<{ id: string }>(`insert into tasks (owner_id, title, due, source, created_at) values ($1, 'Rebuild the calendar', app_today() + 1, 'ryan', $2) returning id`,
      [people.sameer, await at(0, "19:00")]); // added by Ryan the evening before

    await run(await at(0, "19:05"));
    await run(await at(1, "08:30")); // before the shift
    expect(to("sameer")).toEqual([]);

    await run(await at(1, "09:02"));
    expect(to("sameer").length).toBe(1);
    const dm = to("sameer")[0];
    expect(dm.text).toContain("Rebuild the calendar");
    expect(dm.text).toContain("Due today");
    expect(dm.text).toContain(`${APP}/tasks?task=${task.id}`);
    // One Done / Snooze 1h pair for the task.
    const actions = dm.blocks.filter((b) => b.type === "actions");
    expect(actions.length).toBe(1);
    expect(JSON.stringify(actions[0])).toContain(`tasks:${task.id}`);

    for (const t of ["09:07", "11:00", "15:00"]) await run(await at(1, t));
    expect(to("sameer").length).toBe(1);

    // The digest row and the task's own row were both covered by that one message.
    const rows = (await notes(`staff_id = $1`, [people.sameer])).rows;
    // The digest row, the task's due-today row and its "assigned" row (held overnight) all rode on that one message.
    expect(rows.map((r) => r.rule_key).sort()).toEqual(["start_of_shift_digest", "task_assigned", "task_due_today"]);
    expect(new Set(rows.map((r) => r.slack_ts)).size).toBe(1);
    expect(rows.every((r) => r.sent_at !== null)).toBe(true);
  });

  it("an overdue task is listed with days overdue, once per shift, daily while overdue", async () => {
    await db.query(`insert into tasks (owner_id, title, due, source, created_at) values ($1, 'Send the Loom', app_today() - 2, 'ryan', now() - interval '3 days')`, [people.sameer]);
    await run(await at(1, "09:02"));
    await run(await at(1, "12:00"));
    expect(to("sameer").length).toBe(1);
    expect(to("sameer")[0].text).toContain("3 days overdue");
    await run(await at(2, "09:02"));
    expect(to("sameer").length).toBe(2);
    expect(to("sameer")[1].text).toContain("4 days overdue");
  });

  it("with the digest switched off the task rule still sends one list; with both off nothing goes", async () => {
    await db.query(`insert into tasks (owner_id, title, due, source, created_at) values ($1, 'A', app_today() + 1, 'ryan', now() - interval '3 days'), ($1, 'B', app_today() + 1, 'ryan', now() - interval '3 days')`, [people.sameer]);
    await enable("start_of_shift_digest", false);
    await enable("task_due_today", false);
    await run(await at(1, "09:02"));
    expect(to("sameer")).toEqual([]);
    await enable("task_due_today");
    await run(await at(1, "09:07"));
    expect(to("sameer").length).toBe(1);
    expect(to("sameer")[0].blocks.filter((b) => b.type === "actions").length).toBe(2);
  });
});

describe("acceptance 2: an overdue tech job", () => {
  it("reminds its owner at breach, then escalates to the app owner once after 24h", async () => {
    const job = await one<{ id: string }>(
      `insert into tech_jobs (type, title, owner_id, requested_by, requested_at, created_at)
       values ('fix', 'Calendar broken', $1, $2, now() - interval '9 days', now() - interval '9 days') returning id`, [people.sameer, people.ryan]);
    const escalations = () => to("ryan").filter((m) => m.text.startsWith("Still open after 24h"));

    await run(await at(1, "09:05"));
    const breach = to("sameer").filter((m) => m.text.startsWith("SLA breached"));
    expect(breach.length).toBe(1);
    expect(breach[0].text).toContain("Calendar broken");
    expect(breach[0].text).toContain("overdue by");

    await run(await at(1, "16:00")); // 7 hours on: too early
    expect(escalations()).toEqual([]);

    await run(await at(2, "09:10")); // 24h after the first reminder
    expect(escalations().length).toBe(1);
    expect(escalations()[0].text).toContain("Calendar broken");
    expect(escalations()[0].text).toContain("Sameer reminded 1 time");
    expect(escalations()[0].text).toContain(`${APP}/tech?job=${job.id}`);

    for (const [d, t] of [[2, "09:15"], [2, "15:00"], [3, "09:10"], [4, "09:10"]] as const) await run(await at(d, t));
    expect(escalations().length).toBe(1);
    expect(to("sameer").filter((m) => m.text.startsWith("SLA breached")).length).toBe(1);
  });

  it("does not escalate a job that was finished inside the 24 hours", async () => {
    const job = await one<{ id: string }>(
      `insert into tech_jobs (type, title, owner_id, requested_at, created_at) values ('fix', 'Pixel down', $1, now() - interval '9 days', now() - interval '9 days') returning id`, [people.sameer]);
    await run(await at(1, "09:05"));
    await db.query(`update tech_jobs set status = 'done' where id = $1`, [job.id]);
    await run(await at(2, "09:10"));
    expect(to("ryan").filter((m) => m.text.startsWith("Still open after 24h"))).toEqual([]);
  });

  it("escalates an open exception and an overdue task the same way, but not a snoozed exception", async () => {
    const mk = async (key: string, reason: string) => {
      const id = (await one<{ id: string }>(
        `insert into exceptions (type, owner_id, severity, reason, dedupe_key) values ('ad_fatigue', $1, 'amber', $2, $3) returning id`, [people.sameer, reason, key])).id;
      await db.query(`insert into notifications (rule_key, staff_id, record_type, record_id) values ('exception_opened', $1, 'exceptions', $2)`, [people.sameer, id]);
      return id;
    };
    const open = await mk("e1", "Alpha: ad tired");
    const parked = await mk("e2", "Beta: ad tired");
    await db.query(`insert into tasks (owner_id, title, due, source, created_at) values ($1, 'Send the report', app_today() - 1, 'ryan', now() - interval '3 days')`, [people.sameer]);
    await run(await at(1, "09:05"));
    await db.query(`update exceptions set status = 'snoozed', snoozed_until = now() + interval '9 days', snooze_reason = 'Client away' where id = $1`, [parked]);
    await run(await at(2, "09:04")); // 23h59m after: not yet
    expect(to("ryan").filter((m) => m.text.startsWith("Still open after 24h"))).toEqual([]);
    await run(await at(2, "09:10"));
    await run(await at(3, "09:10"));
    const esc = to("ryan").filter((m) => m.text.startsWith("Still open after 24h"));
    expect(esc.length).toBe(1);
    expect(esc[0].text).toContain("Alpha: ad tired");
    expect(esc[0].text).toContain(`${APP}/overview?exception=${open}`);
    expect(esc[0].text).toContain("Send the report");
    expect(esc[0].text).toContain("Sameer reminded 2 times"); // the task: day 1 and day 2
    expect(esc[0].text).not.toContain("Beta: ad tired");
  });

  it("an exception about the same job does not escalate it a second time, and its DM is not doubled", async () => {
    const job = await one<{ id: string }>(
      `insert into tech_jobs (type, title, owner_id, requested_at, created_at) values ('fix', 'Form broken', $1, now() - interval '9 days', now() - interval '9 days') returning id`, [people.sameer]);
    await run(await at(1, "09:05"));
    // The exceptions engine opens its own row for the job and queues its DM.
    await db.query(`select * from run_exceptions_engine()`);
    const ex = await one<{ id: string }>(`select id from exceptions where type = 'tech_job_overdue' and record_id = $1`, [job.id]);
    await db.query(`insert into notifications (rule_key, staff_id, record_type, record_id) values ('exception_opened', $1, 'exceptions', $2)`, [people.sameer, ex.id]);
    await run(await at(1, "11:30"));
    expect(to("sameer").length).toBe(1);
    expect((await notes(`rule_key = 'exception_opened'`)).rows[0].channel).toBe("skipped:duplicate");
    for (const [d, t] of [[2, "09:10"], [2, "09:15"], [3, "09:30"]] as const) await run(await at(d, t));
    expect(to("ryan").filter((m) => m.text.startsWith("Still open after 24h")).length).toBe(1);
  });
});

describe("acceptance 3: shift hours", () => {
  const job = (type: string, title: string, owner: string, created: string) =>
    db.query(`insert into tech_jobs (type, title, owner_id, requested_by, created_at) values ($1, $2, $3, $4, $5)`, [type, title, owner, people.ryan, created]);

  it("holds a reminder triggered outside hours until the next shift start; an urgent one goes at once", async () => {
    const night = await at(1, "20:00");
    await job("build", "New landing page", people.sameer, plus(night, -5));
    await job("fix", "Leads not arriving", people.sameer, plus(night, -5));

    await run(night);
    expect(to("sameer").length).toBe(1);
    expect(to("sameer")[0].text).toContain("Leads not arriving");
    expect(to("sameer")[0].text).not.toContain("New landing page");
    const held = (await notes(`rule_key = 'tech_job_new' and sent_at is null`)).rows;
    expect(held.length).toBe(1);
    expect(held[0].held_until?.toISOString()).toBe(await at(2, "09:00"));

    await run(await at(1, "23:30"));
    await run(await at(2, "08:55"));
    expect(to("sameer").filter((m) => m.text.includes("New landing page"))).toEqual([]);

    await run(await at(2, "09:01"));
    expect(to("sameer").filter((m) => m.text.includes("New landing page")).length).toBe(1);
    await run(await at(2, "09:06"));
    expect(to("sameer").filter((m) => m.text.includes("New landing page")).length).toBe(1);
  });

  it("a held reminder for a job finished overnight is dropped, not sent", async () => {
    const night = await at(1, "20:00");
    await job("build", "Overnight job", people.sameer, plus(night, -5));
    await run(night);
    await db.query(`update tech_jobs set status = 'done' where title = 'Overnight job'`);
    await run(await at(2, "09:01"));
    expect(to("sameer").filter((m) => m.text.includes("Overnight job"))).toEqual([]);
    expect((await notes(`rule_key = 'tech_job_new'`)).rows[0].channel).toBe("skipped:resolved");
  });

  it("someone with no shift entered gets nothing except urgent rules", async () => {
    const noon = await at(1, "12:00");
    await job("build", "Media build", people.aditya, plus(noon, -5)); // Aditya has no shift
    await db.query(`insert into tasks (owner_id, title, due, source, category) values ($1, 'Check the ads', app_today() + 1, 'ryan', 'ads')`, [people.aditya]);
    await run(noon);
    expect(to("aditya")).toEqual([]);
    expect((await notes(`staff_id = $1`, [people.aditya])).rows).toEqual([]);
    await job("fix", "Ad account locked", people.aditya, plus(noon, -1));
    await run(plus(noon, 5));
    expect(to("aditya").length).toBe(1);
    expect(to("aditya")[0].text).toContain("Ad account locked");
  });

  it("the owner with no shift entered gets owner messages at their stated time (07:00 Europe/London)", async () => {
    const london = async (time: string) =>
      (await one<{ t: Date }>(`select (((now() at time zone 'Europe/London')::date + 1 + $1::time) at time zone 'Europe/London') as t`, [time])).t.toISOString();
    await run(await london("06:50"));
    expect(to("ryan")).toEqual([]);
    await run(await london("07:02"));
    expect(to("ryan").filter((m) => m.text.startsWith("Morning digest")).length).toBe(1);
    await run(await london("07:07"));
    await run(await london("18:00"));
    expect(to("ryan").filter((m) => m.text.startsWith("Morning digest")).length).toBe(1);
  });

  it("a shift override is respected: off sick for the day means no shift-start message", async () => {
    await db.query(`insert into shift_overrides (staff_id, date, kind) values ($1, app_today() + 1, 'sick')`, [people.sameer]);
    await db.query(`insert into tasks (owner_id, title, due, source, created_at) values ($1, 'Due on the sick day', app_today() + 1, 'ryan', now() - interval '3 days')`, [people.sameer]);
    await run(await at(1, "10:00"));
    expect(to("sameer")).toEqual([]);
  });

  it("a Slack failure leaves the reminder unsent for the next run", async () => {
    await db.query(`insert into tasks (owner_id, title, due, source, created_at) values ($1, 'Retry me', app_today() + 1, 'ryan', now() - interval '3 days')`, [people.sameer]);
    failSends = true;
    const r = await run(await at(1, "09:02"));
    expect(r.failed).toBeGreaterThan(0);
    expect((await notes(`staff_id = $1 and sent_at is not null`, [people.sameer])).rows).toEqual([]);
    failSends = false;
    await run(await at(1, "09:07"));
    expect(to("sameer").length).toBe(1);
  });
});

describe("exception DMs (delivery shared with the exceptions engine)", () => {
  const exception = async (type: string) => {
    const ex = await one<{ id: string }>(
      `insert into exceptions (type, owner_id, severity, reason, money_at_risk, dedupe_key) values ($1, $2, 'red', 'Zero Clinic: something is wrong', 5000, $1 || ':x') returning id`,
      [type, people.sameer]);
    await db.query(`insert into notifications (rule_key, staff_id, record_type, record_id) values ('exception_opened', $1, 'exceptions', $2)`, [people.sameer, ex.id]);
    return ex.id;
  };
  const deliver = (now: string) => deliverReminders({ rpc, send, appUrl: APP, now: new Date(now), rule: "exception_opened" });

  it("holds a non-urgent exception until the owner's shift, then sends it with Done / Snooze 1h", async () => {
    const id = await exception("ad_fatigue");
    expect(await deliver(await at(1, "20:00"))).toMatchObject({ sent: 0, held: 1 });
    expect(sent).toEqual([]);
    expect(await deliver(await at(2, "09:01"))).toMatchObject({ sent: 1, held: 0 });
    expect(sent[0].target).toBe("U_sameer");
    expect(sent[0].text).toContain("Zero Clinic: something is wrong");
    expect(sent[0].text).toContain("$5,000 at risk");
    expect(sent[0].text).toContain(`${APP}/overview?exception=${id}`);
    expect(JSON.stringify(sent[0].blocks)).toContain(`"value":"exceptions:${id}"`);
    expect(await deliver(await at(2, "09:06"))).toMatchObject({ sent: 0, held: 0 });
  });

  it("sends an urgent type at once, and never sends one resolved before the shift", async () => {
    await exception("zero_spend");
    expect(await deliver(await at(1, "20:00"))).toMatchObject({ sent: 1 });
    const id = await exception("ad_fatigue");
    await deliver(await at(1, "20:05"));
    await db.query(`update exceptions set status = 'resolved', resolved_at = now(), resolved_by = 'system' where id = $1`, [id]);
    await deliver(await at(2, "09:01"));
    expect(sent.length).toBe(1);
    expect((await notes(`record_id = $1`, [id])).rows[0].channel).toBe("skipped:resolved");
  });

  it("keeps waiting when the owner has no shift entered, and sends nothing while the rule is off", async () => {
    await db.query(`update staff set shift_start = null, shift_end = null where id = $1`, [people.sameer]);
    await exception("ad_fatigue");
    expect(await deliver(await at(1, "12:00"))).toMatchObject({ sent: 0, held: 1 });
    await shift("sameer");
    await enable("exception_opened", false);
    await deliver(await at(1, "12:05"));
    expect(sent).toEqual([]);
    await enable("exception_opened");
    expect(await deliver(await at(1, "12:10"))).toMatchObject({ sent: 1 });
  });
});

describe("Done and Snooze 1h", () => {
  const press = (who: string, actionId: string, value: string, blocks: Block[] = [], now?: string) =>
    handleInteraction(
      { type: "block_actions", user: { id: who }, actions: [{ action_id: actionId, value }], message: { text: "x", blocks } },
      { rpc, now: now ? new Date(now) : undefined });
  const task = async () =>
    (await one<{ id: string }>(`insert into tasks (owner_id, title, due, source, created_at) values ($1, 'Fix the form', app_today() + 1, 'ryan', now() - interval '3 days') returning id`, [people.sameer])).id;
  const status = async (table: string, id: string) => (await one<{ status: string }>(`select status from ${table} where id = $1`, [id])).status;

  it("Done on a task: the owner marks it done, the message says so, the audit trail names them", async () => {
    const id = await task();
    await run(await at(1, "09:02"));
    const reply = await press("U_sameer", "done", `tasks:${id}`, to("sameer")[0].blocks, await at(1, "09:10"));
    expect(reply.replace_original).toBe(true);
    expect(reply.text).toContain("Done by Sameer");
    expect(reply.blocks?.some((b) => b.type === "actions")).toBe(false);
    expect(JSON.stringify(reply.blocks)).toContain("Done by Sameer");
    expect(await status("tasks", id)).toBe("done");
    const audit = await one<{ actor: string }>(`select actor from audit_log where table_name = 'tasks' and row_id = $1 and field = 'status'`, [id]);
    expect(audit.actor).toBe("Sameer");
    const acked = (await notes(`record_id = $1`, [id])).rows;
    expect(acked.length).toBe(1);
    expect(acked[0].acknowledged_at).not.toBeNull();
  });

  it("refuses anyone but the task's owner or the app owner, plainly and privately", async () => {
    const id = await task();
    const refused = await press("U_amanda", "done", `tasks:${id}`);
    expect(refused).toMatchObject({ replace_original: false, response_type: "ephemeral" });
    expect(refused.text).toBe("Only the owner of this task can do that. Nothing was changed.");
    expect(await status("tasks", id)).toBe("todo");
    expect((await press("U_nobody", "done", `tasks:${id}`)).response_type).toBe("ephemeral");
    expect((await press("U_sameer", "delete", `tasks:${id}`)).response_type).toBe("ephemeral");
    expect((await press("U_sameer", "done", `staff:${id}`)).response_type).toBe("ephemeral");
    expect(await status("tasks", id)).toBe("todo");
    expect((await press("U_ryan", "done", `tasks:${id}`)).text).toContain("Done by Ryan");
    expect(await status("tasks", id)).toBe("done");
  });

  it("Snooze 1h on a task changes nothing but holds a new reminder for an hour", async () => {
    const id = await task();
    const t0 = await at(1, "09:02");
    await run(t0);
    const reply = await press("U_sameer", "snooze_1h", `tasks:${id}`, to("sameer")[0].blocks, plus(t0, 3));
    expect(reply.text).toContain("Snoozed 1h by Sameer");
    expect(await status("tasks", id)).toBe("todo");
    const row = (await notes(`rule_key = 'task_snoozed'`)).rows[0];
    expect(row.held_until?.toISOString()).toBe(plus(t0, 63));
    await run(plus(t0, 30));
    expect(to("sameer").length).toBe(1);
    await run(plus(t0, 65));
    expect(to("sameer").length).toBe(2);
    expect(to("sameer")[1].text).toContain("Snoozed task");
    expect(to("sameer")[1].text).toContain("Fix the form");
  });

  it("Done / Snooze on an exception: resolved or snoozed with the Slack note; refused for others", async () => {
    const make = async (key: string) =>
      (await one<{ id: string }>(`insert into exceptions (type, owner_id, severity, reason, dedupe_key) values ('ad_fatigue', $1, 'amber', 'Ad tired', $2) returning id`, [people.aditya, key])).id;
    const a = await make("a");
    const now = await at(1, "10:00");
    expect((await press("U_sameer", "done", `exceptions:${a}`)).text).toBe("Only the owner of this exception can do that. Nothing was changed.");
    expect(await status("exceptions", a)).toBe("open");

    await press("U_aditya", "snooze_1h", `exceptions:${a}`, [], now);
    const snoozed = await one<{ status: string; snoozed_until: Date; snooze_reason: string }>(`select status, snoozed_until, snooze_reason from exceptions where id = $1`, [a]);
    expect(snoozed).toMatchObject({ status: "snoozed", snooze_reason: "Snoozed from Slack" });
    expect(snoozed.snoozed_until.toISOString()).toBe(plus(now, 60));

    await press("U_aditya", "done", `exceptions:${a}`, [], now);
    const done = await one<{ status: string; resolved_by: string; resolution_note: string }>(`select status, resolved_by, resolution_note from exceptions where id = $1`, [a]);
    expect(done).toEqual({ status: "resolved", resolved_by: "Aditya", resolution_note: "Marked done from Slack" });
    expect((await press("U_aditya", "done", `exceptions:${a}`)).text).toContain("Already done");

    const b = await make("b");
    expect((await press("U_ryan", "done", `exceptions:${b}`)).text).toContain("Done by Ryan");
  });
});

describe("EOD reminders", () => {
  beforeEach(async () => {
    await shift("amanda");
  });

  it("eod_due: 30 minutes before the shift ends, again at the end, and not once it is filed", async () => {
    const eod = () => to("amanda").filter((m) => m.text.startsWith("EOD due"));
    await run(await at(1, "16:20"));
    expect(eod()).toEqual([]);
    await run(await at(1, "16:32"));
    await run(await at(1, "16:40"));
    expect(eod().length).toBe(1);
    expect(eod()[0].text).toContain("ends in 30 minutes");
    expect(eod()[0].text).toContain(`${APP}/eod`);
    await run(await at(1, "17:02")); // off shift by now: still sent
    await run(await at(1, "17:20"));
    expect(eod().length).toBe(2);
    expect(eod()[1].text).toContain("shift has ended");

    await db.query(`insert into eods (staff_id, date, answers) values ($1, app_today() + 2, '{}')`, [people.amanda]);
    await run(await at(2, "16:35"));
    await run(await at(2, "17:05"));
    expect(eod().length).toBe(2);
  });

  it("eod_missed: the person and the owner at the next shift start, only from the go-live date", async () => {
    const missed = (who: keyof TestPeople) => to(who).filter((m) => m.text.includes("EOD") && m.text.includes("missing"));
    await run(await at(1, "09:05"));
    expect(missed("amanda")).toEqual([]); // no go-live date yet
    expect(missed("ryan")).toEqual([]);

    await db.query(`update app_settings set value = to_jsonb((app_today() - 5)::text) where key = 'go_live_date'`);
    await run(await at(2, "09:05"));
    await run(await at(2, "09:10"));
    expect(missed("amanda").length).toBe(1);
    expect(missed("amanda")[0].text).toContain("Yesterday's EOD is missing");
    const owner = to("ryan").filter((m) => m.text.startsWith("Yesterday's EOD missing"));
    expect(owner.length).toBe(1);
    expect(owner[0].text).toContain("Amanda Harder");

    // Filed for the day before: nothing on the next shift.
    await db.query(`insert into eods (staff_id, date, answers) values ($1, app_today() + 2, '{}')`, [people.amanda]);
    await run(await at(3, "09:05"));
    expect(missed("amanda").length).toBe(1);
  });
});

describe("assignment, tech and launch rules", () => {
  it("task_assigned: a task someone else created goes to its owner, with who assigned it", async () => {
    const now = await at(1, "10:00");
    await db.query(`select set_config('app.actor', 'Ryan', false)`);
    await db.query(`insert into tasks (owner_id, title, due, source, created_at) values ($1, 'Assigned by Ryan', app_today() + 5, 'ryan', $2)`, [people.sameer, plus(now, -2)]);
    await db.query(`select set_config('app.actor', 'Sameer', false)`);
    await db.query(`insert into tasks (owner_id, title, source, created_at) values ($1, 'My own note', 'staff', $2)`, [people.sameer, plus(now, -2)]);
    await db.query(`select set_config('app.actor', '', false)`);
    await run(now);
    const dms = to("sameer").filter((m) => m.text.startsWith("New task"));
    expect(dms.length).toBe(1);
    expect(dms[0].text).toContain("Assigned by Ryan");
    expect(dms[0].text).toContain("from Ryan");
    expect(dms[0].text).not.toContain("My own note");
    await run(plus(now, 5));
    expect(to("sameer").filter((m) => m.text.startsWith("New task")).length).toBe(1);
  });

  it("tech_job_sla_warning: fires once 75% of a launch job's 48h is used, with the time left", async () => {
    await db.query(`insert into tech_jobs (type, title, owner_id, requested_at, created_at) values
      ('launch', 'Launch at 80 percent', $1, now() - interval '38 hours 24 minutes', now() - interval '3 days'),
      ('launch', 'Launch at 50 percent', $1, now() - interval '24 hours', now() - interval '3 days')`, [people.sameer]);
    const rows = (await db.query<{ rule_key: string; payload: { title: string; minutes_left: number } }>(
      `select rule_key, payload from reminder_candidates() where rule_key like 'tech_job_sla%'`)).rows;
    expect(rows.length).toBe(1);
    expect(rows[0].rule_key).toBe("tech_job_sla_warning");
    expect(rows[0].payload.title).toBe("Launch at 80 percent");
    expect(Number(rows[0].payload.minutes_left)).toBeGreaterThan(570);
    expect(Number(rows[0].payload.minutes_left)).toBeLessThanOrEqual(576);
  });

  it("launch_sla_warning: at 24h and at 6h left, naming the stage and the QC boxes still open", async () => {
    const c = (await one<{ id: string }>(`insert into clients (name, stage) values ('Launch Clinic', 'onboarding') returning id`)).id;
    const l = (await one<{ id: string }>(
      `insert into launches (client_id, owner_id, paid_at, ob_form_done_at, access_done_at, qc_lead_access, qc_pixel_firing)
       values ($1, $2, now() - interval '3 days', now() - interval '30 hours', now() - interval '30 hours', true, true) returning id`, [c, people.sameer])).id;
    const rows = async () => (await db.query<{ window_key: string; payload: { client: string; stage: string; qc_left: string[]; hours_left: number } }>(
      `select window_key, payload from reminder_candidates() where rule_key = 'launch_sla_warning'`)).rows;
    let r = await rows();
    expect(r.length).toBe(1);
    expect(r[0].window_key).toBe("24h");
    expect(r[0].payload).toMatchObject({ client: "Launch Clinic", stage: "access_granted" });
    expect(r[0].payload.qc_left).toEqual(["calendar tested", "test lead deleted", "Cortana connected", "clinic sheet"]);
    expect(Number(r[0].payload.hours_left)).toBe(18);
    await db.query(`update launches set ob_form_done_at = now() - interval '44 hours', access_done_at = now() - interval '44 hours' where id = $1`, [l]);
    r = await rows();
    expect(r[0].window_key).toBe("6h");
    // Before the clock starts, and once paused, there is nothing to warn about.
    await db.query(`insert into sla_pauses (launch_id, reason, evidence_note, paused_by) values ($1, 'client_access', 'Asked in Slack', $2)`, [l, people.sameer]);
    expect(await rows()).toEqual([]);
  });
});

describe("owner rules", () => {
  const london = async (dayOffset: number, time: string) =>
    (await one<{ t: Date }>(`select (((now() at time zone 'Europe/London')::date + $1::int + $2::time) at time zone 'Europe/London') as t`, [dayOffset, time])).t.toISOString();
  const candidates = async (rule: string, now: string) =>
    (await db.query<{ window_key: string; payload: Record<string, unknown> }>(
      `select window_key, payload from reminder_candidates($2::timestamptz) where rule_key = $1 order by window_key`, [rule, now])).rows;

  it("renewal_due: 7, 3 and 1 days before, daily once overdue, with the month's results", async () => {
    // days_until is read from the real clock, so the test asks at today's 07:30 London.
    const now = await london(0, "07:30");
    const mk = (name: string, daysUntil: number) =>
      db.query(`insert into clients (name, stage, billing_cycle, cycle_fee, launch_date) values ($1, 'live', '30', 4000, app_today() - (30 - $2::int))`, [name, daysUntil]);
    for (const [n, d] of [["In seven", 7], ["In five", 5], ["In three", 3], ["Tomorrow", 1]] as const) await mk(n, d);
    await db.query(`insert into clients (name, stage, billing_cycle, cycle_fee, launch_date) values ('Lapsed', 'live', '30', 2500, app_today() - 33)`);
    const rows = await candidates("renewal_due", now);
    expect(rows.map((r) => r.payload.client).sort()).toEqual(["In seven", "In three", "Lapsed", "Tomorrow"]);
    const lapsed = rows.find((r) => r.payload.client === "Lapsed")!;
    expect(lapsed.payload).toMatchObject({ status: "overdue", amount: 2500 });
    expect(lapsed.window_key).toContain(":overdue:");
    expect((await candidates("renewal_due", await london(0, "06:30")))).toEqual([]);

    await run(now);
    const dm = to("ryan").filter((m) => m.text.startsWith("Renewal"));
    expect(dm.length).toBe(1);
    expect(dm[0].text).toContain("In seven");
    expect(dm[0].text).toContain("$4,000");
    expect(dm[0].text).toContain("This month: spend");
    await run(plus(now, 5));
    expect(to("ryan").filter((m) => m.text.startsWith("Renewal")).length).toBe(1);
  });

  it("guarantee_deadline: 14 and 7 days before, with target, revenue and gap", async () => {
    const now = await london(0, "07:30");
    const today = `(now() at time zone 'Europe/London')::date`;
    await db.query(`insert into clients (name, stage, guarantee_target_amount, guarantee_deadline) values
      ('Fourteen', 'live', 30000, ${today} + 14), ('Ten', 'live', 30000, ${today} + 10), ('Seven', 'live', 20000, ${today} + 7)`);
    const rows = await candidates("guarantee_deadline", now);
    expect(rows.map((r) => r.payload.client).sort()).toEqual(["Fourteen", "Seven"]);
    expect(rows.find((r) => r.payload.client === "Seven")!.payload).toMatchObject({ target: 20000, revenue: 0, gap: 20000, days_until: 7 });
  });

  it("prospect_follow_up: the morning of the date and daily while overdue; never after it is closed", async () => {
    const today = `(now() at time zone 'Europe/London')::date`;
    await db.query(`insert into prospects (name, promised, follow_up_date, stage) values
      ('Due Clinic', 'Send the case study', ${today}, 'chase'),
      ('Late Clinic', 'Call back', ${today} - 2, 'contract_out'),
      ('Future Clinic', null, ${today} + 1, 'chase'),
      ('Dead Clinic', null, ${today} - 9, 'dead')`);
    await db.query(`insert into prospect_contacts (prospect_id, contact) select id, 'dr@due.test 555-0100' from prospects where name = 'Due Clinic'`);
    await run(await london(0, "07:10"));
    const dm = to("ryan").filter((m) => m.text.startsWith("Prospect follow-up"));
    expect(dm.length).toBe(1);
    expect(dm[0].text).toContain("Due Clinic");
    expect(dm[0].text).toContain("promised: Send the case study");
    expect(dm[0].text).toContain("Late Clinic");
    expect(dm[0].text).toContain("2 days overdue");
    expect(dm[0].text).not.toContain("Future Clinic");
    expect(dm[0].text).not.toContain("Dead Clinic");
    expect(JSON.stringify(dm[0])).not.toContain("555-0100");
    await run(await london(0, "12:00"));
    expect(to("ryan").filter((m) => m.text.startsWith("Prospect follow-up")).length).toBe(1);
    await run(await london(1, "07:10"));
    expect(to("ryan").filter((m) => m.text.startsWith("Prospect follow-up")).length).toBe(2);
  });

  it("sync_failure: once when a source that has synced before turns stale; never for one that has not synced", async () => {
    const now = await london(0, "12:00");
    await run(now);
    expect(to("ryan").filter((m) => m.text.startsWith("Sync failure"))).toEqual([]); // nothing has ever synced
    await db.query(`update integration_sync_status set last_success_at = now() - interval '5 hours', status = 'error', error = 'HTTP 500' where source = 'cortana'`);
    await run(plus(now, 5));
    await run(plus(now, 10));
    const dm = to("ryan").filter((m) => m.text.startsWith("Sync failure"));
    expect(dm.length).toBe(1);
    expect(dm[0].text).toContain("cortana");
    expect(dm[0].text).toContain("HTTP 500");
    // Recovers, then fails again: a new spell, a new message.
    await db.query(`update integration_sync_status set last_success_at = now() - interval '4 hours' where source = 'cortana'`);
    await run(plus(now, 15));
    expect(to("ryan").filter((m) => m.text.startsWith("Sync failure")).length).toBe(2);
  });

  it("morning digest: money at risk, bottlenecks, overdue follow-ups, stale sources; attendance only when its view exists", async () => {
    await db.query(`insert into exceptions (type, owner_id, severity, reason, money_at_risk, dedupe_key) values
      ('zero_spend', $1, 'red', 'Alpha: $0 spend', 5000, 'k1'), ('ad_fatigue', $1, 'amber', 'Beta: ad tired', 1500, 'k2')`, [people.aditya]);
    await db.query(`update integration_sync_status set last_success_at = now() - interval '2 days', error = 'timeout' where source = 'whop'`);
    await run(await london(1, "07:05"));
    let digest = to("ryan").filter((m) => m.text.startsWith("Morning digest"));
    expect(digest.length).toBe(1);
    expect(digest[0].text).toContain("$6,500 at risk");
    expect(digest[0].text).toContain("Alpha: $0 spend");
    expect(digest[0].text).toContain("Sync failures");
    expect(digest[0].text).toContain("whop");
    expect(digest[0].text).not.toContain("Attendance this week");

    await db.query(`create view attendance_week_flags as
      select $1::uuid as staff_id, 'Amanda Harder'::text as name, app_week_start(app_today()) as week_start, 3 as late_count, 1 as no_show_count`.replace("$1", `'${people.amanda}'`));
    await run(await london(2, "07:05"));
    digest = to("ryan").filter((m) => m.text.startsWith("Morning digest"));
    expect(digest.length).toBe(2);
    expect(digest[1].text).toContain("Attendance this week");
    expect(digest[1].text).toContain("Amanda Harder · 3 lates, 1 no-show");
  });

  it("weekly_scorecard: Monday 09:00 ET, last week's scores, each person their own and the owner everyone's", async () => {
    await enable("weekly_scorecard");
    const monday = async (time: string) =>
      (await one<{ t: Date }>(`select ((app_week_start(app_today()) + 7 + $1::time) at time zone 'America/New_York') as t`, [time])).t.toISOString();
    const rows = async (now: string) =>
      (await db.query<{ staff_id: string; window_key: string; payload: { people: { name: string; metrics: unknown[] }[] } }>(
        `select staff_id, window_key, payload from reminder_candidates($1::timestamptz) where rule_key = 'weekly_scorecard'`, [now])).rows;
    expect(await rows(await monday("08:59"))).toEqual([]);
    const due = await rows(await monday("09:01"));
    const scored = (await db.query<{ staff_id: string }>(
      `select distinct staff_id from person_scores_weekly where week_start = app_week_start(app_today())`)).rows.map((r) => r.staff_id);
    expect(due.filter((r) => r.staff_id !== people.ryan).map((r) => r.staff_id).sort()).toEqual([...scored].sort());
    if (scored.length) {
      const owner = due.find((r) => r.staff_id === people.ryan)!;
      expect(owner.payload.people.length).toBe(scored.length);
      expect(owner.payload.people[0].metrics.length).toBeGreaterThan(0);
    }
  });
});

describe("patient reminders (seeded off)", () => {
  beforeEach(async () => {
    await shift("amanda");
    const clinic = (await one<{ id: string }>(`insert into clients (name, stage, pod, slack_general_id) values ('Pivot Clinic', 'live', 'pod_2', 'C_PIVOT') returning id`)).id;
    const lead = async (name: string, email: string, ghl: string) =>
      (await one<{ id: string }>(`insert into leads (client_id, ghl_contact_id, name, email, created_at) values ($1, $2, $3, $4, now()) returning id`, [clinic, ghl, name, email])).id;
    const jane = await lead("Jane Doe-Smithson", "jane.smithson@mail.invalid", "g1");
    const omar = await lead("Omar Khalidi", "omar.k@mail.invalid", "g2");
    await db.query(`insert into appointments (client_id, lead_id, scheduled_for, attendance) values
      ($1, $2, (app_today() + 1 + time '14:00') at time zone 'America/New_York', 'scheduled'),
      ($1, $3, (app_today() - 3 + time '11:00') at time zone 'America/New_York', 'scheduled'),
      ($1, $3, (app_today() - 3 + time '12:00') at time zone 'America/New_York', 'showed')`, [clinic, jane, omar]);
  });

  it("send nothing while disabled", async () => {
    await run(await at(0, "15:30"));
    expect(to("amanda")).toEqual([]);
    expect(sent.filter((m) => m.target === "C_PIVOT")).toEqual([]);
    expect((await notes(`rule_key in ('unconfirmed_tomorrow', 'outcome_overdue', 'lead_not_called')`)).rows).toEqual([]);
  });

  it("the CSR outcome and unconfirmed reminders are retired: they cannot be enabled, so nothing is ever sent", async () => {
    await expect(enable("unconfirmed_tomorrow")).rejects.toThrow(/reminder_rules_retired/);
    await expect(enable("outcome_overdue")).rejects.toThrow(/reminder_rules_retired/);
    await run(await at(0, "15:30"));
    await run(await at(0, "15:35"));
    expect(to("amanda")).toEqual([]);
    expect(sent.filter((m) => m.target === "C_PIVOT")).toEqual([]);
    expect((await notes(`rule_key in ('unconfirmed_tomorrow', 'outcome_overdue')`)).rows).toEqual([]);
  });
});
