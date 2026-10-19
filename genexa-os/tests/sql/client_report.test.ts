import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshDb, seedStaff } from "./db";

let db: PGlite;
const id = async (sql: string, params: unknown[] = []) => (await db.query<{ id: string }>(sql, params)).rows[0].id;
type Row = { roas_bad: boolean; name: string; spend: string | null; booked: string; shows: string; closes: string; revenue: string; roas: string | null; status: string; reasons: string[] };
const report = async (from = "app_today() - 10", to = "app_today() - 1") =>
  Object.fromEntries((await db.query<Row>(`select * from client_report(${from}, ${to})`)).rows.map((r) => [r.name, r]));
const ev = (c: string, contact: string, event: string, daysAgo: number, value: number | null = null) =>
  db.query(`insert into cortana_events (client_id, cortana_entry_id, contact_id, event, occurred_at, value) values ($1, $2, $3, $4, now() - make_interval(days => $5), $6)`,
    [c, `${c}-${contact}-${event}-${Math.random()}`, contact, event, daysAgo, value]);

beforeAll(async () => {
  db = await freshDb();
  await seedStaff(db);
  await db.query(`update integration_sync_status set last_success_at = now(), status = 'ok' where source = 'cortana'`);
  const good = await id(`insert into clients (name, stage, cortana_business_id, launch_date) values ('Good Clinic', 'live', 'b1', app_today() - 60) returning id`);
  const check = await id(`insert into clients (name, stage, cortana_business_id, launch_date) values ('Check Clinic', 'live', 'b2', app_today() - 60) returning id`);
  const nospend = await id(`insert into clients (name, stage, cortana_business_id, launch_date) values ('Quiet Clinic', 'live', 'b3', app_today() - 60) returning id`);
  await id(`insert into clients (name, stage) values ('Unconnected Clinic', 'live') returning id`);
  await id(`insert into clients (name, stage, cortana_business_id) values ('Onboarding Clinic', 'onboarding', 'b4') returning id`);
  for (const [c, s] of [[good, 100], [check, 200]] as const) for (let d = 1; d <= 10; d++) await db.query(`insert into ad_metrics_daily (client_id, date, spend) values ($1, app_today() - $2::int, $3)`, [c, d, s]);
  for (const p of ["a", "b", "c"]) await ev(good, p, "lead", 5);
  await ev(good, "a", "unconfirmed_appointment_booked", 5); await ev(good, "b", "unconfirmed_appointment_booked", 4);
  await ev(good, "a", "appointment_shown", 3); await ev(good, "a", "purchase", 2, 5000);
  await ev(check, "z", "lead", 5); await ev(check, "z", "purchase", 2, null); // a close with no amount
  void nospend;
});

describe("client_report", () => {
  it("adds up each live clinic's range and gives it a send status with reasons", async () => {
    const r = await report();
    expect(Object.keys(r).sort()).toEqual(["Check Clinic", "Good Clinic", "Quiet Clinic", "Unconnected Clinic"]); // live only
    expect(r["Good Clinic"]).toMatchObject({ spend: "1000.00", booked: "2", shows: "1", closes: "1", revenue: "5000.00", status: "good", reasons: [] });
    expect(Number(r["Good Clinic"].roas)).toBe(5);
    expect(r["Check Clinic"].status).toBe("check");
    expect(r["Check Clinic"].reasons).toEqual(["1 close with no amount", "ROAS under 3x"]);
    expect([r["Good Clinic"].roas_bad, r["Check Clinic"].roas_bad, r["Quiet Clinic"].roas_bad]).toEqual([false, true, false]);
    expect(r["Quiet Clinic"]).toMatchObject({ status: "dont_send", reasons: ["No ad spend in this range"] });
    expect(r["Unconnected Clinic"]).toMatchObject({ status: "dont_send", reasons: ["Not connected to Cortana"] });
  });

  it("flags a range that includes today, a mid-range launch, and stale Cortana", async () => {
    expect((await report("app_today() - 10", "app_today()"))["Good Clinic"].reasons).toContain("Range includes today: numbers are still coming in");
    await db.query(`update clients set launch_date = app_today() - 5 where name = 'Good Clinic'`);
    expect((await report())["Good Clinic"].reasons[0]).toMatch(/^Launched \d\d \w{3}, part way through the range$/);
    await db.query(`update integration_sync_status set last_success_at = now() - interval '3 days' where source = 'cortana'`);
    expect((await report())["Good Clinic"]).toMatchObject({ status: "dont_send" });
    expect((await report())["Good Clinic"].reasons).toContain("Cortana has not synced recently");
  });
});
