import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshDb, seedStaff, type TestPeople } from "./db";

let db: PGlite;
let people: TestPeople;
let clinic: string;

const run = async () => (await db.query<{ exception_id: string; action: string; exception_type: string }>(`select * from run_exceptions_engine()`)).rows;
const open = async (type?: string) =>
  (
    await db.query<{ id: string; type: string; status: string; owner_id: string; money_at_risk: string; reason: string; client_id: string }>(
      `select * from exceptions where status in ('open','snoozed') ${type ? `and type = '${type}'` : ""} order by type`,
    )
  ).rows;
const fresh = (source: string, minutesAgo = 5) =>
  db.query(`update integration_sync_status set last_success_at = now() - ($2 || ' minutes')::interval, status = 'ok' where source = $1`, [source, String(minutesAgo)]);

beforeEach(async () => {
  db = await freshDb();
  people = await seedStaff(db);
  clinic = (
    await db.query<{ id: string }>(
      `insert into clients (name, stage, cortana_business_id, billing_cycle, cycle_fee, launch_date)
       values ('Zero Clinic', 'live', 'biz-1', '90', 5000, app_today() - 30) returning id`,
    )
  ).rows[0].id;
  await fresh("cortana");
});

const spend = (clientId: string, daysAgo: number, amount: number) =>
  db.query(`insert into ad_metrics_daily (client_id, date, spend) values ($1, app_today() - $2::int, $3)`, [clientId, daysAgo, amount]);

describe("zero spend", () => {
  it("opens once for the media buyer with the renewal amount at risk, then refreshes, then auto-resolves", async () => {
    await spend(clinic, 1, 0);
    const first = await run();
    expect(first.filter((r) => r.action === "opened").map((r) => r.exception_type)).toEqual(["zero_spend"]);
    const [ex] = await open("zero_spend");
    expect(ex.owner_id).toBe(people.aditya);
    expect(Number(ex.money_at_risk)).toBe(5000);
    expect(ex.reason).toMatch(/^Zero Clinic: \$0 ad spend since /);

    const second = await run();
    expect(second.map((r) => r.action)).toEqual(["refreshed"]);
    expect((await open("zero_spend")).length).toBe(1);

    await db.query(`insert into ad_metrics_daily (client_id, date, spend) values ($1, app_today(), 42.5)`, [clinic]);
    const third = await run();
    expect(third.map((r) => r.action)).toEqual(["resolved"]);
    expect(await open("zero_spend")).toEqual([]);
    const resolved = await db.query<{ resolved_by: string }>(`select resolved_by from exceptions where type = 'zero_spend'`);
    expect(resolved.rows[0].resolved_by).toBe("system");
  });

  it("does not fire when yesterday has no row at all (no data is not $0)", async () => {
    expect(await run()).toEqual([]);
  });

  it("does not fire for a clinic that is not live, not connected, or whose campaign scope is unverified", async () => {
    await spend(clinic, 1, 0);
    await db.query(`update clients set stage = 'paused' where id = $1`, [clinic]);
    expect(await run()).toEqual([]);
    await db.query(`update clients set stage = 'live', cortana_business_id = null where id = $1`, [clinic]);
    expect(await run()).toEqual([]);
    await db.query(`update clients set cortana_business_id = 'biz-1' where id = $1`, [clinic]);
    await db.query(`insert into client_campaign_scope (client_id, verified, note) values ($1, false, 'shares an ad account')`, [clinic]);
    expect(await run()).toEqual([]);
    await db.query(`update client_campaign_scope set verified = true where client_id = $1`, [clinic]);
    expect((await run()).map((r) => r.action)).toEqual(["opened"]);
  });
});

describe("stale sources", () => {
  it("a rule does not fire while its source is stale, and fires once the source is fresh", async () => {
    await spend(clinic, 1, 0);
    await fresh("cortana", 121); // schedule is 60 min: stale after 120
    expect(await run()).toEqual([]);
    expect(await open()).toEqual([]);
    await fresh("cortana", 10);
    expect((await run()).map((r) => r.action)).toEqual(["opened"]);
  });

  it("an open exception is neither refreshed nor resolved while its source is stale", async () => {
    await spend(clinic, 1, 0);
    await run();
    await db.query(`update exceptions set last_detected_at = now() - interval '3 hours'`);
    // Spend comes back, but the source then goes stale: we cannot know, so nothing changes.
    await db.query(`insert into ad_metrics_daily (client_id, date, spend) values ($1, app_today(), 80)`, [clinic]);
    await fresh("cortana", 500);
    expect(await run()).toEqual([]);
    const [ex] = await open("zero_spend");
    expect(ex.status).toBe("open");
    await fresh("cortana", 1);
    expect((await run()).map((r) => r.action)).toEqual(["resolved"]);
  });

  it("cost per booked uses Cortana spend and Cortana bookings; rules with no source always run", async () => {
    // $900 spend, 3 bookings in 7 days = $300 per booked: over the $110 line.
    for (let d = 1; d <= 3; d++) await spend(clinic, d, 300);
    for (let i = 0; i < 3; i++) {
      await db.query(
        `insert into cortana_events (client_id, cortana_entry_id, event, occurred_at, contact_id) values ($1, $2, 'unconfirmed_appointment_booked', now() - interval '2 days', $2)`,
        [clinic, `b${i}`],
      );
    }
    // A test contact's booking must not bring the cost per booked down.
    await db.query(
      `insert into cortana_events (client_id, cortana_entry_id, event, occurred_at, contact_id, is_test) values ($1, 'bt', 'unconfirmed_appointment_booked', now() - interval '2 days', 'bt', true)`,
      [clinic],
    );
    await db.query(`insert into tech_jobs (type, title, owner_id, requested_at) values ('launch', 'Old launch', $1, now() - interval '5 days')`, [people.sameer]);
    await fresh("cortana", 500);
    // Cortana stale: the cost-per-booked rule stays quiet, the tech rule does not.
    expect((await run()).map((r) => r.exception_type)).toEqual(["tech_job_overdue"]);
    await fresh("cortana", 5);
    const opened = (await run()).filter((r) => r.action === "opened");
    expect(opened.map((r) => r.exception_type)).toEqual(["account_cpb_high"]);
    const [ex] = await open("account_cpb_high");
    expect(ex.reason).toBe("Zero Clinic: 7d cost per booked $300 (3 booked on $900)");
  });
});

describe("ad rules", () => {
  const ad = (period: string, id: string, v: Record<string, unknown>) =>
    db.query(
      `insert into ad_metrics_ad_window (client_id, ad_id, period, ad_name, ad_status, window_start, window_end, spend, impressions, clicks, ctr, frequency, leads, booked)
       values ($1, $2, $3, $4, $5, app_today() - 7, app_today(), $6, 1000, 10, $7, $8, $9, $10)`,
      [clinic, id, period, v.name ?? id, v.status ?? "ACTIVE", v.spend ?? 50, v.ctr ?? 1, v.frequency ?? 1.2, v.leads ?? 0, v.booked ?? 0],
    );

  it("flags fatigue on 7d frequency over 3 or CTR down 30% vs all-time, active ads only", async () => {
    await ad("7d", "freq", { frequency: 3.4 });
    await ad("7d", "ctr", { ctr: 0.69 });
    await ad("all", "ctr", { ctr: 1.0 });
    await ad("7d", "fine", { ctr: 0.75, frequency: 2.9 });
    await ad("all", "fine", { ctr: 1.0 });
    await ad("7d", "paused", { frequency: 5, status: "PAUSED" });
    await run();
    const rows = await open("ad_fatigue");
    expect(rows.map((r) => r.reason).sort()).toEqual([
      "Zero Clinic · ctr: 7d CTR 0.69% vs 1.00% all-time",
      "Zero Clinic · freq: 7d frequency 3.40",
    ]);
  });

  it("flags $150 with 0 bookings, cost per booked over $150 after $250, and booking rate under 25% after 10 leads", async () => {
    await ad("all", "a", { spend: 151, booked: 0, leads: 3 });
    await ad("all", "b", { spend: 400, booked: 2, leads: 9 });
    await ad("all", "c", { spend: 100, booked: 2, leads: 10 });
    await ad("all", "ok1", { spend: 149, booked: 0, leads: 2 });
    await ad("all", "ok2", { spend: 400, booked: 4, leads: 12 });
    await run();
    expect((await open("ad_performance")).map((r) => r.reason).sort()).toEqual([
      "Zero Clinic · a: $151 spent, 0 bookings",
      "Zero Clinic · b: cost per booked $200 on $400",
      "Zero Clinic · c: booking rate 20% on 10 leads",
    ]);
  });

  it("flags a disapproved ad", async () => {
    await ad("7d", "bad", { status: "DISAPPROVED" });
    await run();
    expect((await open("ad_disapproved")).map((r) => r.reason)).toEqual(["Zero Clinic · bad: disapproved by Meta"]);
  });
});

describe("tech rules", () => {
  it("an overdue job opens for its owner and resolves when done; a paused job does not open", async () => {
    const job = (
      await db.query<{ id: string }>(
        `insert into tech_jobs (type, title, owner_id, requested_at) values ('fix', 'Calendar broken', $1, now() - interval '9 days') returning id`,
        [people.sameer],
      )
    ).rows[0].id;
    const paused = (
      await db.query<{ id: string }>(
        `insert into tech_jobs (type, title, owner_id, requested_at) values ('launch', 'Waiting on access', $1, now() - interval '9 days') returning id`,
        [people.sameer],
      )
    ).rows[0].id;
    await db.query(
      `insert into sla_pauses (tech_job_id, paused_at, reason, evidence_note) values ($1, now() - interval '8 days 23 hours', 'client_access', 'Slack thread')`,
      [paused],
    );
    const first = await run();
    expect(first.filter((r) => r.action === "opened").map((r) => r.exception_type).sort()).toEqual(["sla_pause_long", "tech_job_overdue"]);
    const [overdue] = await open("tech_job_overdue");
    expect(overdue.owner_id).toBe(people.sameer);
    expect(overdue.reason).toMatch(/^Calendar broken: \d+ min over SLA$/);
    const [pause] = await open("sla_pause_long");
    expect(pause.owner_id).toBe(people.ryan);

    await db.query(`update tech_jobs set status = 'done' where id = $1`, [job]);
    const second = await run();
    expect(second.filter((r) => r.action === "resolved").map((r) => r.exception_type)).toEqual(["tech_job_overdue"]);
  });

  it("a launch past 48h puts the cycle fee at risk", async () => {
    const l = await db.query<{ id: string }>(
      `insert into launches (client_id, paid_at, ob_form_done_at, access_done_at, owner_id)
       values ($1, now() - interval '10 days', now() - interval '5 days', now() - interval '4 days', $2) returning id`,
      [clinic, people.sameer],
    );
    expect(l.rows.length).toBe(1);
    await run();
    const [ex] = await open("launch_sla_breached");
    expect(Number(ex.money_at_risk)).toBe(5000);
    expect(ex.reason).toMatch(/^Zero Clinic: launch \d+h past the 48h SLA$/);
  });
});

describe("snooze and reopen", () => {
  it("a snoozed exception stays one row, wakes when the snooze ends, and a resolved one can reopen", async () => {
    await spend(clinic, 1, 0);
    await run();
    await db.query(`update exceptions set status = 'snoozed', snoozed_until = now() + interval '1 hour', snooze_reason = 'Client paused ads'`);
    expect((await run()).map((r) => r.action)).toEqual(["refreshed"]);
    expect((await open("zero_spend"))[0].status).toBe("snoozed");
    await db.query(`update exceptions set snoozed_until = now() - interval '1 minute'`);
    await run();
    expect((await open("zero_spend"))[0].status).toBe("open");
    await db.query(`update exceptions set status = 'resolved', resolved_at = now(), resolved_by = 'Ryan'`);
    expect((await run()).map((r) => r.action)).toEqual(["opened"]);
    const all = await db.query(`select 1 from exceptions where type = 'zero_spend'`);
    expect(all.rows.length).toBe(2);
  });

  it("the engine's refresh does not flood the audit log", async () => {
    await spend(clinic, 1, 0);
    await run();
    const before = (await db.query<{ n: number }>(`select count(*)::int as n from audit_log where table_name = 'exceptions'`)).rows[0].n;
    await run();
    await run();
    const after = (await db.query<{ n: number }>(`select count(*)::int as n from audit_log where table_name = 'exceptions'`)).rows[0].n;
    expect(after).toBe(before);
  });
});
