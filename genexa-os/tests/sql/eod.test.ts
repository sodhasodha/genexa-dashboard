import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { AUTH, asUser, freshDb, seedStaff, type TestPeople } from "./db";

let db: PGlite;
let people: TestPeople;
let freelancer: string;

type StatusRow = { day: string; isodow: number; filed: boolean; submitted_at: string | null; is_today: boolean; eod_id: string | null };

const status = async (staffId: string) =>
  (
    await db.query<StatusRow>(
      `select day::text as day, extract(isodow from day)::int as isodow, filed, submitted_at, is_today, eod_id
       from eod_status_7d where staff_id = $1 order by day`,
      [staffId],
    )
  ).rows;

/** Go-live n days before today (ET), or null to clear it. */
const setGoLive = (daysAgo: number | null) =>
  daysAgo === null
    ? db.query(`update app_settings set value = null where key = 'go_live_date'`)
    : db.query(`update app_settings set value = to_jsonb((app_today() - $1::int)::text) where key = 'go_live_date'`, [daysAgo]);

beforeAll(async () => {
  db = await freshDb();
  people = await seedStaff(db);
  freelancer = (await db.query<{ id: string }>(`insert into staff (name, role) values ('Freya Freelance', 'freelance') returning id`)).rows[0].id;
  // Everyone is on ET here, so a person's local day is app_today(). Amanda works all 7 days.
  await db.query(`update staff set working_days = '{1,2,3,4,5,6,7}' where id = $1`, [people.amanda]);
});

describe("eod_status_7d", () => {
  it("returns nothing until a go-live date is set", async () => {
    await setGoLive(null);
    expect((await db.query(`select 1 from eod_status_7d`)).rows.length).toBe(0);
  });

  it("lists only each person's working days in the last 7 days", async () => {
    await setGoLive(30);
    const amanda = await status(people.amanda);
    expect(amanda.length).toBe(7);
    expect(amanda.filter((r) => r.is_today).length).toBe(1);
    expect(amanda[6].is_today).toBe(true);
    expect(amanda.every((r) => !r.filed && r.submitted_at === null)).toBe(true);

    // Mon-Fri by default: any 7 consecutive days hold exactly 5 weekdays.
    const sameer = await status(people.sameer);
    expect(sameer.length).toBe(5);
    expect(sameer.every((r) => r.isodow <= 5)).toBe(true);

    await db.query(`update staff set working_days = '{}' where id = $1`, [people.aditya]);
    expect((await status(people.aditya)).length).toBe(0);
  });

  it("leaves out the owner, freelancers and leavers", async () => {
    expect((await status(people.ryan)).length).toBe(0);
    expect((await status(freelancer)).length).toBe(0);
    const roles = (await db.query<{ role: string }>(`select distinct role from eod_status_7d order by 1`)).rows.map((r) => r.role);
    expect(roles).toEqual(["csr", "tech"]);
  });

  it("starts on the person's start date", async () => {
    await db.query(`update staff set working_days = '{1,2,3,4,5,6,7}', start_date = app_today() - 2 where id = $1`, [people.marjorie]);
    const rows = await status(people.marjorie);
    expect(rows.length).toBe(3);
    const first = (await db.query<{ d: string }>(`select (app_today() - 2)::text as d`)).rows[0].d;
    expect(rows[0].day).toBe(first);
  });

  it("starts on the go-live date, and not before it is reached", async () => {
    await setGoLive(1);
    expect((await status(people.amanda)).length).toBe(2);
    expect((await status(people.marjorie)).length).toBe(2);
    await setGoLive(-1); // go-live is tomorrow
    expect((await db.query(`select 1 from eod_status_7d`)).rows.length).toBe(0);
    await setGoLive(30);
  });

  it("marks a day filed, with when it was submitted", async () => {
    await db.query(`insert into eods (staff_id, date, answers, submitted_at) values ($1, app_today() - 1, '{"v": 1}', now() - interval '20 hours')`, [
      people.amanda,
    ]);
    const rows = await status(people.amanda);
    expect(rows.filter((r) => r.filed).length).toBe(1);
    expect(rows[5].filed).toBe(true);
    expect(rows[5].submitted_at).not.toBeNull();
    expect(rows[5].eod_id).not.toBeNull();
    expect(rows[6].filed).toBe(false);
  });

  it("uses each person's own calendar day", async () => {
    // Kiritimati is UTC+14: its date is ahead of ET for most of the day, and never behind.
    await db.query(`update staff set timezone = 'Pacific/Kiritimati' where id = $1`, [people.amanda]);
    const today = (await db.query<{ d: string }>(`select (now() at time zone 'Pacific/Kiritimati')::date::text as d`)).rows[0].d;
    const rows = await status(people.amanda);
    expect(rows.find((r) => r.is_today)?.day).toBe(today);
    expect(rows[rows.length - 1].day).toBe(today);
    await db.query(`update staff set timezone = 'America/New_York' where id = $1`, [people.amanda]);
  });

  it("is readable by staff through RLS", async () => {
    await asUser(db, AUTH.sameer, async () => {
      expect((await db.query(`select 1 from eod_status_7d`)).rows.length).toBeGreaterThan(0);
    });
  });
});

describe("eod_blockers_weekly", () => {
  it("counts each CSR blocker per person per Monday-to-Sunday week", async () => {
    const file = (staffId: string, date: string, answers: object) =>
      db.query(`insert into eods (staff_id, date, answers) values ($1, $2, $3)`, [staffId, date, JSON.stringify(answers)]);
    // 2026-09-07 is a Monday.
    await file(people.amanda, "2026-09-07", { v: 1, blocker: "dialer" });
    await file(people.amanda, "2026-09-08", { v: 1, blocker: "dialer" });
    await file(people.amanda, "2026-09-09", { v: 1, blocker: "no_pickups" });
    await file(people.amanda, "2026-09-10", { v: 1, blocker: "none" }); // not a blocker
    await file(people.amanda, "2026-09-11", { focus: 4 }); // older shape, no blocker
    await file(people.amanda, "2026-09-13", { v: 1, blocker: "other", blocker_other: "Power cut" }); // Sunday, same week
    await file(people.amanda, "2026-09-14", { v: 1, blocker: "dialer" }); // next week
    await file(people.marjorie, "2026-09-09", { v: 1, blocker: "junk_leads" });
    await file(people.sameer, "2026-09-09", { v: 1, blocker: "dialer" }); // tech EOD: ignored

    const rows = (
      await db.query<{ staff_id: string; week_start: string; blocker: string; count: number }>(
        `select staff_id, week_start::text as week_start, blocker, count from eod_blockers_weekly
         where week_start in ('2026-09-07', '2026-09-14') order by staff_id = $1 desc, week_start, blocker`,
        [people.amanda],
      )
    ).rows;
    expect(rows).toEqual([
      { staff_id: people.amanda, week_start: "2026-09-07", blocker: "dialer", count: 2 },
      { staff_id: people.amanda, week_start: "2026-09-07", blocker: "no_pickups", count: 1 },
      { staff_id: people.amanda, week_start: "2026-09-07", blocker: "other", count: 1 },
      { staff_id: people.amanda, week_start: "2026-09-14", blocker: "dialer", count: 1 },
      { staff_id: people.marjorie, week_start: "2026-09-07", blocker: "junk_leads", count: 1 },
    ]);
  });
});

describe("filing rules", () => {
  const today = `(now() at time zone 'America/New_York')::date`;

  it("a staff member cannot file an EOD for someone else", async () => {
    await asUser(db, AUTH.marjorie, async () => {
      await expect(
        db.query(`insert into eods (staff_id, date, answers) values ($1, ${today}, '{"v": 1}')`, [people.amanda]),
      ).rejects.toThrow(/row-level security|EOD_OWN/);
    });
  });

  it("a staff member cannot file or edit an EOD for yesterday", async () => {
    await asUser(db, AUTH.marjorie, async () => {
      await expect(
        db.query(`insert into eods (staff_id, date, answers) values ($1, ${today} - 1, '{"v": 1}')`, [people.marjorie]),
      ).rejects.toThrow(/EOD_CLOSED/);
    });
    // Amanda's EOD for yesterday exists (filed above by the server); she cannot change it now.
    await asUser(db, AUTH.amanda, async () => {
      await expect(
        db.query(`update eods set answers = '{"v": 1, "focus": 5}' where staff_id = $1 and date = ${today} - 1`, [people.amanda]),
      ).rejects.toThrow(/EOD_CLOSED/);
    });
  });

  it("files today's EOD and edits it with the same upsert the app uses", async () => {
    const upsert = (focus: number) =>
      db.query(
        `insert into eods (staff_id, date, role, answers) values ($1, ${today}, 'csr', $2)
         on conflict (staff_id, date) do update set role = excluded.role, answers = excluded.answers`,
        [people.marjorie, JSON.stringify({ v: 1, hours_worked: 8, blocker: "none", blocker_other: null, patient_flag: null, focus })],
      );
    await asUser(db, AUTH.marjorie, async () => {
      await upsert(3);
      await upsert(5);
    });
    const rows = (await db.query<{ focus: number; role: string }>(
      `select (answers ->> 'focus')::int as focus, role from eods where staff_id = $1 and date = ${today}`,
      [people.marjorie],
    )).rows;
    expect(rows).toEqual([{ focus: 5, role: "csr" }]);
    const marjorieToday = (await status(people.marjorie)).find((r) => r.is_today);
    expect(marjorieToday?.filed).toBe(true);
  });

  it("the day is the person's own: today in their timezone is open, the day before is closed", async () => {
    await db.query(`update staff set timezone = 'Pacific/Kiritimati' where id = $1`, [people.amanda]);
    const local = `(now() at time zone 'Pacific/Kiritimati')::date`;
    await asUser(db, AUTH.amanda, async () => {
      // Clear of the dates used above: local today is at least ET today.
      const r = await db.query(
        `insert into eods (staff_id, date, answers) values ($1, ${local}, '{"v": 1}')
         on conflict (staff_id, date) do update set answers = excluded.answers returning id`,
        [people.amanda],
      );
      expect(r.rows.length).toBe(1);
      await expect(
        db.query(`insert into eods (staff_id, date, answers) values ($1, ${local} - 2, '{"v": 1}')`, [people.amanda]),
      ).rejects.toThrow(/EOD_CLOSED/);
    });
  });
});
