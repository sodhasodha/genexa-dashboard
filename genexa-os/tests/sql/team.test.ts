import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { AUTH, asUser, freshDb, seedStaff, type TestPeople } from "./db";

let db: PGlite;
let people: TestPeople;

beforeAll(async () => {
  db = await freshDb();
  people = await seedStaff(db);
});

const hours = async (staffId: string, isodow: number) =>
  (await db.query<{ et_hour: number }>(`select et_hour from team_coverage_hourly where staff_id = $1 and isodow = $2 order by et_hour`, [staffId, isodow])).rows.map((r) => r.et_hour);

describe("shift rota and coverage", () => {
  it("places an ET shift on the right ET hours, working days only", async () => {
    await db.query(`update staff set shift_start = '09:00', shift_end = '17:00', timezone = 'America/New_York' where id = $1`, [people.sameer]);
    expect(await hours(people.sameer, 1)).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
    expect(await hours(people.sameer, 6)).toEqual([]);
  });

  it("converts a Manila night shift into ET hours, including the overnight wrap", async () => {
    // 21:00-05:00 Manila, Mon-Fri. Manila is 12h ahead of ET in summer time and 13h in winter.
    await db.query(`update staff set shift_start = '21:00', shift_end = '05:00', timezone = 'Asia/Manila', working_days = '{1,2,3,4,5}' where id = $1`, [people.amanda]);
    const offset = (await db.query<{ h: number }>(
      `select extract(hour from ((app_week_start(app_today()) + time '21:00') at time zone 'Asia/Manila') at time zone 'America/New_York')::int as h`,
    )).rows[0].h;
    const expected = Array.from({ length: 8 }, (_, i) => offset + i);
    expect([8, 9]).toContain(offset);
    expect(await hours(people.amanda, 1)).toEqual(expected);
    expect(await hours(people.amanda, 5)).toEqual(expected);
    expect(await hours(people.amanda, 6)).toEqual([]);
  });

  it("summarises cover per hour and flags CSR gaps inside the expected window", async () => {
    await db.query(`update staff set shift_start = '08:00', shift_end = '12:00', timezone = 'America/New_York', working_days = '{1}' where id = $1`, [people.marjorie]);
    await db.query(`update staff set shift_start = null, shift_end = null where id = $1`, [people.amanda]);
    const rows = await db.query<{ et_hour: number; csrs_on: string; pod_1_on: string; tech_on: string; csr_gap: boolean; cover_expected: boolean; who: string | null }>(
      `select * from team_coverage_summary where isodow = 1 order by et_hour`,
    );
    const at = (h: number) => rows.rows.find((r) => r.et_hour === h)!;
    expect(rows.rows.length).toBe(24);
    expect(Number(at(9).csrs_on)).toBe(1);
    expect(Number(at(9).pod_1_on)).toBe(1);
    expect(Number(at(9).tech_on)).toBe(1);
    expect(at(9).who).toBe("Marjorie Grace Villarino, Sameer");
    expect(at(9).csr_gap).toBe(false);
    expect(at(13).csr_gap).toBe(true); // inside 08-22 with no CSR on
    expect(at(23).csr_gap).toBe(false); // outside the expected window
    expect(at(23).cover_expected).toBe(false);
  });

  it("only the owner can change a shift", async () => {
    await asUser(db, AUTH.amanda, async () => {
      const r = await db.query(`update staff set shift_start = '10:00' where id = $1 returning id`, [people.amanda]);
      expect(r.rows.length).toBe(0);
    });
    await asUser(db, AUTH.ryan, async () => {
      const r = await db.query(`update staff set shift_start = '10:00', shift_end = '18:00', working_days = '{1,2,3,4,5,6}' where id = $1 returning id`, [people.amanda]);
      expect(r.rows.length).toBe(1);
    });
    await expect(db.query(`update staff set working_days = '{0,8}' where id = $1`, [people.amanda])).rejects.toThrow();
  });
});
