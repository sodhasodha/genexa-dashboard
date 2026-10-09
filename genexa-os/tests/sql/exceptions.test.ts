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
  // A $0 yesterday comes with today's own reading (also $0 so far): the rule needs both.
  db.query(
    `insert into ad_metrics_daily (client_id, date, spend)
     select $1, d, s from (values (app_today() - $2::int, $3::numeric), (app_today(), case when $2::int = 1 and $3::numeric = 0 then 0::numeric end)) v(d, s)
     where s is not null on conflict (client_id, date) do update set spend = excluded.spend`,
    [clientId, daysAgo, amount]);

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

    await db.query(`insert into ad_metrics_daily (client_id, date, spend) values ($1, app_today(), 42.5) on conflict (client_id, date) do update set spend = excluded.spend`, [clinic]);
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
    await db.query(`insert into ad_metrics_daily (client_id, date, spend) values ($1, app_today(), 80) on conflict (client_id, date) do update set spend = excluded.spend`, [clinic]);
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
  it("a snoozed exception stays one row and wakes when the snooze ends", async () => {
    await spend(clinic, 1, 0);
    await run();
    await db.query(`update exceptions set status = 'snoozed', snoozed_until = now() + interval '1 hour', snooze_reason = 'Client paused ads'`);
    expect((await run()).map((r) => r.action)).toEqual(["refreshed"]);
    expect((await open("zero_spend"))[0].status).toBe("snoozed");
    await db.query(`update exceptions set snoozed_until = now() - interval '1 minute'`);
    await run();
    expect((await open("zero_spend"))[0].status).toBe("open");
  });

  it("resolved by a person stays resolved while the rule still matches", async () => {
    await spend(clinic, 1, 0);
    await run();
    await db.query(`update exceptions set status = 'resolved', resolved_at = now(), resolved_by = 'Ryan', resolution_note = 'Client asked to pause'`);
    expect((await db.query<{ held: boolean }>(`select held from exceptions`)).rows[0].held).toBe(true);
    expect(await run()).toEqual([]);
    expect(await run()).toEqual([]);
    expect(await open("zero_spend")).toEqual([]);
    expect((await db.query(`select 1 from exceptions where type = 'zero_spend'`)).rows.length).toBe(1);
  });

  it("comes back as a new bottleneck when the condition clears and later returns", async () => {
    await spend(clinic, 1, 0);
    await run();
    await db.query(`update exceptions set status = 'resolved', resolved_at = now(), resolved_by = 'Ryan'`);
    await db.query(`insert into ad_metrics_daily (client_id, date, spend) values ($1, app_today(), 30) on conflict (client_id, date) do update set spend = excluded.spend`, [clinic]);
    expect(await run()).toEqual([]); // cleared: nothing to open, the hold is let go
    const released = await db.query<{ held: boolean; hold_release_reason: string }>(`select held, hold_release_reason from exceptions`);
    expect(released.rows[0]).toEqual({ held: false, hold_release_reason: "cleared" });
    await db.query(`update ad_metrics_daily set spend = 0 where client_id = $1 and date = app_today()`, [clinic]);
    expect((await run()).map((r) => r.action)).toEqual(["opened"]);
    expect((await db.query(`select 1 from exceptions where type = 'zero_spend'`)).rows.length).toBe(2);
  });

  it("comes back when it gets worse: $0 spend resolved early and still $0 three days on, once", async () => {
    await spend(clinic, 1, 0);
    await run();
    await db.query(`update exceptions set status = 'resolved', resolved_at = now(), resolved_by = 'Ryan'`);
    expect(await run()).toEqual([]);
    // Three days later it is still $0.
    await db.query(`update exceptions set first_detected_at = now() - interval '3 days 1 hour', resolved_at = now() - interval '3 days'`);
    expect((await run()).map((r) => r.action)).toEqual(["opened"]);
    const [again] = await open("zero_spend");
    expect(again.reason).toMatch(/worse since it was resolved/);
    // Resolved a second time: the three-day rule does not fire again for the same run of $0 days.
    await db.query(`update exceptions set status = 'resolved', resolved_at = now(), resolved_by = 'Ryan' where status = 'open'`);
    await db.query(`update exceptions set first_detected_at = now() - interval '4 days', resolved_at = now() - interval '3 days 12 hours' where held`);
    expect(await run()).toEqual([]);
  });

  it("comes back when severity or money at risk gets worse, but not for a small change", async () => {
    await db.query(`insert into exception_rules (type, label) values ('zz_manual', 'Test rule')`);
    await db.query(`alter view exception_detections rename to exception_detections_real`);
    await db.query(`create table zz_det (severity text, money numeric)`);
    await db.query(`insert into zz_det values ('amber', 1000)`);
    await db.query(`create view exception_detections as
      select 'zz_manual'::text as type, 'zz_manual:1'::text as dedupe_key, null::uuid as client_id, null::uuid as staff_id, null::uuid as owner_id, null::text as owner_pod,
             z.severity, 'Test problem'::text as reason, z.money as money_at_risk, null::text as record_table, null::uuid as record_id from zz_det z`);
    expect((await run()).map((r) => r.action)).toEqual(["opened"]);
    await db.query(`update exceptions set status = 'resolved', resolved_at = now(), resolved_by = 'Ryan'`);
    await db.query(`update zz_det set money = 1200`); // +20%: not worse enough
    expect(await run()).toEqual([]);
    await db.query(`update zz_det set money = 1300`); // +30%
    expect((await run()).map((r) => r.action)).toEqual(["opened"]);
    await db.query(`update exceptions set status = 'resolved', resolved_at = now(), resolved_by = 'Ryan' where status = 'open'`);
    expect(await run()).toEqual([]);
    await db.query(`update zz_det set severity = 'red'`); // amber -> red
    expect((await run()).map((r) => r.action)).toEqual(["opened"]);
    expect((await db.query(`select 1 from exceptions where type = 'zz_manual'`)).rows.length).toBe(3);
  });

  it("a renewal overdue is one bottleneck per renewal period: resolving this one does not silence the next", async () => {
    await fresh("whop");
    const det = () => db.query<{ dedupe_key: string }>(`select dedupe_key from exception_detections where type = 'renewal_overdue'`);
    await db.query(`insert into whop_memberships (whop_membership_id, client_id, whop_user_id, product_title, status, valid, billing_period_days, renewal_price, renewal_period_start, renewal_period_end, started_at)
      values ('mem_1', $1, 'user_1', 'Genexa Scaling: Patient Protocol', 'active', true, 30, 2000, now() - interval '33 days', now() - interval '3 days', now() - interval '63 days')`, [clinic]);
    const first = (await det()).rows;
    expect(first.length).toBe(1);
    expect((await run()).filter((r) => r.exception_type === "renewal_overdue").map((r) => r.action)).toEqual(["opened"]);
    await db.query(`update exceptions set status = 'resolved', resolved_at = now(), resolved_by = 'Ryan' where type = 'renewal_overdue'`);
    expect((await run()).filter((r) => r.exception_type === "renewal_overdue")).toEqual([]);
    // Thirty days on, the next period is overdue too: a different key, so a new bottleneck.
    await db.query(`update whop_memberships set renewal_period_start = now() - interval '5 days', renewal_period_end = now() + interval '25 days' where whop_membership_id = 'mem_1'`);
    await run();
    await db.query(`update whop_memberships set renewal_period_start = now() - interval '32 days', renewal_period_end = now() - interval '2 days' where whop_membership_id = 'mem_1'`);
    expect((await det()).rows[0].dedupe_key).not.toBe(first[0].dedupe_key);
    expect((await run()).filter((r) => r.exception_type === "renewal_overdue").map((r) => r.action)).toEqual(["opened"]);
  });

  it("the engine resolving on its own puts no hold on: it reopens as before", async () => {
    await spend(clinic, 1, 0);
    await run();
    await db.query(`insert into ad_metrics_daily (client_id, date, spend) values ($1, app_today(), 30) on conflict (client_id, date) do update set spend = excluded.spend`, [clinic]);
    expect((await run()).map((r) => r.action)).toEqual(["resolved"]);
    expect((await db.query<{ held: boolean }>(`select held from exceptions`)).rows[0].held).toBe(false);
    await db.query(`update ad_metrics_daily set spend = 0 where client_id = $1 and date = app_today()`, [clinic]);
    expect((await run()).map((r) => r.action)).toEqual(["opened"]);
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

describe("the $0-spend rule and the ad account's own day", () => {
  const hour = (h: number) => db.query(`select set_config('test.ad_hour', $1, false)`, [String(h)]);
  const zero = async () => (await db.query(`select 1 from exception_detections where type = 'zero_spend'`)).rows.length;

  it("the real clock gives the date and hour in the account's timezone, not UTC or UK", async () => {
    const at = async (tz: string, ts: string) => (await db.query<{ d: string; h: number }>(`select local_date::text as d, local_hour as h from ad_clock_at($1, $2::timestamptz)`, [tz, ts])).rows[0];
    // 08:30 UTC on 9 Oct is 01:30 the same day in Los Angeles and 04:30 in New York.
    expect(await at("America/Los_Angeles", "2026-10-09T08:30:00Z")).toEqual({ d: "2026-10-09", h: 1 });
    expect(await at("America/New_York", "2026-10-09T08:30:00Z")).toEqual({ d: "2026-10-09", h: 4 });
    // 05:00 UTC is still the previous evening on the US west coast.
    expect(await at("America/Los_Angeles", "2026-10-09T05:00:00Z")).toEqual({ d: "2026-10-08", h: 22 });
    expect(await at("Europe/London", "2026-10-09T05:00:00Z")).toEqual({ d: "2026-10-09", h: 6 });
  });

  it("never fires before 12:00 account time, however empty today looks", async () => {
    await spend(clinic, 1, 0);
    await hour(3);
    expect(await zero()).toBe(0);
    await hour(11);
    expect(await zero()).toBe(0);
    await hour(12);
    expect(await zero()).toBe(1);
    await hour(15);
  });

  it("an unfinished day is never a $0 day: spend yesterday and nothing yet today does not fire", async () => {
    await spend(clinic, 1, 44.76);
    await db.query(`insert into ad_metrics_daily (client_id, date, spend) values ($1, app_today(), 0)`, [clinic]);
    expect(await zero()).toBe(0);
  });

  it("needs a reading of today taken after 12:00, and a reading of yesterday taken after it ended", async () => {
    await spend(clinic, 1, 0);
    expect(await zero()).toBe(1);
    // Today was last read long before noon account time: not enough to say "nothing today".
    await db.query(`update ad_metrics_daily set synced_at = now() - interval '3 days' where client_id = $1 and date = app_today()`, [clinic]);
    expect(await zero()).toBe(0);
    await db.query(`update ad_metrics_daily set synced_at = now() where client_id = $1 and date = app_today()`, [clinic]);
    // Yesterday's zero was stored while that day was still running.
    await db.query(`update ad_metrics_daily set synced_at = now() - interval '3 days' where client_id = $1 and date = app_today() - 1`, [clinic]);
    expect(await zero()).toBe(0);
    // No reading of today at all.
    await db.query(`update ad_metrics_daily set synced_at = now() where client_id = $1`, [clinic]);
    await db.query(`update ad_metrics_daily set date = app_today() - 9 where client_id = $1 and date = app_today()`, [clinic]);
    expect(await zero()).toBe(0);
  });

  it("resolves on the next run once spend appears, today or in a revised yesterday", async () => {
    await spend(clinic, 1, 0);
    expect((await run()).map((r) => r.action)).toEqual(["opened"]);
    await db.query(`update ad_metrics_daily set spend = 44.76 where client_id = $1 and date = app_today() - 1`, [clinic]); // Cortana revised the day
    expect((await run()).map((r) => r.action)).toEqual(["resolved"]);
  });
});

describe("under-spending", () => {
  const det = async () => (await db.query<{ severity: string; reason: string; owner_id: string; money_at_risk: string | null }>(
    `select severity, reason, owner_id, money_at_risk from exception_detections where type = 'under_spend'`)).rows;
  const day = (ago: number, amount: number, budget: number | null = null) =>
    db.query(`insert into ad_metrics_daily (client_id, date, spend, daily_budget) values ($1, app_today() - $2::int, $3, $4)
              on conflict (client_id, date) do update set spend = excluded.spend, daily_budget = excluded.daily_budget`, [clinic, ago, amount, budget]);

  it("yesterday under 60% of the daily budget is an amber item for the media buyer, not urgent", async () => {
    await day(1, 44.76, 100);
    const d = await det();
    expect(d.length).toBe(1);
    expect(d[0]).toMatchObject({ severity: "amber", owner_id: people.aditya, money_at_risk: null });
    expect(d[0].reason).toMatch(/^Zero Clinic spent \$45 vs \$100 budget on \w{3} \d\d \w{3}$/);
    expect((await db.query<{ urgent: boolean }>(`select urgent from exception_rules where type = 'under_spend'`)).rows[0].urgent).toBe(false);
    await day(1, 60, 100); // exactly 60%: fine
    expect(await det()).toEqual([]);
  });

  it("with no budget it compares with the 7 days before, needs enough of them, and leaves a $0 day to the other rule", async () => {
    await day(1, 30);
    expect(await det()).toEqual([]); // nothing to compare with
    for (const ago of [2, 3, 4, 5]) await day(ago, 100);
    expect((await det())[0].reason).toMatch(/spent \$30 vs \$100 7-day average/);
    await day(1, 70);
    expect(await det()).toEqual([]);
    await day(1, 0);
    expect(await det()).toEqual([]);
  });

  it("waits until 12:00 account time, and resolves when a later day is back on budget", async () => {
    await day(1, 20, 100);
    await db.query(`select set_config('test.ad_hour', '9', false)`);
    expect(await det()).toEqual([]);
    await db.query(`select set_config('test.ad_hour', '15', false)`);
    expect((await run()).filter((r) => r.exception_type === "under_spend").map((r) => r.action)).toEqual(["opened"]);
    await day(1, 95, 100);
    expect((await run()).filter((r) => r.exception_type === "under_spend").map((r) => r.action)).toEqual(["resolved"]);
  });
});
