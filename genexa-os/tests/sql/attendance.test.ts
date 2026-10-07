import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AUTH, asUser, freshDb, seedStaff, type TestPeople } from "./db";
import { runAttendance } from "@/lib/jobs/attendance";

vi.mock("server-only", () => ({}));

let db: PGlite;
let people: TestPeople;
/** Today's 09:00 ET shift start for Amanda, as an instant. */
let start: string;
let seq = 0;

type Row = {
  id: string; status: string | null; minutes_late: number | null; clock_in: string | null; clock_out: string | null;
  shift_start: string | null; manual: boolean;
};
const ET_TODAY = `(now() at time zone 'America/New_York')::date`;
const at = (minutes: number) => `('${start}'::timestamptz + interval '${minutes} minutes')`;
const shift = (staffId: string, from = "09:00", to = "17:00") =>
  db.query(`update staff set shift_start = $2, shift_end = $3, timezone = 'America/New_York', working_days = '{1,2,3,4,5,6,7}' where id = $1`, [staffId, from, to]);
const today = async (staffId: string) =>
  (await db.query<Row>(`select * from attendance where staff_id = $1 and date = ${ET_TODAY}`, [staffId])).rows[0];
const clockIn = (staffId: string, minutes: number) => db.query(`select * from attendance_clock_in($1, ${at(minutes)})`, [staffId]);
const clockOut = (staffId: string, minutes: number) => db.query(`select * from attendance_clock_out($1, ${at(minutes)})`, [staffId]);
const tick = async (minutes: number) =>
  (await db.query<{ attendance_id: string; staff_id: string; old_status: string | null; new_status: string | null }>(
    `select * from attendance_tick(${at(minutes)})`)).rows;

// One database for the file; each test starts from an empty attendance state.
beforeAll(async () => {
  db = await freshDb();
  people = await seedStaff(db);
});

beforeEach(async () => {
  await db.exec(`truncate attendance, shift_overrides, notifications, job_runs`);
  await db.query(`update staff set shift_start = null, shift_end = null, slack_user_id = null, timezone = 'America/New_York'`);
  await db.query(`update app_settings set value = '"2026-10-12"' where key = 'go_live_date'`);
  await shift(people.amanda);
  // Track from the start of today (ET) so only today's shift is in play.
  await db.query(`update app_settings set value = to_jsonb((${ET_TODAY}::timestamp at time zone 'America/New_York')) where key = 'attendance_tracking_start'`);
  start = (await db.query<{ s: string }>(`select starts_at::text as s from shifts_resolved where staff_id = $1 and date = ${ET_TODAY}`, [people.amanda])).rows[0].s;
});

describe("clock in", () => {
  it("within the late minutes is on time", async () => {
    await clockIn(people.amanda, 3);
    expect(await today(people.amanda)).toMatchObject({ status: "on_time", minutes_late: 0, manual: false });
    expect((await today(people.amanda)).shift_start).not.toBeNull();
  });

  it("exactly on the late mark is still on time; early is on time", async () => {
    await clockIn(people.amanda, 10);
    expect(await today(people.amanda)).toMatchObject({ status: "on_time", minutes_late: 0 });
    await shift(people.sameer);
    await clockIn(people.sameer, -20);
    expect(await today(people.sameer)).toMatchObject({ status: "on_time", minutes_late: 0 });
  });

  it("after the late minutes is late, with whole minutes after shift start", async () => {
    await db.query(`select * from attendance_clock_in($1, ${at(17)} + interval '40 seconds')`, [people.amanda]);
    expect(await today(people.amanda)).toMatchObject({ status: "late", minutes_late: 17 });
  });

  it("after the no-show mark records the time but the status is no-show, and the tick leaves it", async () => {
    await clockIn(people.amanda, 42);
    expect(await today(people.amanda)).toMatchObject({ status: "no_show", minutes_late: 42 });
    expect((await today(people.amanda)).clock_in).not.toBeNull();
    expect(await tick(60)).toEqual([]);
    expect(await today(people.amanda)).toMatchObject({ status: "no_show", minutes_late: 42 });
  });

  it("refuses a second clock-in the same day", async () => {
    await clockIn(people.amanda, 1);
    await expect(clockIn(people.amanda, 90)).rejects.toThrow(/ATTENDANCE_ALREADY_IN/);
    await clockOut(people.amanda, 200);
    await expect(clockIn(people.amanda, 210)).rejects.toThrow(/ATTENDANCE_ALREADY_IN/);
  });

  it("is allowed when not rostered: a row with no shift times and no status", async () => {
    await clockIn(people.marjorie, 5);
    const row = await today(people.marjorie);
    expect(row).toMatchObject({ status: null, minutes_late: null, shift_start: null });
    expect(row.clock_in).not.toBeNull();
  });

  it("clock out closes the open row and needs an open clock-in", async () => {
    await expect(clockOut(people.amanda, 5)).rejects.toThrow(/ATTENDANCE_NOT_IN/);
    await clockIn(people.amanda, 2);
    await clockOut(people.amanda, 480);
    expect((await today(people.amanda)).clock_out).not.toBeNull();
    await expect(clockOut(people.amanda, 481)).rejects.toThrow(/ATTENDANCE_NOT_IN/);
  });
});

describe("attendance_tick", () => {
  it("does nothing before the shift, opens the row in the grace window, then late, then no-show", async () => {
    expect(await tick(-5)).toEqual([]);
    expect(await today(people.amanda)).toBeUndefined();

    expect(await tick(5)).toEqual([]);
    expect(await today(people.amanda)).toMatchObject({ status: null, minutes_late: null, clock_in: null });

    const late = await tick(11);
    const id = (await today(people.amanda)).id;
    expect(late).toEqual([{ attendance_id: id, staff_id: people.amanda, old_status: null, new_status: "late" }]);
    expect(await today(people.amanda)).toMatchObject({ status: "late", minutes_late: null });
    expect(await tick(15)).toEqual([]);

    expect(await tick(30)).toEqual([{ attendance_id: id, staff_id: people.amanda, old_status: "late", new_status: "no_show" }]);
    expect(await today(people.amanda)).toMatchObject({ status: "no_show", minutes_late: null });
    expect(await tick(35)).toEqual([]);
  });

  it("someone marked late who then clocks in stays late with the minutes filled; a no-show stays a no-show", async () => {
    await shift(people.sameer);
    await tick(12);
    await clockIn(people.amanda, 14);
    expect(await today(people.amanda)).toMatchObject({ status: "late", minutes_late: 14 });
    await tick(31);
    expect(await today(people.amanda)).toMatchObject({ status: "late", minutes_late: 14 });
    expect(await today(people.sameer)).toMatchObject({ status: "no_show", minutes_late: null });
    await clockIn(people.sameer, 50);
    expect(await today(people.sameer)).toMatchObject({ status: "no_show", minutes_late: 50 });
    expect(await tick(55)).toEqual([]);
  });

  it("an on-time clock-in is left alone", async () => {
    await clockIn(people.amanda, 0);
    expect(await tick(45)).toEqual([]);
    expect(await today(people.amanda)).toMatchObject({ status: "on_time", minutes_late: 0 });
  });

  it("an excused override gives an excused row, never a no-show", async () => {
    await db.query(`insert into shift_overrides (staff_id, date, kind, note) values ($1, ${ET_TODAY}, 'sick', 'Flu')`, [people.amanda]);
    const changed = await tick(45);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ staff_id: people.amanda, old_status: null, new_status: "excused" });
    expect(await today(people.amanda)).toMatchObject({ status: "excused", shift_start: null, minutes_late: null });
    expect(await tick(600)).toEqual([]);
  });

  it("a swap to later hours is judged against the new start, even after a no-show was written", async () => {
    await tick(45);
    expect(await today(people.amanda)).toMatchObject({ status: "no_show" });
    await db.query(`insert into shift_overrides (staff_id, date, kind, shift_start, shift_end) values ($1, ${ET_TODAY}, 'swap', '13:00', '19:00')`, [people.amanda]);
    await tick(245); // 13:05
    expect((await today(people.amanda)).status).toBeNull();
    await clockIn(people.amanda, 246);
    expect(await today(people.amanda)).toMatchObject({ status: "on_time", minutes_late: 0 });
  });

  it("never changes a row the owner edited by hand", async () => {
    await tick(12);
    const { id } = await today(people.amanda);
    await asUser(db, AUTH.ryan, () =>
      db.query(`select * from attendance_owner_edit($1, 'on_time', null, null, false, 'Power cut, was working')`, [id]));
    expect(await today(people.amanda)).toMatchObject({ status: "on_time", manual: true });
    expect(await tick(60)).toEqual([]);
    expect(await today(people.amanda)).toMatchObject({ status: "on_time", manual: true });
    // A clock-in on a ruled day records the time and nothing else.
    await clockIn(people.amanda, 70);
    expect(await today(people.amanda)).toMatchObject({ status: "on_time", manual: true });
    expect((await today(people.amanda)).clock_in).not.toBeNull();
  });

  it("ignores shifts from before tracking started", async () => {
    await db.query(`update app_settings set value = to_jsonb(${at(60)}) where key = 'attendance_tracking_start'`);
    expect(await tick(120)).toEqual([]);
    expect((await db.query(`select 1 from attendance`)).rows).toHaveLength(0);
  });
});

describe("who can do what", () => {
  it("a person clocks in and out only as themselves, on the database clock", async () => {
    await asUser(db, AUTH.amanda, async () => {
      const r = await db.query<{ staff_id: string; ok: boolean }>(`select staff_id, abs(extract(epoch from (clock_in - now()))) < 5 as ok from clock_in()`);
      expect(r.rows[0]).toEqual({ staff_id: people.amanda, ok: true });
      await expect(db.query(`select * from clock_in()`)).rejects.toThrow(/ATTENDANCE_ALREADY_IN/);
      // No way to name another person or another time.
      await expect(db.query(`select * from attendance_clock_in($1, now())`, [people.sameer])).rejects.toThrow(/permission denied/);
      await expect(db.query(`select * from attendance_clock_out($1, now())`, [people.sameer])).rejects.toThrow(/permission denied/);
      await expect(db.query(`select * from attendance_tick()`)).rejects.toThrow(/permission denied/);
      // No direct writes.
      await expect(db.query(`insert into attendance (staff_id, date, status) values ($1, ${ET_TODAY} - 1, 'on_time')`, [people.amanda])).rejects.toThrow(/row-level security/);
      const upd = await db.query(`update attendance set status = 'on_time', clock_in = now() - interval '3 hours' where staff_id = $1 returning id`, [people.amanda]);
      expect(upd.rows).toHaveLength(0);
      await expect(db.query(`select * from attendance_owner_edit((select id from attendance limit 1), 'on_time', null, null, false, 'me')`)).rejects.toThrow(/ATTENDANCE_OWNER_ONLY/);
      const out = await db.query<{ staff_id: string }>(`select staff_id from clock_out()`);
      expect(out.rows[0].staff_id).toBe(people.amanda);
    });
    expect((await db.query(`select 1 from attendance where staff_id <> $1`, [people.amanda])).rows).toHaveLength(0);
  });

  it("my_attendance gives the caller the state for the clock control", async () => {
    type Mine = { staff_id: string; rostered: boolean; shift_label: string | null; state: string; show: boolean; clock_in_label: string | null };
    const mine = (who: string) => asUser(db, who, async () => (await db.query<Mine>(`select * from my_attendance()`)).rows);
    let rows = await mine(AUTH.amanda);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ staff_id: people.amanda, rostered: true, shift_label: "09:00–17:00", state: "not_clocked_in", show: true });
    await asUser(db, AUTH.amanda, () => db.query(`select * from clock_in()`));
    rows = await mine(AUTH.amanda);
    expect(rows[0].state).toBe("clocked_in");
    expect(rows[0].clock_in_label).toMatch(/^\d\d:\d\d$/);
    await asUser(db, AUTH.amanda, () => db.query(`select * from clock_out()`));
    expect((await mine(AUTH.amanda))[0].state).toBe("clocked_out");
    // Not rostered and never clocked in: nothing to show.
    expect((await mine(AUTH.marjorie))[0]).toMatchObject({ show: false, state: "not_clocked_in" });
  });

  it("the owner edits any row with a note; the edit is audited and marks the row manual", async () => {
    await tick(45);
    const { id } = await today(people.amanda);
    await asUser(db, AUTH.ryan, async () => {
      await expect(db.query(`select * from attendance_owner_edit($1, 'late', null, null, false, '  ')`, [id])).rejects.toThrow(/ATTENDANCE_NOTE_REQUIRED/);
      await expect(db.query(`select * from attendance_owner_edit($1, 'late', '2026-10-07 10:00', '2026-10-07 09:00', false, 'x')`, [id])).rejects.toThrow(/ATTENDANCE_TIMES/);
      await db.query(
        `select * from attendance_owner_edit($1, 'late', (${ET_TODAY} + time '09:20')::timestamp, (${ET_TODAY} + time '18:00')::timestamp, true, 'Slack was down, confirmed by phone')`, [id]);
    });
    const row = (await db.query<Row & { overtime_approved: boolean; approved_by: string; note: string }>(`select * from attendance where id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ status: "late", minutes_late: 20, manual: true, overtime_approved: true, approved_by: people.ryan, note: "Slack was down, confirmed by phone" });
    const audit = await db.query<{ field: string; actor: string }>(`select field, actor from audit_log where table_name = 'attendance' and row_id = $1 and field in ('status', 'manual', 'note')`, [id]);
    expect(audit.rows.filter((a) => a.actor === "Ryan").map((a) => a.field).sort()).toEqual(["manual", "note", "status"]);
  });
});

describe("weekly numbers and score", () => {
  // n rows in the ET week `weeksAgo` weeks back. The shift instant is 00:00 ET on that
  // week's Monday, so it is always in the past; excused rows have no shift and sit on the week's own dates.
  const add = async (staffId: string, weeksAgo: number, n: number, status: string) => {
    await db.query(
      `insert into attendance (staff_id, date, shift_start, shift_end, status)
       select $1,
         case when $4 = 'excused' then w.ws + g - 1 else date '2020-01-01' + $5::int + g end,
         case when $4 = 'excused' then null else (w.ws::timestamp at time zone 'America/New_York') end,
         case when $4 = 'excused' then null else (w.ws::timestamp at time zone 'America/New_York') + interval '8 hours' end,
         $4
       from (select app_week_start(app_today()) - 7 * $2::int as ws) w, generate_series(1, $3::int) g`,
      [staffId, weeksAgo, n, status, seq]);
    seq += n;
  };
  const week = async (staffId: string, weeksAgo: number) =>
    (await db.query<{ rostered: number; on_time: number; late: number; no_show: number; excused: number; on_time_pct: string | null }>(
      `select rostered::int, on_time::int, late::int, no_show::int, excused::int, on_time_pct::text from attendance_weekly
       where staff_id = $1 and week_start = app_week_start(app_today()) - 7 * $2::int`, [staffId, weeksAgo])).rows[0];
  const score = async (staffId: string, weeksAgo: number, metric: string) =>
    (await db.query<{ card: string; value: string | null; numerator: string; denominator: string; colour: string | null }>(
      `select card, value::text, numerator::text, denominator::text, colour from score_attendance_weekly
       where staff_id = $1 and week_start = app_week_start(app_today()) - 7 * $2::int and metric = $3`, [staffId, weeksAgo, metric])).rows[0];
  const goLive = (weeksAgo: number) =>
    db.query(`update app_settings set value = to_jsonb((app_week_start(app_today()) - 7 * $1::int)::text) where key = 'go_live_date'`, [weeksAgo]);

  it("attendance % = on-time / rostered, with excused shifts left out of both", async () => {
    await add(people.amanda, 1, 8, "on_time");
    await add(people.amanda, 1, 2, "late");
    await add(people.amanda, 1, 3, "excused");
    expect(await week(people.amanda, 1)).toEqual({ rostered: 10, on_time: 8, late: 2, no_show: 0, excused: 3, on_time_pct: "80.0" });
    expect(await week(people.amanda, 0)).toBeUndefined();
  });

  it("leaves out a shift that has not started or is still undecided", async () => {
    await add(people.amanda, 1, 1, "on_time");
    await db.query(`insert into attendance (staff_id, date, shift_start, shift_end, status) values
      ($1, app_today() + 3, now() + interval '3 days', now() + interval '3 days 8 hours', 'on_time'),
      ($1, app_today() + 4, (app_week_start(app_today()) - 7)::timestamp at time zone 'America/New_York', now(), null)`, [people.amanda]);
    expect(await week(people.amanda, 1)).toMatchObject({ rostered: 1, on_time: 1 });
  });

  it("colours from scoring_config: green 95+, amber 85-94, red below", async () => {
    await goLive(12);
    await add(people.amanda, 1, 19, "on_time");
    await add(people.amanda, 1, 1, "late"); // 95.0
    await add(people.sameer, 1, 9, "on_time");
    await add(people.sameer, 1, 1, "late"); // 90.0
    await add(people.aditya, 1, 4, "on_time");
    await add(people.aditya, 1, 1, "late"); // 80.0
    expect(await score(people.amanda, 1, "attendance_pct")).toEqual({ card: "csr", value: "95.0", numerator: "19", denominator: "20", colour: "green" });
    expect(await score(people.sameer, 1, "attendance_pct")).toMatchObject({ card: "tech", value: "90.0", colour: "amber" });
    expect(await score(people.aditya, 1, "attendance_pct")).toMatchObject({ card: "media_buyer", value: "80.0", colour: "red" });
    expect(await score(people.amanda, 1, "late_count")).toEqual({ card: "csr", value: "1", numerator: "1", denominator: "20", colour: null });
    expect(await score(people.amanda, 1, "no_shows")).toMatchObject({ value: "0", colour: null });
  });

  it("any no-show makes the week red, whatever the percentage", async () => {
    await goLive(12);
    await add(people.amanda, 1, 39, "on_time");
    await add(people.amanda, 1, 1, "no_show"); // 97.5%
    expect(await score(people.amanda, 1, "attendance_pct")).toMatchObject({ value: "97.5", colour: "red" });
    expect(await score(people.amanda, 1, "no_shows")).toMatchObject({ value: "1", colour: null });
  });

  it("weeks before go-live are tracked but not scored; nothing rostered is no data", async () => {
    await goLive(1);
    await add(people.amanda, 2, 1, "no_show");
    await add(people.amanda, 1, 2, "on_time");
    expect(await score(people.amanda, 2, "attendance_pct")).toEqual({ card: "csr", value: "0.0", numerator: "0", denominator: "1", colour: null });
    expect(await score(people.amanda, 1, "attendance_pct")).toMatchObject({ value: "100.0", colour: "green" });
    expect(await score(people.amanda, 3, "attendance_pct")).toEqual({ card: "csr", value: null, numerator: "0", denominator: "0", colour: null });
    expect(await score(people.amanda, 3, "late_count")).toMatchObject({ value: null, colour: null });
    // The owner has no attendance card; the view covers this week and the previous 12.
    expect((await db.query(`select 1 from score_attendance_weekly where staff_id = $1`, [people.ryan])).rows).toHaveLength(0);
    expect((await db.query(`select distinct week_start from score_attendance_weekly`)).rows).toHaveLength(13);
  });

  it("has exactly the scorecard columns", async () => {
    const cols = await db.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns where table_name = 'score_attendance_weekly' order by ordinal_position`);
    expect(cols.rows.map((c) => `${c.column_name} ${c.data_type}`)).toEqual([
      "staff_id uuid", "week_start date", "card text", "metric text", "value numeric", "numerator numeric", "denominator numeric", "colour text",
    ]);
  });

  it("attendance_week_flags lists 3+ lates or any no-show in the current week", async () => {
    await add(people.amanda, 0, 3, "late");
    await add(people.sameer, 0, 2, "late");
    await add(people.aditya, 0, 1, "no_show");
    await add(people.marjorie, 1, 5, "late");
    const flags = await db.query<{ name: string; late_count: number; no_show_count: number }>(
      `select name, late_count::int, no_show_count::int from attendance_week_flags order by name`);
    expect(flags.rows).toEqual([
      { name: "Aditya", late_count: 0, no_show_count: 1 },
      { name: "Amanda Harder", late_count: 3, no_show_count: 0 },
    ]);
  });

  it("attendance_today lists who is rostered today and where they stand", async () => {
    await clockIn(people.amanda, 2);
    const rows = await db.query<{ name: string; shift_label: string; state: string; clock_in_label: string }>(
      `select name, shift_label, state, clock_in_label from attendance_today`);
    expect(rows.rows).toEqual([{ name: "Amanda Harder", shift_label: "09:00–17:00", state: "on_time", clock_in_label: "09:02" }]);
  });
});

// A stand-in for the Supabase client that runs the job's few calls against the test database.
function fakeSupabase(pg: PGlite): SupabaseClient {
  const run = async (sql: string, params: unknown[] = []) => {
    try {
      return { data: (await pg.query<Record<string, unknown>>(sql, params)).rows, error: null };
    } catch (err) {
      return { data: null, error: { message: (err as Error).message } };
    }
  };
  const client = {
    rpc: (fn: string) => run(`select * from ${fn}()`),
    from: (table: string) => ({
      select: () => run(`select * from ${table}`),
      insert: (row: Record<string, unknown>) => {
        const keys = Object.keys(row);
        const done = run(
          `insert into ${table} (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning *`, Object.values(row));
        return {
          then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => done.then(resolve, reject),
          select: () => ({
            single: async () => {
              const r = await done;
              return { data: r.data?.[0] ?? null, error: r.error };
            },
          }),
        };
      },
      update: (patch: Record<string, unknown>) => ({
        eq: (col: string, value: unknown) => {
          const keys = Object.keys(patch);
          return run(`update ${table} set ${keys.map((k, i) => `${k} = $${i + 1}`).join(", ")} where ${col} = $${keys.length + 1}`, [...Object.values(patch), value]);
        },
      }),
    }),
  };
  return client as unknown as SupabaseClient;
}

describe("attendance job (alerts)", () => {
  type Sent = { to: string; text: string };
  let sent: Sent[];
  const job = (over: Partial<Parameters<typeof runAttendance>[0]> = {}) =>
    runAttendance({
      db: fakeSupabase(db),
      slackReady: true,
      pauseMs: 0,
      lookup: async () => null,
      send: async (to, text) => {
        sent.push({ to, text });
        return { ok: true, ts: String(sent.length), channel: `D${to}` };
      },
      ...over,
    });
  // The job runs on the real clock, so the shift is moved to start a set number of minutes ago.
  const startedMinutesAgo = (staffId: string, minutes: number) =>
    db.query(
      `update staff set timezone = 'UTC', working_days = '{1,2,3,4,5,6,7}',
         shift_start = (now() at time zone 'UTC' - make_interval(mins => $2::int))::time,
         shift_end = (now() at time zone 'UTC' - make_interval(mins => $2::int) + interval '8 hours')::time
       where id = $1`, [staffId, minutes]);
  const notes = async () =>
    (await db.query<{ rule_key: string; staff_id: string; record_type: string; sent_at: string | null; channel: string | null }>(
      `select rule_key, staff_id, record_type, sent_at, channel from notifications order by created_at, rule_key, staff_id`)).rows;

  beforeEach(async () => {
    sent = [];
    await db.query(`update app_settings set value = to_jsonb(now() - interval '6 hours') where key = 'attendance_tracking_start'`);
    await db.query(`update staff set shift_start = null, shift_end = null`);
    await db.query(`update staff set slack_user_id = 'U_' || upper(split_part(name, ' ', 1))`);
  });

  it("late: one DM to the person, by first name, with the Team link; a second run sends nothing", async () => {
    await startedMinutesAgo(people.amanda, 15);
    const first = await job();
    expect(first).toMatchObject({ ok: true, summary: { late: 1, no_show: 0, sent: 1 } });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("U_AMANDA");
    expect(sent[0].text).toMatch(/^Amanda, you have not clocked in/);
    expect(sent[0].text).not.toContain("Harder");
    expect(sent[0].text).toContain("http://localhost:3000/team");
    const n = await notes();
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ rule_key: "attendance_late", staff_id: people.amanda, record_type: "attendance" });
    expect(n[0].sent_at).not.toBeNull();

    const second = await job();
    expect(second).toMatchObject({ ok: true, summary: { sent: 0, status_changes: 0 } });
    expect(sent).toHaveLength(1);
    expect(await notes()).toHaveLength(1);
  });

  it("no-show: two DMs, media buyer and owner, at once even though neither is on shift; never twice", async () => {
    await startedMinutesAgo(people.amanda, 40);
    const first = await job();
    expect(first).toMatchObject({ ok: true, summary: { late: 0, no_show: 1, sent: 2 } });
    expect(sent.map((s) => s.to).sort()).toEqual(["U_ADITYA", "U_RYAN"]);
    for (const s of sent) {
      expect(s.text).toMatch(/^No-show: Amanda had not clocked in 30 minutes after/);
      expect(s.text).not.toContain("Harder");
      expect(s.text).toContain("http://localhost:3000/team");
    }
    expect((await notes()).map((n) => n.rule_key)).toEqual(["attendance_no_show", "attendance_no_show"]);
    await job();
    await job();
    expect(sent).toHaveLength(2);
    expect(await notes()).toHaveLength(2);
  });

  it("late first, then no-show on a later run: 1 + 2 messages in total", async () => {
    await startedMinutesAgo(people.amanda, 15);
    await job();
    expect(sent.map((s) => s.to)).toEqual(["U_AMANDA"]);
    await startedMinutesAgo(people.amanda, 40);
    await job();
    expect(sent).toHaveLength(3);
    expect(sent.slice(1).map((s) => s.to).sort()).toEqual(["U_ADITYA", "U_RYAN"]);
  });

  it("records the alert before sending, so a send that blows up is not repeated", async () => {
    await startedMinutesAgo(people.amanda, 15);
    await expect(job({ send: async () => { throw new Error("network"); } })).rejects.toThrow("network");
    expect(await notes()).toHaveLength(1);
    await job();
    expect(sent).toHaveLength(0);
  });

  it("skips quietly when Slack is not configured or the person has no Slack id, and counts it", async () => {
    await startedMinutesAgo(people.amanda, 15);
    await db.query(`update staff set slack_user_id = null where id = $1`, [people.amanda]);
    expect(await job()).toMatchObject({ ok: true, summary: { sent: 0, skipped_no_slack_user: 1 } });
    await startedMinutesAgo(people.sameer, 15);
    expect(await job({ slackReady: false })).toMatchObject({ ok: true, summary: { sent: 0, skipped_slack_not_configured: 1 } });
    expect(sent).toHaveLength(0);
    expect((await notes()).map((n) => n.channel).sort()).toEqual(["skipped:no_slack_user", "skipped:slack_not_configured"]);
    expect(await job()).toMatchObject({ summary: { sent: 0 } });
  });

  it("no alert for a row the owner has ruled on", async () => {
    await startedMinutesAgo(people.amanda, 40);
    await db.query(`select * from attendance_tick()`);
    await db.query(`update attendance set manual = true, status = 'no_show', note = 'agreed absence'`);
    expect(await job()).toMatchObject({ summary: { sent: 0 } });
    expect(sent).toHaveLength(0);
  });
});
