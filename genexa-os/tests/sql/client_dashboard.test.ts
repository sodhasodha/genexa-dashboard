import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { AUTH, asUser, freshDb, seedStaff } from "./db";

let db: PGlite;
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const all = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const client = async (name: string) => (await one<{ id: string }>(`insert into clients (name, stage) values ($1, 'live') returning id`, [name])).id;
/** Put a client on the dashboard, tracking from `fromDaysAgo` days ago. */
const connect = async (clientId: string, fromDaysAgo = 30) =>
  (await one<{ id: string }>(
    `insert into dashboard_clinics (dashboard_clinic_id, client_id, name, timezone, tracking_from, last_success_at)
     values (gen_random_uuid(), $1, 'Dash', 'America/New_York', app_today() - $2::int, now()) returning dashboard_clinic_id as id`, [clientId, fromDaysAgo])).id;
let n = 0;
const patient = (clientId: string, dash: string, o: { stage: string; consultHoursAgo?: number | null; revenue?: number; purchaseDaysAgo?: number | null; cancelled?: boolean; gone?: boolean }) =>
  db.query(
    `insert into dashboard_patients (client_id, dashboard_clinic_id, contact_id, first_name, stage, consult_at, appointment_cancelled, revenue, purchase_date, gone_at)
     values ($1, $2, $3, 'Jane', $4, case when $5::int is null then null else now() - make_interval(hours => $5::int) end, $6, $7,
       case when $8::int is null then null else app_today() - $8::int end, case when $9 then now() end)`,
    [clientId, dash, `c${++n}`, o.stage, o.consultHoursAgo ?? null, o.cancelled ?? false, o.revenue ?? 0, o.purchaseDaysAgo ?? null, o.gone ?? false]);
const cortana = (clientId: string, event: string, daysAgo: number, value: number | null = null) =>
  db.query(`insert into cortana_events (client_id, cortana_entry_id, event, occurred_at, value, contact_id) values ($1, gen_random_uuid()::text, $2, now() - make_interval(days => $3::int), $4, gen_random_uuid()::text)`,
    [clientId, event, daysAgo, value]);
const revenue = async (clientId: string, fromDaysAgo: number) =>
  Number((await one<{ r: string }>(`select coalesce(sum(revenue), 0) as r from client_performance_daily where client_id = $1 and day >= app_today() - $2::int`, [clientId, fromDaysAgo])).r);

beforeAll(async () => {
  db = await freshDb();
  await seedStaff(db);
  // Flags from a stale source are hidden; these tests are about the flags, so every source is fresh.
  await db.query(`update integration_sync_status set last_success_at = now(), last_attempt_at = now()`);
});

describe("revenue, closes and shows come from the client dashboard where a clinic is on it", () => {
  it("from the tracking day the dashboard replaces Cortana's purchases and shows; before it, and for clinics not on it, Cortana counts", async () => {
    const on = await client("On Dashboard");
    const dash = await connect(on, 30);
    await cortana(on, "purchase", 40, 1000); // before tracking: kept
    await cortana(on, "purchase", 5, 9999); // after tracking: replaced by the dashboard
    await cortana(on, "appointment_shown", 5);
    await cortana(on, "lead", 5); // leads still from Cortana
    await patient(on, dash, { stage: "closed_won", consultHoursAgo: 24 * 10, revenue: 3000, purchaseDaysAgo: 3 });
    await patient(on, dash, { stage: "closed_won", consultHoursAgo: 24 * 6, revenue: 2000 }); // no payment date: counted on the appointment
    await patient(on, dash, { stage: "closed_won", consultHoursAgo: 24 * 6, revenue: 0 }); // no revenue: not a close
    await patient(on, dash, { stage: "not_closed", consultHoursAgo: 24 * 4 });
    await patient(on, dash, { stage: "no_show", consultHoursAgo: 24 * 4 });
    await patient(on, dash, { stage: "closed_won", consultHoursAgo: 24 * 4, revenue: 500, gone: true }); // gone from the dashboard
    expect(await revenue(on, 60)).toBe(1000 + 3000 + 2000);
    const m = await one<Record<string, string>>(
      `select sum(closes) as closes, sum(shows) as shows, sum(no_shows) as no_shows, sum(leads) as leads from client_performance_daily where client_id = $1 and day >= app_today() - 20`, [on]);
    expect(m).toEqual({ closes: "2", shows: "4", no_shows: "1", leads: "1" }); // a close with no revenue still attended
    const paid = await one<{ day: string }>(`select day::text from client_performance_daily where client_id = $1 and revenue = 3000`, [on]);
    expect(paid.day).toBe((await one<{ d: string }>(`select (app_today() - 3)::text as d`)).d);

    const off = await client("Not On Dashboard");
    await cortana(off, "purchase", 5, 700);
    expect(await revenue(off, 60)).toBe(700);
  });

  it("rev share bills the dashboard's revenue and its new paying patients", async () => {
    const c = await client("Billed");
    await db.query(`update clients set rev_share_type = 'per_patient', rev_share_per_patient = 150 where id = $1`, [c]);
    const dash = await connect(c, 30);
    await cortana(c, "purchase", 5, 5000); // replaced
    await patient(c, dash, { stage: "closed_won", consultHoursAgo: 24 * 8, revenue: 4000, purchaseDaysAgo: 2 });
    await patient(c, dash, { stage: "closed_won", consultHoursAgo: 24 * 8, revenue: 1500, purchaseDaysAgo: 2 });
    const r = await one<{ revenue: string; new_patients: string; owed: string }>(`select revenue, new_patients, owed from rev_share_period(app_today() - 10, app_today()) where client_id = $1`, [c]);
    expect({ revenue: Number(r.revenue), new_patients: Number(r.new_patients), owed: Number(r.owed) }).toEqual({ revenue: 5500, new_patients: 2, owed: 300 });
  });
});

describe("what a clinic owes is the dashboard's list", () => {
  it("Booked 24h+ after the appointment (not cancelled) and closes with no revenue; the amber flag says so", async () => {
    const c = await client("Owes");
    const dash = await connect(c);
    await patient(c, dash, { stage: "appointments_booked", consultHoursAgo: 30 });
    await patient(c, dash, { stage: "appointments_booked", consultHoursAgo: 23 }); // not yet
    await patient(c, dash, { stage: "appointments_booked", consultHoursAgo: 30, cancelled: true });
    await patient(c, dash, { stage: "appointments_booked", consultHoursAgo: -5 }); // still to come
    await patient(c, dash, { stage: "closed_won", consultHoursAgo: 50, revenue: 0 });
    await patient(c, dash, { stage: "showed", consultHoursAgo: 50 });
    await patient(c, dash, { stage: "appointments_booked", consultHoursAgo: 80, gone: true });
    // An old GHL appointment with no outcome no longer counts for a clinic on the dashboard.
    await db.query(`insert into appointments (client_id, ghl_contact_id, scheduled_for) values ($1, 'old', now() - interval '20 days')`, [c]);
    expect((await all<{ kind: string }>(`select kind from outcomes_owed where client_id = $1 order by kind`, [c])).map((r) => r.kind)).toEqual(["missing_revenue", "overdue"]);
    const flag = await one<{ detail: string }>(`select reason as detail from client_health_reasons where client_id = $1 and rule = 'outcomes_overdue'`, [c]);
    expect(flag.detail).toBe("1 outcomes overdue, 1 closes missing revenue on the client dashboard");
    const review = await all<{ title: string; record_table: string }>(`select title, record_table from data_review_open where client_id = $1 and kind = 'unlogged_outcome'`, [c]);
    expect(review).toHaveLength(2);
    expect(review.every((r) => r.record_table === "dashboard_patients")).toBe(true);
  });

  it("a clinic not on the dashboard keeps the GHL appointments rule", async () => {
    const c = await client("Not On It");
    await db.query(`insert into appointments (client_id, ghl_contact_id, scheduled_for) values ($1, 'x', now() - interval '3 days')`, [c]);
    expect(await all(`select source from outcomes_owed where client_id = $1`, [c])).toEqual([{ source: "appointments" }]);
    expect((await one<{ detail: string }>(`select reason as detail from client_health_reasons where client_id = $1 and rule = 'outcomes_overdue'`, [c])).detail).toBe("1 outcomes overdue 48h+");
  });

  it("the Monday clinic nudge counts the dashboard's overdue outcomes", async () => {
    const c = await client("Nudged");
    const dash = await connect(c);
    await patient(c, dash, { stage: "appointments_booked", consultHoursAgo: 30 });
    await patient(c, dash, { stage: "appointments_booked", consultHoursAgo: 24 * 40 });
    await patient(c, dash, { stage: "closed_won", consultHoursAgo: 50, revenue: 0 }); // not an outcome to log
    expect(await one(`select overdue_count, uncertain_count from outcome_nudges_due where client_id = $1`, [c])).toEqual({ overdue_count: 2, uncertain_count: 0 });
  });

  it("staff can read the dashboard copy; CSRs cannot; nothing is deleted", async () => {
    const c = await client("Read");
    const dash = await connect(c);
    await patient(c, dash, { stage: "showed", consultHoursAgo: 50 });
    expect((await asUser(db, AUTH.aditya, () => all(`select 1 from dashboard_patients where client_id = $1`, [c]))).length).toBe(1);
    expect(await asUser(db, AUTH.amanda, () => all(`select 1 from dashboard_patients`))).toEqual([]);
    await expect(db.query(`delete from dashboard_patients where client_id = $1`, [c])).rejects.toThrow();
  });
});
