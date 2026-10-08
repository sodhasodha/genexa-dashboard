import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { AUTH, asUser, freshDb, seedStaff, type TestPeople } from "./db";
import { pgliteRpc } from "./rpc";
import { runReminders, type Rpc, type SendResult } from "@/lib/reminders/engine";
import { handleInteraction } from "@/lib/reminders/interaction";
import type { Block } from "@/lib/reminders/compose";
import type { RouteResult } from "@/lib/router/process";

// Task deadlines to the minute (0047): the rule, the views, the reminders, the router,
// the tech override and the scorecard. One database; each test starts from empty tables.
let db: PGlite;
let people: TestPeople;
let sent: { target: string; text: string; blocks: Block[] }[];

const APP = "https://ops.test";
const rpc: Rpc = async <T>(fn: string, args: Record<string, unknown> = {}) => {
  const keys = Object.keys(args);
  const r = await db.query<{ r: T }>(`select ${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]));
  return r.rows[0].r;
};
const send = async (target: string, text: string, blocks: Block[] = []): Promise<SendResult> => {
  sent.push({ target, text, blocks });
  return { ok: true, ts: `${sent.length}.000`, channel: `D_${target}` };
};
const run = (now: string) => runReminders({ rpc, send, appUrl: APP, now: new Date(now) });
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const all = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
/** An instant: ET day (today + offset) at HH:MM ET. */
const at = async (dayOffset: number, time: string) =>
  (await one<{ t: Date }>(`select ((app_today() + $1::int + $2::time) at time zone 'America/New_York') as t`, [dayOffset, time])).t.toISOString();
const to = (who: keyof TestPeople, starts: string) => sent.filter((m) => m.target === `U_${who}` && m.text.startsWith(starts));
const shift = (who: keyof TestPeople, start = "09:00", end = "17:00") =>
  db.query(`update staff set shift_start = $2, shift_end = $3, working_days = '{1,2,3,4,5,6,7}' where id = $1`, [people[who], start, end]);
/** A task with a deadline, created three days ago (so "new task" reminders stay out of the way). */
const task = async (who: keyof TestPeople, title: string, dueAt: string, extra: { created?: string; category?: string } = {}) =>
  (await one<{ id: string }>(
    `insert into tasks (owner_id, title, due_at, source, category, created_at) values ($1, $2, $3, 'ryan', $4, coalesce($5::timestamptz, now() - interval '3 days')) returning id`,
    [people[who], title, dueAt, extra.category ?? (who === "aditya" ? "ads" : "general"), extra.created ?? null])).id;
const queued = (where: string, params: unknown[] = []) =>
  all<{ rule_key: string; window_key: string; sent_at: Date | null; held_until: Date | null; channel: string | null }>(
    `select rule_key, window_key, sent_at, held_until, channel from notifications where ${where} order by created_at, rule_key`, params);

beforeAll(async () => {
  db = await freshDb();
});

beforeEach(async () => {
  await db.exec(`
    truncate staff, clients, client_requests, slack_people, tasks, deleted_tasks, tech_jobs, exceptions, touches, notifications, audit_log cascade;
    update reminder_rules set enabled = false where key = 'weekly_scorecard';
    update app_settings set value = null where key = 'go_live_date';
    select set_config('app.actor', '', false);`);
  people = await seedStaff(db);
  sent = [];
  await db.query(`update staff set slack_user_id = 'U_' || split_part(email, '@', 1)`);
});

describe("who has timed deadlines", () => {
  it("is decided by role: the media buyer and the tech person, nobody else", async () => {
    const rows = await all<{ name: string; timed_deadlines: boolean }>(`select name, timed_deadlines from task_owners order by name`);
    expect(Object.fromEntries(rows.map((r) => [r.name, r.timed_deadlines]))).toEqual({
      Aditya: true, "Amanda Harder": false, "Marjorie Grace Villarino": false, Ryan: false, Sameer: true,
    });
  });
});

describe("the deadline is required for timed-deadline staff", () => {
  it("a person cannot add their task without a date and time; with one, the date follows it", async () => {
    await asUser(db, AUTH.ryan, async () => {
      await expect(db.query(`insert into tasks (owner_id, title, source) values ($1, 'No deadline', 'ryan')`, [people.sameer])).rejects.toThrow(/TASK_DEADLINE_REQUIRED/);
      // A date alone is not enough from a person.
      await expect(db.query(`insert into tasks (owner_id, title, source, due) values ($1, 'Date only', 'ryan', app_today() + 1)`, [people.sameer])).rejects.toThrow(/TASK_DEADLINE_REQUIRED/);
      await expect(db.query(`insert into tasks (owner_id, title, source, category) values ($1, 'Ads, no deadline', 'ryan', 'ads')`, [people.aditya])).rejects.toThrow(/TASK_DEADLINE_REQUIRED/);
      await db.query(`insert into tasks (owner_id, title, source, due_at) values ($1, 'With deadline', 'ryan', '2026-10-14T14:00:00Z')`, [people.sameer]);
    });
    // 14:00 UTC is 10:00 ET on the 14th; 03:00 UTC is still the 13th in ET.
    expect((await one<{ due: string }>(`select due::text from tasks where title = 'With deadline'`)).due).toBe("2026-10-14");
    await db.query(`insert into tasks (owner_id, title, source, due_at) values ($1, 'Early hours', 'ryan', '2026-10-14T03:00:00Z')`, [people.sameer]);
    expect((await one<{ due: string }>(`select due::text from tasks where title = 'Early hours'`)).due).toBe("2026-10-13");
  });

  it("is optional for everyone else: no date, a date, or a date and time", async () => {
    await asUser(db, AUTH.ryan, async () => {
      await db.query(`insert into tasks (owner_id, title, source) values ($1, 'Ryan, no date', 'ryan')`, [people.ryan]);
      await db.query(`insert into tasks (owner_id, title, source, due) values ($1, 'Ryan, date', 'ryan', '2026-10-14')`, [people.ryan]);
      await db.query(`insert into tasks (owner_id, title, source, due_at) values ($1, 'Amanda, timed', 'ryan', '2026-10-14T14:00:00Z')`, [people.amanda]);
    });
    const rows = await all<{ title: string; due: string | null; has_time: boolean }>(`select title, due::text, due_at is not null as has_time from tasks order by title`);
    expect(rows).toEqual([
      { title: "Amanda, timed", due: "2026-10-14", has_time: true },
      { title: "Ryan, date", due: "2026-10-14", has_time: false },
      { title: "Ryan, no date", due: null, has_time: false },
    ]);
  });

  it("server-side callers never fail: a date becomes 17:00 in the owner's timezone, nothing becomes the end of their next shift", async () => {
    await db.query(`update staff set timezone = 'Asia/Karachi' where id = $1`, [people.sameer]);
    await db.query(`insert into tasks (owner_id, title, source, due) values ($1, 'Claude, date', 'claude', '2026-10-14')`, [people.sameer]);
    await db.query(`insert into tasks (owner_id, title, source) values ($1, 'Claude, nothing', 'claude')`, [people.sameer]);
    const dated = await one<{ due_at: Date; due: string }>(`select due_at, due::text from tasks where title = 'Claude, date'`);
    expect(dated.due_at.toISOString()).toBe("2026-10-14T12:00:00.000Z"); // 17:00 in Karachi
    expect(dated.due).toBe("2026-10-14");
    const bare = await one<{ same: boolean; due_matches: boolean }>(
      `select due_at = staff_next_shift_end(owner_id) as same, due = app_day(due_at) as due_matches from tasks where title = 'Claude, nothing'`);
    expect(bare).toEqual({ same: true, due_matches: true });
    // A task that is already done, or imported from the old board, is left as it is.
    await db.query(`insert into tasks (owner_id, title, source, status) values ($1, 'Done already', 'ryan', 'done')`, [people.sameer]);
    await db.query(`insert into tasks (owner_id, title, source, legacy_ref) values ($1, 'Old board', 'ryan', 'legacy-1')`, [people.sameer]);
    expect(await all(`select title from tasks where due_at is null order by title`)).toEqual([{ title: "Done already" }, { title: "Old board" }]);
  });

  it("the staff member can always change status and group on their own task, even an old one with no deadline", async () => {
    const old = (await one<{ id: string }>(`insert into tasks (owner_id, title, source, legacy_ref) values ($1, 'Old, no deadline', 'ryan', 'legacy-2') returning id`, [people.sameer])).id;
    await asUser(db, AUTH.sameer, async () => {
      expect((await db.query(`update tasks set status = 'doing' where id = $1 returning id`, [old])).rows.length).toBe(1);
      expect((await db.query(`update tasks set task_group = 'today' where id = $1 returning id`, [old])).rows.length).toBe(1);
      expect((await db.query<{ task_group: string }>(`update tasks set status = 'done' where id = $1 returning task_group`, [old])).rows[0].task_group).toBe("done");
      expect((await db.query(`update tasks set status = 'todo' where id = $1 returning id`, [old])).rows.length).toBe(1);
      // Still only status: the existing rule is unchanged.
      await expect(db.query(`update tasks set title = 'Renamed' where id = $1`, [old])).rejects.toThrow(/TASK_STATUS_ONLY/);
    });
    expect((await one<{ due_at: Date | null }>(`select due_at from tasks where id = $1`, [old])).due_at).toBeNull();
  });

  it("an old task with no deadline is asked for one the next time a person edits it; deleting and notes are not edits", async () => {
    const old = (await one<{ id: string }>(`insert into tasks (owner_id, title, source, legacy_ref) values ($1, 'Old, no deadline', 'ryan', 'legacy-3') returning id`, [people.sameer])).id;
    const other = (await one<{ id: string }>(`insert into tasks (owner_id, title, source, legacy_ref) values ($1, 'Old, to delete', 'ryan', 'legacy-4') returning id`, [people.sameer])).id;
    const timed = (await one<{ id: string }>(`insert into tasks (owner_id, title, source, due_at) values ($1, 'Has one', 'ryan', now() + interval '2 days') returning id`, [people.sameer])).id;
    await asUser(db, AUTH.ryan, async () => {
      await expect(db.query(`update tasks set title = 'Renamed' where id = $1`, [old])).rejects.toThrow(/TASK_DEADLINE_REQUIRED/);
      await db.query(`update tasks set title = 'Renamed', due_at = now() + interval '1 day' where id = $1`, [old]);
      // The router adding a line, a priority bump and a soft delete all go through.
      await db.query(`update tasks set notes = 'Also asked Tue', priority = 'high' where id = $1`, [other]);
      await db.query(`update tasks set deleted_at = now() where id = $1`, [other]);
      // A deadline cannot be taken away again.
      await expect(db.query(`update tasks set due_at = null where id = $1`, [timed])).rejects.toThrow(/TASK_DEADLINE_REQUIRED/);
      await expect(db.query(`update tasks set due_at = null, due = null where id = $1`, [timed])).rejects.toThrow(/TASK_DEADLINE_REQUIRED/);
      // Moving a task onto a timed-deadline list needs one too.
      const mine = (await db.query<{ id: string }>(`insert into tasks (owner_id, title, source) values ($1, 'Ryan to hand over', 'ryan') returning id`, [people.ryan])).rows[0].id;
      await expect(db.query(`update tasks set owner_id = $2 where id = $1`, [mine, people.sameer])).rejects.toThrow(/TASK_DEADLINE_REQUIRED/);
      await db.query(`update tasks set owner_id = $2, due_at = now() + interval '1 day' where id = $1`, [mine, people.sameer]);
    });
    expect((await one<{ n: number }>(`select count(*)::int as n from tasks where owner_id = $1 and deleted_at is null and due_at is null`, [people.sameer])).n).toBe(0);
  });

  it("keeps the date in step when the deadline moves, and gives a moved date a time", async () => {
    const id = (await one<{ id: string }>(`insert into tasks (owner_id, title, source, due_at) values ($1, 'Moves', 'ryan', '2026-10-14T14:00:00Z') returning id`, [people.sameer])).id;
    await db.query(`update tasks set due_at = '2026-10-20T20:00:00Z' where id = $1`, [id]);
    expect((await one<{ due: string }>(`select due::text from tasks where id = $1`, [id])).due).toBe("2026-10-20");
    // A caller that only knows dates (the MCP): 17:00 that day in the owner's timezone (New York here).
    await db.query(`update tasks set due = '2026-10-22' where id = $1`, [id]);
    expect((await one<{ due_at: Date }>(`select due_at from tasks where id = $1`, [id])).due_at.toISOString()).toBe("2026-10-22T21:00:00.000Z");
  });
});

describe("overdue to the minute, and the order of a list", () => {
  it("a timed task is overdue the minute its deadline passes; a date-only task at the end of its day", async () => {
    await db.query(
      `insert into tasks (owner_id, title, source, due_at) values
         ($1, 'A minute ago', 'ryan', now() - interval '90 seconds'),
         ($1, 'In a minute', 'ryan', now() + interval '90 seconds'),
         ($1, 'Three hours ago', 'ryan', now() - interval '3 hours 1 minute')`, [people.sameer]);
    await db.query(`insert into tasks (owner_id, title, source, due_at, status) values ($1, 'Late but done', 'ryan', now() - interval '2 days', 'done')`, [people.sameer]);
    await db.query(`insert into tasks (owner_id, title, source, due) values ($1, 'Day: today', 'ryan', app_today()), ($1, 'Day: yesterday', 'ryan', app_today() - 1), ($1, 'Day: none', 'ryan', null)`, [people.amanda]);
    const rows = await all<{ title: string; is_overdue: boolean; minutes_to_deadline: number | null }>(`select title, is_overdue, minutes_to_deadline from task_list order by title`);
    const by = Object.fromEntries(rows.map((r) => [r.title, r]));
    expect(by["A minute ago"]).toMatchObject({ is_overdue: true, minutes_to_deadline: -2 });
    expect(by["In a minute"]).toMatchObject({ is_overdue: false, minutes_to_deadline: 1 });
    expect(by["Three hours ago"]).toMatchObject({ is_overdue: true, minutes_to_deadline: -182 });
    expect(by["Late but done"]).toMatchObject({ is_overdue: false, minutes_to_deadline: null });
    expect(by["Day: today"]).toMatchObject({ is_overdue: false, minutes_to_deadline: null });
    expect(by["Day: yesterday"]).toMatchObject({ is_overdue: true, minutes_to_deadline: null });
    expect(by["Day: none"]).toMatchObject({ is_overdue: false, minutes_to_deadline: null });

    const owners = await all<{ name: string; overdue_tasks: number }>(`select name, overdue_tasks::int from task_owners where name in ('Sameer', 'Amanda Harder') order by name`);
    expect(owners).toEqual([{ name: "Amanda Harder", overdue_tasks: 1 }, { name: "Sameer", overdue_tasks: 2 }]);
  });

  it("sorts by deadline: most overdue first, then due soonest, then tasks without one", async () => {
    await db.query(
      `insert into tasks (owner_id, title, source, due_at, priority) values
         ($1, 'Due in 2 hours', 'ryan', now() + interval '2 hours', 'high'),
         ($1, 'Overdue 1 hour', 'ryan', now() - interval '1 hour', 'low'),
         ($1, 'Due in 3 days', 'ryan', now() + interval '3 days', 'high'),
         ($1, 'Overdue 3 days', 'ryan', now() - interval '3 days', 'medium')`, [people.sameer]);
    await db.query(`insert into tasks (owner_id, title, source, legacy_ref) values ($1, 'No deadline', 'ryan', 'legacy-5')`, [people.sameer]);
    const rows = await all<{ title: string }>(`select title from task_list where owner_id = $1 order by deadline_at asc nulls last, created_at`, [people.sameer]);
    expect(rows.map((r) => r.title)).toEqual(["Overdue 3 days", "Overdue 1 hour", "Due in 2 hours", "Due in 3 days", "No deadline"]);
  });

  it("carries the owner's timezone for the list, Europe/London when there is none", async () => {
    await db.query(`update staff set timezone = 'Asia/Kolkata' where id = $1`, [people.sameer]);
    await db.query(`insert into tasks (owner_id, title, source, due_at) values ($1, 'Zoned', 'ryan', now() + interval '1 day')`, [people.sameer]);
    expect((await one<{ owner_timezone: string }>(`select owner_timezone from task_list where title = 'Zoned'`)).owner_timezone).toBe("Asia/Kolkata");
    expect((await one<{ timezone: string }>(`select timezone from task_owners where owner_id = $1`, [people.sameer])).timezone).toBe("Asia/Kolkata");
    expect((await one<{ tz: string }>(`select staff_tz(gen_random_uuid()) as tz`)).tz).toBe("Europe/London");
  });
});

describe("the end of the person's next shift", () => {
  const nextEnd = async (who: keyof TestPeople, now: string) =>
    (await one<{ t: Date }>(`select staff_next_shift_end($1, $2::timestamptz) as t`, [people[who], now])).t.toISOString();

  it("is the shift in progress when two hours of it are left, otherwise the one after; a day off is skipped", async () => {
    await shift("sameer");
    expect(await nextEnd("sameer", await at(1, "10:00"))).toBe(await at(1, "17:00"));
    expect(await nextEnd("sameer", await at(1, "15:00"))).toBe(await at(1, "17:00"));
    expect(await nextEnd("sameer", await at(1, "15:01"))).toBe(await at(2, "17:00"));
    expect(await nextEnd("sameer", await at(1, "20:00"))).toBe(await at(2, "17:00"));
    await db.query(`insert into shift_overrides (staff_id, date, kind) values ($1, app_today() + 2, 'sick')`, [people.sameer]);
    expect(await nextEnd("sameer", await at(1, "20:00"))).toBe(await at(3, "17:00"));
  });

  it("with no shift entered: the next weekday 17:00 in their timezone that is two hours away", async () => {
    await db.query(`update staff set timezone = 'Europe/London' where id = $1`, [people.aditya]);
    // Friday 23 Oct 2026 is BST; the clocks go back on Sunday 25th, so Monday 17:00 is GMT.
    expect(await nextEnd("aditya", "2026-10-23T09:00:00Z")).toBe("2026-10-23T16:00:00.000Z");
    expect(await nextEnd("aditya", "2026-10-23T14:30:00Z")).toBe("2026-10-26T17:00:00.000Z");
    expect(await nextEnd("aditya", "2026-10-24T10:00:00Z")).toBe("2026-10-26T17:00:00.000Z");
    await db.query(`update staff set timezone = 'Asia/Karachi' where id = $1`, [people.aditya]);
    expect(await nextEnd("aditya", "2026-10-21T05:00:00Z")).toBe("2026-10-21T12:00:00.000Z");
  });
});

describe("deadline reminders", () => {
  beforeEach(async () => {
    await shift("sameer");
  });

  it("due in 2h once, overdue once at the deadline, then one DM to the owner a day later", async () => {
    const id = await task("sameer", "Rebuild the calendar", await at(1, "15:00"));
    await run(await at(1, "12:55"));
    expect(to("sameer", "Due in 2h")).toEqual([]);

    await run(await at(1, "13:02"));
    for (const t of ["13:10", "14:00", "14:58"]) await run(await at(1, t));
    expect(to("sameer", "Due in 2h").length).toBe(1);
    expect(to("sameer", "Due in 2h")[0].text).toContain("Rebuild the calendar");
    expect(to("sameer", "Due in 2h")[0].text).toContain("15:00 EDT");
    expect(JSON.stringify(to("sameer", "Due in 2h")[0].blocks)).toContain(`tasks:${id}`);
    expect(to("sameer", "Overdue")).toEqual([]);

    await run(await at(1, "15:01"));
    for (const t of ["15:06", "16:30"]) await run(await at(1, t));
    await run(await at(2, "11:00"));
    expect(to("sameer", "Overdue").length).toBe(1);
    expect(to("sameer", "Overdue")[0].text).toContain("Rebuild the calendar");
    expect(to("sameer", "Overdue")[0].text).toContain("was due");
    expect(to("ryan", "Task still open a day after its deadline")).toEqual([]);

    await run(await at(2, "15:02"));
    for (const [d, t] of [[2, "15:10"], [3, "09:30"], [3, "15:30"], [5, "12:00"]] as const) await run(await at(d, t));
    const owner = to("ryan", "Task still open a day after its deadline");
    expect(owner.length).toBe(1);
    expect(owner[0].text).toContain("Rebuild the calendar");
    expect(owner[0].text).toContain("Sameer");
    expect(owner[0].text).toContain(`${APP}/tasks?task=${id}`);
    // The older "still open after 24h" escalation leaves timed tasks to this rule: one DM, not two.
    expect(to("ryan", "Still open after 24h")).toEqual([]);
    // Each was one row, keyed on the deadline.
    const rows = await queued(`record_id = $1 and rule_key in ('task_due_2h', 'task_overdue', 'task_overdue_24h')`, [id]);
    expect(rows.map((r) => r.rule_key).sort()).toEqual(["task_due_2h", "task_overdue", "task_overdue_24h"]);
  });

  it("nothing more once the task is done: no overdue, no owner DM; Done on the reminder works", async () => {
    const id = await task("sameer", "Send the Loom", await at(1, "15:00"));
    await run(await at(1, "13:05"));
    const reply = await handleInteraction(
      { type: "block_actions", user: { id: "U_sameer" }, actions: [{ action_id: "done", value: `tasks:${id}` }], message: { text: "x", blocks: to("sameer", "Due in 2h")[0].blocks } },
      { rpc, now: new Date(await at(1, "13:10")) });
    expect(reply.text).toContain("Done by Sameer");
    expect((await one<{ status: string }>(`select status from tasks where id = $1`, [id])).status).toBe("done");
    for (const [d, t] of [[1, "15:05"], [2, "15:05"]] as const) await run(await at(d, t));
    expect(to("sameer", "Overdue")).toEqual([]);
    expect(to("ryan", "Task still open a day after its deadline")).toEqual([]);
  });

  it("Snooze 1h on a deadline reminder still holds a fresh one for an hour", async () => {
    const id = await task("sameer", "Check the pixel", await at(1, "16:30"));
    const t0 = await at(1, "14:35");
    await run(t0);
    const reply = await handleInteraction(
      { type: "block_actions", user: { id: "U_sameer" }, actions: [{ action_id: "snooze_1h", value: `tasks:${id}` }], message: { text: "x", blocks: to("sameer", "Due in 2h")[0].blocks } },
      { rpc, now: new Date(t0) });
    expect(reply.text).toContain("Snoozed 1h by Sameer");
    await run(await at(1, "15:00"));
    expect(to("sameer", "Snoozed task")).toEqual([]);
    await run(await at(1, "15:36"));
    expect(to("sameer", "Snoozed task").length).toBe(1);
  });

  it("a changed deadline reminds again for the new time, and nothing fires for the old one", async () => {
    const id = await task("sameer", "Moving target", await at(1, "15:00"));
    await run(await at(1, "13:02"));
    expect(to("sameer", "Due in 2h").length).toBe(1);
    await db.query(`update tasks set due_at = $2 where id = $1`, [id, await at(1, "16:45")]);
    await run(await at(1, "14:00"));
    await run(await at(1, "15:05")); // the old deadline passes: not overdue
    expect(to("sameer", "Overdue")).toEqual([]);
    expect(to("sameer", "Due in 2h").length).toBe(2); // 15:05 is inside two hours of 16:45
    expect(to("sameer", "Due in 2h")[1].text).toContain("16:45 EDT");
    await run(await at(1, "16:46"));
    await run(await at(1, "16:55"));
    expect(to("sameer", "Overdue").length).toBe(1);
    const keys = (await queued(`record_id = $1 and rule_key = 'task_due_2h'`, [id])).map((r) => r.window_key);
    expect(new Set(keys).size).toBe(2);
  });

  it("a reminder still queued for the old deadline is closed when the deadline moves", async () => {
    const id = await task("sameer", "Late evening", await at(1, "19:00"));
    await run(await at(1, "19:05")); // off shift: held for the morning
    const held = await queued(`record_id = $1 and rule_key = 'task_overdue'`, [id]);
    expect(held.length).toBe(1);
    expect(held[0].sent_at).toBeNull();
    await db.query(`update tasks set due_at = $2 where id = $1`, [id, await at(4, "12:00")]);
    expect((await queued(`record_id = $1 and rule_key = 'task_overdue'`, [id]))[0].channel).toBe("skipped:rescheduled");
    await run(await at(2, "09:02"));
    expect(sent.filter((m) => m.target === "U_sameer" && m.text.includes("was due"))).toEqual([]);
  });

  it("skips the 2h reminder for a task created with less than two hours to go, but still says overdue", async () => {
    await task("sameer", "Last minute", await at(1, "15:00"), { created: await at(1, "14:00") });
    await run(await at(1, "14:05"));
    await run(await at(1, "14:30"));
    expect(to("sameer", "Due in 2h")).toEqual([]);
    await run(await at(1, "15:02"));
    expect(to("sameer", "Overdue").length).toBe(1);
  });

  it("is held to the shift: overdue after hours waits for the next shift start, and a 2h reminder is never queued to arrive late", async () => {
    const evening = await task("sameer", "After hours", await at(1, "19:00"));
    await run(await at(1, "17:30")); // two hours before, off shift, next shift starts after the deadline
    expect(await queued(`record_id = $1 and rule_key = 'task_due_2h'`, [evening])).toEqual([]);
    await run(await at(1, "19:05"));
    expect(sent.filter((m) => m.target === "U_sameer" && !m.text.startsWith("EOD due"))).toEqual([]);
    const held = await queued(`record_id = $1 and rule_key = 'task_overdue'`, [evening]);
    expect(held[0].held_until?.toISOString()).toBe(await at(2, "09:00"));
    await run(await at(2, "08:55"));
    expect(sent.filter((m) => m.target === "U_sameer" && !m.text.startsWith("EOD due"))).toEqual([]);
    await run(await at(2, "09:01"));
    const morning = sent.filter((m) => m.target === "U_sameer" && m.text.includes("After hours"));
    expect(morning.length).toBe(1);
    expect((await queued(`record_id = $1 and rule_key = 'task_overdue'`, [evening]))[0].sent_at).not.toBeNull();

    // Due at 10:00: the 2h mark (08:00) is before the 09:00 start, so it is held until then and still arrives in time.
    const early = await task("sameer", "First thing", await at(3, "10:00"));
    await run(await at(3, "08:05"));
    const q = await queued(`record_id = $1 and rule_key = 'task_due_2h'`, [early]);
    expect(q[0].held_until?.toISOString()).toBe(await at(3, "09:00"));
    expect(to("sameer", "Due in 2h")).toEqual([]);
    await run(await at(3, "09:01"));
    expect(to("sameer", "Due in 2h").length).toBe(1);
  });

  it("someone with no shift entered is not held back", async () => {
    const id = await task("aditya", "Check the ads", await at(1, "22:00")); // Aditya has no shift
    await run(await at(1, "20:05"));
    expect(to("aditya", "Due in 2h").length).toBe(1);
    await run(await at(1, "22:01"));
    await run(await at(1, "22:06"));
    expect(to("aditya", "Overdue").length).toBe(1);
    await run(await at(2, "22:03"));
    expect(to("ryan", "Task still open a day after its deadline").length).toBe(1);
    expect((await queued(`record_id = $1`, [id])).every((r) => r.sent_at !== null && r.held_until === null)).toBe(true);
  });

  it("a deadline that passed long ago does not start reminding now, and date-only tasks keep the daily rule", async () => {
    await task("sameer", "Ancient", await at(-9, "15:00"));
    await shift("amanda");
    await db.query(`insert into tasks (owner_id, title, due, source, created_at) values ($1, 'Date only', app_today() - 1, 'ryan', now() - interval '3 days')`, [people.amanda]);
    await run(await at(1, "09:02"));
    expect(to("ryan", "Task still open a day after its deadline")).toEqual([]);
    expect((await queued(`rule_key = 'task_overdue' and staff_id = $1`, [people.amanda])).length).toBe(1);
    expect((await queued(`rule_key = 'task_overdue' and staff_id = $1`, [people.sameer])).length).toBe(0);
    await run(await at(2, "09:02"));
    expect((await queued(`rule_key = 'task_overdue' and staff_id = $1`, [people.amanda])).length).toBe(2);
  });

  it("the three rules are rows the owner can read and switch off", async () => {
    const rows = await all<{ key: string; enabled: boolean; audience: string; template: string }>(
      `select key, enabled, audience, template from reminder_rules where key in ('task_due_2h', 'task_overdue', 'task_overdue_24h') order by key`);
    expect(rows.map((r) => [r.key, r.enabled, r.template])).toEqual([
      ["task_due_2h", true, "Due in 2h"], ["task_overdue", true, "Overdue"], ["task_overdue_24h", true, "Task still open a day after its deadline"],
    ]);
    expect(rows[2].audience).toBe("owner");
    await db.query(`update reminder_rules set enabled = false where key = 'task_due_2h'`);
    await task("sameer", "Switched off", await at(1, "15:00"));
    await run(await at(1, "13:05"));
    expect(to("sameer", "Due in 2h")).toEqual([]);
    await db.query(`update reminder_rules set enabled = true where key = 'task_due_2h'`);
  });
});

describe("the request router gives the work a deadline", () => {
  let n = 0;
  const ask = async (text: string, over: Record<string, unknown> = {}) => {
    const r = pgliteRpc(db);
    const stored = await r<{ id: string }>("router_store_message", {
      p_channel: "C0GENERAL", p_ts: `${Math.floor(Date.now() / 1000) + ++n}.000100`, p_user: "U_CLIENT", p_sender_name: "Dana", p_text: text, p_thread_ts: null, p_mode: "live",
    });
    const c = { is_request: true, owner: "ads", title: text, due_at: null, urgency: "normal", confidence: 0.95, tech_type: null, ...over };
    const result = await r<RouteResult>("route_client_request", {
      p_id: stored!.id, p_is_request: c.is_request, p_owner: c.owner, p_title: c.title, p_due_at: c.due_at, p_urgency: c.urgency, p_confidence: c.confidence, p_tech_type: c.tech_type,
    });
    return { id: stored!.id, result };
  };
  const deadline = (id: string) => one<{ deadline_at: Date | null; source: string; can_change: boolean }>(`select deadline_at, source, can_change from client_request_deadlines where request_id = $1`, [id]);

  beforeEach(async () => {
    await one(
      `insert into clients (name, stage, pod, slack_general_id, slack_scheduling_id) values ('Pivotal Health', 'live', 'pod_1', 'C0GENERAL', 'C0SCHED') returning id`);
  });

  it("a task for the media buyer takes the deadline in the message, to the minute", async () => {
    const { id, result } = await ask("Please lower the daily budget", { due_at: "2026-10-14T19:00:00.000Z" });
    expect(result).toMatchObject({ status: "routed", routed_table: "tasks" });
    const t = await one<{ due_at: Date; due: string; owner_id: string }>(`select due_at, due::text, owner_id from tasks`);
    expect(t.due_at.toISOString()).toBe("2026-10-14T19:00:00.000Z");
    expect(t.due).toBe("2026-10-14");
    expect(t.owner_id).toBe(people.aditya);
    expect(await deadline(id)).toMatchObject({ source: "item", can_change: false });
    expect((await deadline(id)).deadline_at?.toISOString()).toBe("2026-10-14T19:00:00.000Z");
  });

  it("with no deadline in the message: the end of the person's next shift (weekday 17:00 when they have no shift)", async () => {
    await ask("Can you refresh the creatives");
    const t = await one<{ same: boolean; has: boolean }>(`select due_at = staff_next_shift_end(owner_id) as same, due_at is not null as has from tasks`);
    expect(t).toEqual({ same: true, has: true });

    await shift("sameer");
    await ask("Add a new intake form", { owner: "tech", tech_type: "other" });
    const j = await one<{ same: boolean; overridden: boolean }>(`select due_at = staff_next_shift_end(owner_id) as same, due_override is not null as overridden from tech_jobs where type = 'other'`);
    expect(j).toEqual({ same: true, overridden: false });
    const shiftEnd = await one<{ ok: boolean }>(`select exists (select 1 from shifts_resolved r join tech_jobs j on j.owner_id = r.staff_id and j.due_at = r.ends_at) as ok`);
    expect(shiftEnd.ok).toBe(true);

    // A fix keeps its automatic 30 business minutes.
    await ask("The booking form is broken", { owner: "tech", tech_type: "fix" });
    expect(await one(`select due_at = tech_job_due_at('fix', requested_at) as auto, due_override is null as no_override from tech_jobs where type = 'fix'`)).toEqual({ auto: true, no_override: true });
  });

  it("shows the deadline a Triage request will get, and the owner can change it before assigning", async () => {
    const { id } = await ask("Something about the budget maybe", { confidence: 0.5 });
    expect((await one<{ status: string }>(`select status from client_requests where id = $1`, [id])).status).toBe("triage");
    const before = await deadline(id);
    expect(before).toMatchObject({ source: "next_shift", can_change: true });
    expect(before.deadline_at).not.toBeNull();

    await asUser(db, AUTH.sameer, async () => {
      await expect(db.query(`select router_set_deadline($1, '2026-10-16T14:00:00Z')`, [id])).rejects.toThrow(/ROUTER_OWNER_ONLY/);
    });
    await asUser(db, AUTH.ryan, async () => {
      await db.query(`select router_set_deadline($1, '2026-10-16T14:00:00Z')`, [id]);
    });
    expect(await deadline(id)).toMatchObject({ source: "set", can_change: true });
    await asUser(db, AUTH.ryan, async () => {
      await db.query(`select router_decide($1, 'assign', 'ads')`, [id]);
    });
    expect((await one<{ due_at: Date }>(`select due_at from tasks`)).due_at.toISOString()).toBe("2026-10-16T14:00:00.000Z");
    expect(await deadline(id)).toMatchObject({ source: "item", can_change: false });
    // Once it is work, the deadline is changed on the task, not on the request.
    await asUser(db, AUTH.ryan, async () => {
      await expect(db.query(`select router_set_deadline($1, null)`, [id])).rejects.toThrow(/ROUTER_STATE/);
    });
  });

  it("names where each waiting deadline comes from: the message, the SLA, or decided when assigned", async () => {
    const msg = await ask("Budget by Friday", { confidence: 0.5, due_at: "2026-10-16T21:00:00.000Z" });
    const fix = await ask("Form is down?", { confidence: 0.5, owner: "tech", tech_type: "fix" });
    const none = await ask("Hmm", { confidence: 0.5, owner: null });
    expect(await deadline(msg.id)).toMatchObject({ source: "message" });
    expect(await deadline(fix.id)).toMatchObject({ source: "sla", deadline_at: null });
    expect(await deadline(none.id)).toMatchObject({ source: "on_assign", deadline_at: null });
    // A deadline the owner sets on a fix overrides the SLA when it is assigned.
    await asUser(db, AUTH.ryan, async () => {
      await db.query(`select router_set_deadline($1, '2026-10-20T10:00:00Z')`, [fix.id]);
      await db.query(`select router_decide($1, 'assign', 'tech')`, [fix.id]);
    });
    const j = await one<{ due_at: Date; due_override: Date }>(`select due_at, due_override from tech_jobs where type = 'fix'`);
    expect(j.due_at.toISOString()).toBe("2026-10-20T10:00:00.000Z");
    expect(j.due_override.toISOString()).toBe("2026-10-20T10:00:00.000Z");
  });
});

describe("tech jobs: the owner can override the automatic deadline", () => {
  const job = async (type: string, requested = "now() - interval '10 minutes'") =>
    (await one<{ id: string }>(`insert into tech_jobs (type, title, owner_id, requested_by, requested_at) values ($1, 'Job', $2, $3, ${requested}) returning id`, [type, people.sameer, people.ryan])).id;
  const row = (id: string) => one<{ due_at: Date | null; due_override: Date | null; auto: Date | null }>(
    `select due_at, due_override, tech_job_due_at(type, requested_at) as auto from tech_jobs where id = $1`, [id]);

  it("keeps the automatic 48h / 30-minute deadlines until an override is set, and the override survives later updates", async () => {
    const id = await job("fix");
    const start = await row(id);
    expect(start.due_at?.toISOString()).toBe(start.auto?.toISOString());

    await asUser(db, AUTH.ryan, async () => {
      await db.query(`update tech_jobs set due_override = '2026-10-20T10:00:00Z' where id = $1`, [id]);
    });
    expect((await row(id)).due_at?.toISOString()).toBe("2026-10-20T10:00:00.000Z");
    // The owner of the job works it; the type and request time change (which recalculates the SLA): still the override.
    await asUser(db, AUTH.sameer, async () => {
      await db.query(`update tech_jobs set status = 'working', blocked_on = 'client' where id = $1`, [id]);
    });
    await db.query(`update tech_jobs set type = 'launch' where id = $1`, [id]);
    await db.query(`update tech_jobs set requested_at = requested_at - interval '1 hour' where id = $1`, [id]);
    const kept = await row(id);
    expect(kept.due_at?.toISOString()).toBe("2026-10-20T10:00:00.000Z");
    expect((await one<{ due_override: Date }>(`select due_override from tech_jobs_board where tech_job_id = $1`, [id])).due_override.toISOString()).toBe("2026-10-20T10:00:00.000Z");

    // Back to automatic: the SLA for what the job is now (a launch, 48h from the moved request time).
    await asUser(db, AUTH.ryan, async () => {
      await db.query(`update tech_jobs set due_override = null where id = $1`, [id]);
    });
    const back = await row(id);
    expect(back.due_override).toBeNull();
    expect(back.due_at?.toISOString()).toBe(back.auto?.toISOString());
  });

  it("only the owner can set or clear it", async () => {
    const id = await job("fix");
    await asUser(db, AUTH.sameer, async () => {
      await expect(db.query(`update tech_jobs set due_override = now() + interval '9 days' where id = $1`, [id])).rejects.toThrow(/TECH_DEADLINE_OWNER_ONLY/);
      await expect(db.query(`insert into tech_jobs (type, title, requested_by, due_override) values ('fix', 'Mine', $1, now() + interval '9 days')`, [people.sameer])).rejects.toThrow(/TECH_DEADLINE_OWNER_ONLY/);
    });
    await db.query(`update tech_jobs set due_override = now() + interval '1 day' where id = $1`, [id]);
    await asUser(db, AUTH.sameer, async () => {
      await expect(db.query(`update tech_jobs set due_override = null where id = $1`, [id])).rejects.toThrow(/TECH_DEADLINE_OWNER_ONLY/);
    });
  });

  it("a job with no automatic deadline goes back to what it had", async () => {
    const id = (await one<{ id: string }>(`insert into tech_jobs (type, title, owner_id, due_at) values ('other', 'Other', $1, '2026-10-15T15:00:00Z') returning id`, [people.sameer])).id;
    await db.query(`update tech_jobs set due_override = '2026-10-18T15:00:00Z' where id = $1`, [id]);
    await db.query(`update tech_jobs set status = 'working' where id = $1`, [id]);
    expect((await row(id)).due_at?.toISOString()).toBe("2026-10-18T15:00:00.000Z");
    await db.query(`update tech_jobs set due_override = null where id = $1`, [id]);
    expect((await row(id)).due_at?.toISOString()).toBe("2026-10-15T15:00:00.000Z");
  });

  it("overdue and met-SLA follow the override, not the SLA clock", async () => {
    // A fix asked for nine days ago: far past 30 business minutes.
    const late = await job("fix", "now() - interval '9 days'");
    const sla = (id: string) => one<{ is_overdue: boolean; sla_minutes: number | null; met_sla: boolean | null }>(
      `select is_overdue, sla_minutes::float as sla_minutes, met_sla from tech_job_sla where tech_job_id = $1`, [id]);
    expect(await sla(late)).toMatchObject({ is_overdue: true, sla_minutes: 30 });
    await db.query(`update tech_jobs set due_override = now() + interval '2 hours' where id = $1`, [late]);
    expect(await sla(late)).toMatchObject({ is_overdue: false, sla_minutes: null });
    await db.query(`update tech_jobs set status = 'done' where id = $1`, [late]);
    expect(await sla(late)).toMatchObject({ is_overdue: false, met_sla: true });

    // And the other way: an early override makes a job overdue before its SLA would.
    const early = await job("launch");
    expect(await sla(early)).toMatchObject({ is_overdue: false });
    await db.query(`update tech_jobs set due_override = now() - interval '5 minutes' where id = $1`, [early]);
    expect(await sla(early)).toMatchObject({ is_overdue: true, sla_minutes: null });
    await db.query(`update tech_jobs set due_override = null where id = $1`, [early]);
    expect(await sla(early)).toMatchObject({ is_overdue: false, sla_minutes: 2880 });
  });
});

describe("scorecard: tasks done on time", () => {
  /** Deadline one hour ago, and the ET week it falls in. */
  const anHourAgo = `now() - interval '1 hour'`;
  const score = (who: keyof TestPeople) =>
    one<{ value: number | null; numerator: number; denominator: number; colour: string | null; is_baseline: boolean; card: string }>(
      `select value::float as value, numerator::float as numerator, denominator::float as denominator, colour, is_baseline, card
       from person_scores_weekly where staff_id = $1 and metric = 'tasks_on_time_pct' and week_start = app_week_start(app_day(${anHourAgo}))`, [people[who]]);
  const goLive = (sql: string) => db.query(`update app_settings set value = to_jsonb((${sql})::text) where key = 'go_live_date'`);
  const add = (who: keyof TestPeople, title: string, dueSql: string, extra = "") =>
    db.query(`insert into tasks (owner_id, title, source, category, due_at ${extra ? ", " + extra.split("=")[0] : ""}) values ($1, $2, 'ryan', $3, ${dueSql} ${extra ? ", " + extra.split("=").slice(1).join("=") : ""})`,
      [people[who], title, who === "aditya" ? "ads" : "general"]);

  it("is the share of tasks due in the week that were done by the deadline; an open task past its deadline is late", async () => {
    await goLive(`app_day(${anHourAgo}) - 14`);
    await add("sameer", "Done in time", anHourAgo);
    await db.query(`update tasks set status = 'done', done_at = due_at - interval '10 minutes' where title = 'Done in time'`);
    await add("sameer", "Done on the dot", anHourAgo);
    await db.query(`update tasks set status = 'done', done_at = due_at where title = 'Done on the dot'`);
    await add("sameer", "Done late", anHourAgo);
    await db.query(`update tasks set status = 'done' where title = 'Done late'`); // done_at = now, after the deadline
    await add("sameer", "Still open", anHourAgo);
    // Not counted: no deadline, soft-deleted, and not yet due.
    await db.query(`insert into tasks (owner_id, title, source, legacy_ref) values ($1, 'No deadline', 'ryan', 'legacy-9')`, [people.sameer]);
    await add("sameer", "Deleted", anHourAgo);
    await db.query(`update tasks set deleted_at = now() where title = 'Deleted'`);
    await add("sameer", "Not due yet", `now() + interval '20 minutes'`);

    expect(await score("sameer")).toMatchObject({ value: 50, numerator: 2, denominator: 4, colour: "red", card: "tech" });
    // It is on the people cards' feed, like every other metric.
    const card = await all<{ metric: string; colour: string | null }>(`select metric, colour from current_week_scores() where staff_id = $1 and metric = 'tasks_on_time_pct'`, [people.sameer]);
    expect(card.length).toBe(1);
  });

  it("no tasks due means no data, never 0% or 100%; only timed-deadline staff have the metric", async () => {
    await goLive(`app_day(${anHourAgo}) - 14`);
    await add("sameer", "Not due yet", `now() + interval '3 days'`);
    expect(await score("sameer")).toMatchObject({ value: null, colour: null, denominator: 0 });
    expect(await score("aditya")).toMatchObject({ value: null, colour: null, denominator: 0, card: "media_buyer" });
    await db.query(`insert into tasks (owner_id, title, source, due_at) values ($1, 'CSR timed', 'ryan', ${anHourAgo})`, [people.amanda]);
    expect(await all(`select 1 from person_scores_weekly where metric = 'tasks_on_time_pct' and staff_id in ($1, $2)`, [people.amanda, people.ryan])).toEqual([]);
  });

  it("green from 90, amber 70 to 89, red below 70, from config rows", async () => {
    const colour = async (v: number) => (await one<{ c: string }>(`select score_colour('tasks_on_time_pct', $1) as c`, [v])).c;
    expect([await colour(100), await colour(90), await colour(89.9), await colour(70), await colour(69.9), await colour(0)]).toEqual(["green", "green", "amber", "amber", "red", "red"]);
    expect(await one(`select direction, green::int as green, amber::int as amber from scoring_config where key = 'tasks_on_time_pct'`)).toEqual({ direction: "higher_better", green: 90, amber: 70 });

    await goLive(`app_day(${anHourAgo}) - 14`);
    for (let i = 0; i < 10; i++) await add("aditya", `Ad task ${i}`, anHourAgo);
    await db.query(`update tasks set status = 'done', done_at = due_at - interval '1 minute' where title <> 'Ad task 0'`);
    expect(await score("aditya")).toMatchObject({ value: 90, numerator: 9, denominator: 10, colour: "green" });
    await db.query(`update tasks set status = 'todo' where title = 'Ad task 1'`);
    expect(await score("aditya")).toMatchObject({ value: 80, colour: "amber" });
  });

  it("counts from the go-live date: nothing before it, nothing until it is set, and the go-live week is the baseline", async () => {
    await add("sameer", "Open and late", anHourAgo);
    expect(await score("sameer")).toMatchObject({ value: null, colour: null, is_baseline: false }); // no go-live date
    await goLive(`app_day(${anHourAgo}) + 1`);
    expect(await score("sameer")).toMatchObject({ value: null, colour: null }); // due before go-live
    await goLive(`app_day(${anHourAgo})`);
    expect(await score("sameer")).toMatchObject({ value: 0, denominator: 1, colour: "red", is_baseline: true });
    // The daily snapshot stores it with the rest.
    await db.query(`select snapshot_person_scores(app_day(${anHourAgo}))`);
    const snap = await one<{ value: number; is_baseline: boolean }>(
      `select value::float as value, is_baseline from person_scores_snapshot where staff_id = $1 and metric = 'tasks_on_time_pct'`, [people.sameer]);
    expect(snap).toEqual({ value: 0, is_baseline: true });
  });
});
