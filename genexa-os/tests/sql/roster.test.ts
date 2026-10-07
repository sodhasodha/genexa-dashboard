import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { AUTH, asUser, freshDb, seedStaff, type TestPeople } from "./db";

let db: PGlite;
let people: TestPeople;

beforeAll(async () => {
  db = await freshDb();
  people = await seedStaff(db);
  await db.query(`update staff set shift_start = '09:00', shift_end = '17:00', timezone = 'America/New_York', working_days = '{1,2,3,4,5,6,7}' where id = $1`, [people.amanda]);
});

const day = (offset: number) => `((now() at time zone 'America/New_York')::date + ${offset})`;
const row = async (offset: number) =>
  (await db.query<{ is_working: boolean; excused: boolean; override_kind: string | null; rostered_minutes: number | null; start_et: string | null }>(
    `select is_working, excused, override_kind, rostered_minutes, to_char(starts_at at time zone 'America/New_York', 'HH24:MI') as start_et
     from shifts_resolved where staff_id = $1 and date = ${day(offset)}`, [people.amanda])).rows[0];

describe("shifts_resolved (roster after overrides)", () => {
  it("gives the normal shift on a rostered day", async () => {
    expect(await row(1)).toEqual({ is_working: true, excused: false, override_kind: null, rostered_minutes: 480, start_et: "09:00" });
  });
  it("a sick or holiday override means not working and excused", async () => {
    await db.query(`insert into shift_overrides (staff_id, date, kind, note) values ($1, ${day(2)}, 'sick', 'Flu')`, [people.amanda]);
    expect(await row(2)).toMatchObject({ is_working: false, excused: true, override_kind: "sick", rostered_minutes: null });
  });
  it("a swap with times replaces the hours for that day", async () => {
    await db.query(`insert into shift_overrides (staff_id, date, kind, shift_start, shift_end) values ($1, ${day(3)}, 'swap', '13:00', '19:00')`, [people.amanda]);
    expect(await row(3)).toMatchObject({ is_working: true, excused: false, override_kind: "swap", rostered_minutes: 360, start_et: "13:00" });
  });
  it("someone with no shift has no roster rows; an override can add a working day", async () => {
    const n = async () => (await db.query(`select 1 from shifts_resolved where staff_id = $1`, [people.marjorie])).rows.length;
    expect(await n()).toBe(0);
    await db.query(`insert into shift_overrides (staff_id, date, kind, shift_start, shift_end) values ($1, ${day(1)}, 'custom', '10:00', '14:00')`, [people.marjorie]);
    expect(await n()).toBe(1);
  });
  it("only the owner writes overrides and attendance; sick days cannot carry hours", async () => {
    await asUser(db, AUTH.amanda, async () => {
      await expect(db.query(`insert into shift_overrides (staff_id, date, kind) values ($1, ${day(5)}, 'holiday')`, [people.amanda])).rejects.toThrow(/row-level security/);
      await expect(db.query(`insert into attendance (staff_id, date, status) values ($1, ${day(0)}, 'on_time')`, [people.amanda])).rejects.toThrow(/row-level security/);
    });
    await expect(db.query(`insert into shift_overrides (staff_id, date, kind, shift_start, shift_end) values ($1, ${day(6)}, 'sick', '09:00', '10:00')`, [people.amanda])).rejects.toThrow();
  });
});
