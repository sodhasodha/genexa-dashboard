import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshDb, seedStaff } from "./db";

let db: PGlite;
let clinic: string;
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];

beforeAll(async () => {
  db = await freshDb();
  await seedStaff(db);
  clinic = (await one<{ id: string }>(`insert into clients (name, stage) values ('Verify Clinic', 'live') returning id`)).id;
  await db.query(`insert into cortana_events (client_id, cortana_entry_id, contact_id, event, occurred_at, value) values
    ($1, 'keep', 'p1', 'purchase', now() - interval '2 days', 5000), ($1, 'gone', 'p2', 'purchase', now() - interval '2 days', 9000), ($1, 'lead1', 'p3', 'lead', now() - interval '3 days', null)`, [clinic]);
});

describe("events Cortana no longer has", () => {
  it("stop counting, and are kept in the archive", async () => {
    const before = await one<{ revenue: string; closes: string }>(`select revenue, closes from client_funnel_period(app_today() - 7, app_today()) where client_id = $1`, [clinic]);
    expect([Number(before.revenue), Number(before.closes)]).toEqual([14000, 2]);
    const n = await one<{ n: number }>(`select cortana_events_archive($1, array['gone', 'not-there']) as n`, [clinic]);
    expect(n.n).toBe(1);
    const after = await one<{ revenue: string; closes: string }>(`select revenue, closes from client_funnel_period(app_today() - 7, app_today()) where client_id = $1`, [clinic]);
    expect([Number(after.revenue), Number(after.closes)]).toEqual([5000, 1]);
    const kept = await one<{ event: string; value: string; removed: boolean }>(`select event, value, removed_at is not null as removed from cortana_events_removed where cortana_entry_id = 'gone'`);
    expect(kept).toEqual({ event: "purchase", value: "9000.00", removed: true });
    // Running it again changes nothing.
    expect((await one<{ n: number }>(`select cortana_events_archive($1, array['gone']) as n`, [clinic])).n).toBe(0);
  });

  it("a row cannot be deleted any other way, and the archive cannot be deleted at all", async () => {
    await expect(db.query(`delete from cortana_events where cortana_entry_id = 'keep'`)).rejects.toThrow(/Hard deletes are not allowed/);
    await expect(db.query(`delete from cortana_events_removed`)).rejects.toThrow();
    expect((await db.query(`select 1 from cortana_events where client_id = $1`, [clinic])).rows.length).toBe(2);
  });

  it("the latest check per clinic carries what the last 7 days of checks corrected", async () => {
    await db.query(`insert into cortana_checks (client_id, checked_at, events_from, spend_from, spend_to, spend_ours, spend_cortana, events_cortana, events_added, events_removed, spend_days_reread, matched)
      values ($1, now() - interval '2 days', '2026-08-01', app_today() - 30, app_today() - 1, 100, 110, 3, 2, 1, 30, false),
             ($1, now() - interval '9 days', '2026-08-01', app_today() - 30, app_today() - 1, 100, 100, 3, 7, 0, 0, false),
             ($1, now(), '2026-08-01', app_today() - 30, app_today() - 1, 110, 110, 3, 0, 0, 0, true)`, [clinic]);
    const l = await one<{ matched: boolean; added_7d: number; removed_7d: number; days_reread_7d: number }>(`select matched, added_7d, removed_7d, days_reread_7d from cortana_check_latest where client_id = $1`, [clinic]);
    expect(l).toEqual({ matched: true, added_7d: 2, removed_7d: 1, days_reread_7d: 30 });
  });
});
