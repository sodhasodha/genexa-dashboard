import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { AUTH, asUser, freshDb, seedStaff, type TestPeople } from "./db";

let db: PGlite;
let people: TestPeople;
let clinic: string;

type Row = Record<string, string | number | boolean | null>;
const rows = async (sql: string, params: unknown[] = []) => (await db.query<Row>(sql, params)).rows;
const one = async (sql: string, params: unknown[] = []) => (await rows(sql, params))[0];
const id = async (sql: string, params: unknown[] = []) => String((await one(sql, params)).id);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Noon ET on a day N days ago: safely inside that ET day whenever the test runs. */
const noon = (daysAgo: number) => `((app_today() - ${daysAgo} + time '12:00') at time zone 'America/New_York')`;
const day = (clientId: string, daysAgo: number, spend: number, impressions: number | null = null, clicks: number | null = null, reach: number | null = null) =>
  db.query(`insert into ad_metrics_daily (client_id, date, spend, impressions, clicks, reach) values ($1, app_today() - $2::int, $3, $4, $5, $6)`, [clientId, daysAgo, spend, impressions, clicks, reach]);
let seq = 0;
const events = async (clientId: string, event: string, daysAgo: number, n: number, opts: { value?: number; test?: boolean } = {}) => {
  for (let i = 0; i < n; i++) {
    seq += 1;
    await db.query(
      `insert into cortana_events (client_id, cortana_entry_id, event, occurred_at, contact_id, value, is_test)
       values ($1, $2, $3, ${noon(daysAgo)}, $4, $5, $6)`,
      [clientId, `e${seq}`, event, `contact-${event}-${i}`, opts.value ?? null, opts.test ?? false],
    );
  }
};
const account = (clientId: string, days: number | null) => one(`select * from media_account_metrics($2::int) where client_id = $1`, [clientId, days]);

beforeEach(async () => {
  db = await freshDb();
  people = await seedStaff(db);
  clinic = await id(
    `insert into clients (name, stage, cortana_business_id, billing_cycle, cycle_fee, launch_date)
     values ('Alpha Clinic', 'live', 'biz-a', '90', 5000, app_today() - 7) returning id`,
  );
  // Three complete days inside the 7-day window: $600, 60,000 impressions, 600 clicks, 30,000 summed reach.
  await day(clinic, 1, 100, 10_000, 100, 5_000);
  await day(clinic, 2, 200, 20_000, 200, 10_000);
  await day(clinic, 3, 300, 30_000, 300, 15_000);
  await day(clinic, 0, 999, 1_000, 10, 500); // today: not a complete day
  await day(clinic, 9, 50, 5_000, 50, 2_500); // before the window
  await events(clinic, "lead", 2, 12);
  await events(clinic, "unconfirmed_appointment_booked", 2, 6);
  await events(clinic, "appointment_shown", 1, 3);
  await events(clinic, "purchase", 1, 1, { value: 4000 });
  await events(clinic, "purchase", 1, 1, { value: 2000 });
});

describe("media_account_metrics", () => {
  it("computes a 7-day window from sums, over complete ET days only", async () => {
    const r = await account(clinic, 7);
    expect(num(r.spend)).toBe(600);
    expect(num(r.leads)).toBe(12);
    expect(num(r.booked)).toBe(6);
    expect(num(r.shows)).toBe(3);
    expect(num(r.closes)).toBe(2);
    expect(num(r.revenue)).toBe(6000);
    expect(num(r.cpl)).toBe(50);
    expect(num(r.cost_per_booked)).toBe(100);
    expect(num(r.booking_rate)).toBe(0.5);
    expect(num(r.cost_per_show)).toBe(200);
    expect(num(r.cost_per_close)).toBe(300);
    expect(num(r.frequency)).toBe(2); // 60,000 impressions ÷ 30,000 summed reach
    expect(num(r.ctr)).toBe(1); // percent
    expect(num(r.cpm)).toBe(10); // per 1,000 impressions
    expect(r.days_live).toBe(7);
    expect(r.sop_stage).toBe("Day 7");
    expect(r.unverified).toBe(false);
    const w = await one(`select (window_from = app_today() - 7) as from_ok, (window_to = app_today() - 1) as to_ok from media_account_metrics(7) where client_id = $1`, [clinic]);
    expect(w).toEqual({ from_ok: true, to_ok: true });
  });

  it("3 days and all-time use their own window; the verdict stays on 7 days", async () => {
    await day(clinic, 5, 400, 40_000, 400, 20_000);
    const d3 = await account(clinic, 3);
    expect(num(d3.spend)).toBe(600);
    const d7 = await account(clinic, 7);
    expect(num(d7.spend)).toBe(1000);
    const all = await account(clinic, null);
    expect(num(all.spend)).toBe(600 + 400 + 999 + 50);
    for (const r of [d3, d7, all]) {
      expect(num(r.spend_7d)).toBe(1000);
      expect(num(r.booked_7d)).toBe(6);
      expect(num(r.cost_per_booked_7d)).toBeCloseTo(166.67, 2);
      expect(r.verdict).toBe("red");
    }
  });

  it("leaves test contacts out", async () => {
    await events(clinic, "lead", 2, 5, { test: true });
    await db.query(
      `insert into cortana_events (client_id, cortana_entry_id, event, occurred_at, contact_id, is_test)
       values ($1, 'test-booking', 'unconfirmed_appointment_booked', ${noon(2)}, 'zz-test', true)`,
      [clinic],
    );
    const r = await account(clinic, 7);
    expect(num(r.leads)).toBe(12);
    expect(num(r.booked)).toBe(6);
    expect(num(r.cost_per_booked)).toBe(100);
  });

  it("lists an unverified clinic without numbers, and leaves out clinics that are churned or not connected", async () => {
    const mirror = await id(`insert into clients (name, stage, cortana_business_id) values ('Mirror Clinic', 'live', 'biz-m') returning id`);
    await db.query(`insert into client_campaign_scope (client_id, verified) values ($1, false)`, [mirror]);
    await day(mirror, 1, 500, 50_000, 500, 25_000);
    await events(mirror, "lead", 1, 4);
    await db.query(`insert into clients (name, stage) values ('No Cortana', 'live')`);
    await db.query(`insert into clients (name, stage, cortana_business_id) values ('Gone Clinic', 'churned', 'biz-g')`);
    const scoped = await id(`insert into clients (name, stage, cortana_business_id) values ('Scoped Clinic', 'live', 'biz-s') returning id`);
    await db.query(`insert into client_campaign_scope (client_id, verified, campaign_name_contains) values ($1, true, 'Genexa')`, [scoped]);

    const all = await rows(`select name, unverified, campaign_scoped, spend, leads, frequency, verdict, days_live, sop_stage from media_account_metrics(7) order by name`);
    expect(all.map((r) => r.name)).toEqual(["Alpha Clinic", "Mirror Clinic", "Scoped Clinic"]);
    const m = all[1];
    expect(m.unverified).toBe(true);
    expect([m.spend, m.leads, m.frequency, m.verdict]).toEqual([null, null, null, null]);
    expect([m.days_live, m.sop_stage]).toEqual([null, null]); // no launch date = no data
    expect(all[2].campaign_scoped).toBe(true);
    expect(all[2].spend).toBeNull(); // nothing loaded is null, not zero
  });

  it("has no verdict when there were no bookings in 7 days", async () => {
    const quiet = await id(`insert into clients (name, stage, cortana_business_id) values ('Quiet Clinic', 'live', 'biz-q') returning id`);
    await day(quiet, 1, 80);
    const r = await account(quiet, 7);
    expect(num(r.spend)).toBe(80);
    expect(num(r.booked)).toBe(0);
    expect(r.cost_per_booked).toBeNull();
    expect(r.verdict).toBeNull();
  });
});

describe("verdict", () => {
  it("follows the cost_per_booked_7d row in scoring_config", async () => {
    const verdict = async () => (await account(clinic, 7)).verdict;
    expect(await verdict()).toBe("amber"); // $100: over $71, not over $110
    await db.query(`update scoring_config set amber = 90 where key = 'cost_per_booked_7d'`);
    expect(await verdict()).toBe("red");
    await db.query(`update scoring_config set green = 100, amber = 110 where key = 'cost_per_booked_7d'`);
    expect(await verdict()).toBe("green");
  });
});

describe("sop_stage", () => {
  it("names the stage from days live, with the milestone days read from scoring_config", async () => {
    const stage = async (d: number | null) => (await one(`select sop_stage($1::int) as s`, [d])).s;
    const expected: [number | null, string | null][] = [
      [null, null], [-1, null], [0, "Day 0–2"], [2, "Day 0–2"], [3, "Day 3"], [4, "Day 4–6"], [6, "Day 4–6"], [7, "Day 7"],
      [8, "Day 8–9"], [9, "Day 8–9"], [10, "Day 10"], [11, "Day 11–13"], [13, "Day 11–13"], [14, "Day 14"], [15, "Day 15+"], [90, "Day 15+"],
    ];
    for (const [d, label] of expected) expect(await stage(d)).toBe(label);
    await db.query(`update scoring_config set value = 5 where key = 'sop_milestone_1'`);
    expect(await stage(3)).toBe("Day 0–4");
    expect(await stage(6)).toBe("Day 6");
  });
});

describe("media_ad_metrics", () => {
  const ad = (period: string, adId: string, v: Record<string, unknown> = {}, clientId = clinic) =>
    db.query(
      `insert into ad_metrics_ad_window (client_id, ad_id, period, ad_name, ad_status, window_start, window_end, spend, impressions, clicks, ctr, frequency, leads, booked)
       values ($1, $2, $3, $2, $4, app_today() - 7, app_today(), $5, 1000, 10, $6, $7, $8, $9)`,
      [clientId, adId, period, v.status ?? "ACTIVE", v.spend ?? 50, v.ctr ?? 1, v.frequency ?? 1.2, v.leads ?? 0, v.booked ?? 0],
    );
  const flags = async () =>
    Object.fromEntries((await rows(`select ad_id, fatigue from media_ad_metrics where client_id = $1`, [clinic])).map((r) => [r.ad_id, r.fatigue]));

  it("puts 7d and all-time side by side and flags fatigue on frequency or a CTR drop", async () => {
    await ad("7d", "freq", { frequency: 3.4, spend: 120, leads: 6, booked: 3 });
    await ad("all", "freq", { frequency: 2.1, spend: 900, leads: 40, booked: 9 });
    await ad("7d", "ctr", { ctr: 0.7 });
    await ad("all", "ctr", { ctr: 1.0 });
    await ad("7d", "fine", { ctr: 0.71, frequency: 3 });
    await ad("all", "fine", { ctr: 1.0 });
    await ad("all", "old", { status: "PAUSED" }); // no 7d row: nothing to test
    expect(await flags()).toEqual({ freq: true, ctr: true, fine: false, old: null });

    const r = await one(`select * from media_ad_metrics where client_id = $1 and ad_id = 'freq'`, [clinic]);
    expect([num(r.spend_7d), num(r.leads_7d), num(r.booked_7d), num(r.cost_per_booked_7d)]).toEqual([120, 6, 3, 40]);
    expect([num(r.spend_all), num(r.booked_all), num(r.cost_per_booked_all)]).toEqual([900, 9, 100]);
    expect(r.is_active).toBe(true);
    expect(r.fatigue_reason).toBe("7d frequency 3.40 is over 3");
    expect((await one(`select is_active from media_ad_metrics where ad_id = 'old'`)).is_active).toBe(false);
  });

  it("reads both fatigue lines from scoring_config", async () => {
    await ad("7d", "a", { frequency: 2.5, ctr: 0.85 });
    await ad("all", "a", { ctr: 1.0 });
    expect(await flags()).toEqual({ a: false });
    await db.query(`update scoring_config set value = 2 where key = 'ad_fatigue_frequency'`);
    expect(await flags()).toEqual({ a: true });
    await db.query(`update scoring_config set value = 3 where key = 'ad_fatigue_frequency'`);
    await db.query(`update scoring_config set value = 10 where key = 'ad_fatigue_ctr_drop_pct'`);
    expect(await flags()).toEqual({ a: true });
  });

  it("leaves out an unverified clinic's ads", async () => {
    const mirror = await id(`insert into clients (name, stage, cortana_business_id) values ('Mirror Clinic', 'live', 'biz-m') returning id`);
    await db.query(`insert into client_campaign_scope (client_id, verified) values ($1, false)`, [mirror]);
    await ad("7d", "m1", {}, mirror);
    await ad("7d", "a1");
    expect((await rows(`select ad_id from media_ad_metrics`)).map((r) => r.ad_id)).toEqual(["a1"]);
  });
});

describe("score_media_weekly", () => {
  const score = async (metric: string, week: "current" | "previous") =>
    one(
      `select value, numerator, denominator, colour, card, staff_id from score_media_weekly
       where metric = $1 and week_start = app_week_start(app_today()) - $2::int`,
      [metric, week === "current" ? 0 : 7],
    );
  let n = 0;
  /** An ad exception first detected at Monday noon ET of last week, so it is always older than 24h. */
  const exception = (type: string, opts: { resolvedAfterHours?: number; detected?: string; client?: string } = {}) => {
    n += 1;
    const detected = opts.detected ?? `((app_week_start(app_today()) - 7 + time '12:00') at time zone 'America/New_York')`;
    return db.query(
      `insert into exceptions (type, client_id, owner_id, severity, reason, dedupe_key, first_detected_at, status, resolved_at, resolved_by)
       values ($1, $2, $3, 'amber', 'test', $4, ${detected}, $5,
         case when $6::numeric is null then null else ${detected} + $6::numeric * interval '1 hour' end, $7)`,
      [type, opts.client ?? clinic, people.aditya, `k${n}`, opts.resolvedAfterHours === undefined ? "open" : "resolved", opts.resolvedAfterHours ?? null, opts.resolvedAfterHours === undefined ? null : "Aditya"],
    );
  };

  it("has exactly the scorecard columns, one card per media buyer", async () => {
    const cols = await rows(`select column_name, data_type from information_schema.columns where table_name = 'score_media_weekly' order by ordinal_position`);
    expect(cols.map((c) => `${c.column_name} ${c.data_type}`)).toEqual([
      "staff_id uuid", "week_start date", "card text", "metric text", "value numeric", "numerator numeric", "denominator numeric", "colour text",
    ]);
    const r = await score("accounts_over_cpb", "current");
    expect([r.card, r.staff_id]).toEqual(["media_buyer", people.aditya]);
    const metrics = await rows(`select distinct metric from score_media_weekly order by metric`);
    expect(metrics.map((m) => m.metric)).toEqual(["accounts_flagged_3d", "accounts_over_cpb", "book_cpb_change_pct", "exceptions_24h_pct", "zero_spend_accounts"]);
  });

  it("exceptions_24h_pct: resolved inside 24h over everything due, by the week first detected", async () => {
    let r = await score("exceptions_24h_pct", "previous");
    expect([r.value, num(r.denominator), r.colour]).toEqual([null, 0, null]); // nothing to measure

    await exception("ad_fatigue", { resolvedAfterHours: 2 });
    await exception("zero_spend", { resolvedAfterHours: 30 }); // resolved, but late
    await exception("ad_performance"); // still open and older than 24h: missed
    await exception("tech_job_overdue", { resolvedAfterHours: 1 }); // not an ad exception
    await exception("ad_disapproved", { detected: `(now() - interval '1 hour')` }); // open and inside 24h: not counted yet
    r = await score("exceptions_24h_pct", "previous");
    expect([num(r.value), num(r.numerator), num(r.denominator), r.colour]).toEqual([33.3, 1, 3, "red"]);

    await exception("account_cpb_high", { resolvedAfterHours: 5 });
    await exception("ad_fatigue", { resolvedAfterHours: 23 });
    r = await score("exceptions_24h_pct", "previous");
    expect([num(r.value), num(r.numerator), num(r.denominator), r.colour]).toEqual([60, 3, 5, "red"]);
    await db.query(`update scoring_config set amber = 60 where key = 'media_exceptions_24h_pct'`);
    expect((await score("exceptions_24h_pct", "previous")).colour).toBe("amber");
  });

  it("accounts_over_cpb: live verified accounts with a red 7d cost per booked, current week only", async () => {
    let r = await score("accounts_over_cpb", "current");
    expect([num(r.value), num(r.denominator), r.colour]).toEqual([0, 1, "green"]); // Alpha is amber at $100

    const pricey = await id(`insert into clients (name, stage, cortana_business_id) values ('Pricey Clinic', 'live', 'biz-p') returning id`);
    await day(pricey, 1, 500);
    await events(pricey, "unconfirmed_appointment_booked", 1, 1);
    // Red numbers on a paused clinic and on an unverified one do not count.
    const paused = await id(`insert into clients (name, stage, cortana_business_id) values ('Paused Clinic', 'paused', 'biz-z') returning id`);
    await day(paused, 1, 900);
    await events(paused, "unconfirmed_appointment_booked", 1, 1);
    r = await score("accounts_over_cpb", "current");
    expect([num(r.value), num(r.numerator), num(r.denominator), r.colour]).toEqual([1, 1, 2, "amber"]);

    await db.query(`update scoring_config set amber = 0 where key = 'media_accounts_over_cpb'`);
    expect((await score("accounts_over_cpb", "current")).colour).toBe("red");
    const past = await score("accounts_over_cpb", "previous");
    expect([past.value, past.colour]).toEqual([null, null]);
  });

  it("zero_spend_accounts and accounts_flagged_3d count live accounts with open ad exceptions", async () => {
    let z = await score("zero_spend_accounts", "current");
    let f = await score("accounts_flagged_3d", "current");
    expect([num(z.value), z.colour, num(f.value), f.colour]).toEqual([0, "green", 0, "green"]);

    await exception("zero_spend", { detected: `(now() - interval '2 hours')` });
    await exception("ad_fatigue", { detected: `(now() - interval '4 days')` });
    await exception("ad_performance", { detected: `(now() - interval '5 days')` }); // same account: counted once
    await exception("ad_fatigue", { detected: `(now() - interval '6 days')`, resolvedAfterHours: 3 }); // resolved
    z = await score("zero_spend_accounts", "current");
    f = await score("accounts_flagged_3d", "current");
    expect([num(z.value), num(z.denominator), z.colour]).toEqual([1, 1, "red"]);
    expect([num(f.value), num(f.denominator), f.colour]).toEqual([1, 1, "amber"]);
  });

  it("book_cpb_change_pct compares the last 7 complete days with the 7 before", async () => {
    let r = await score("book_cpb_change_pct", "current");
    expect([r.value, r.colour]).toEqual([null, null]); // no bookings in the earlier 7 days
    // Earlier week: $50 (seeded, day 9) + $350 = $400 on 5 bookings = $80. This week: $600 on 6 = $100. Up 25%.
    await day(clinic, 10, 350);
    await events(clinic, "unconfirmed_appointment_booked", 10, 5);
    r = await score("book_cpb_change_pct", "current");
    expect([num(r.value), num(r.numerator), num(r.denominator), r.colour]).toEqual([25, 100, 80, "amber"]);
    await db.query(`update scoring_config set amber = 20 where key = 'media_book_cpb_change_pct'`);
    expect((await score("book_cpb_change_pct", "current")).colour).toBe("red");
  });

  it("a metric with no live accounts is null, not zero", async () => {
    await db.query(`update clients set stage = 'paused' where id = $1`, [clinic]);
    for (const metric of ["accounts_over_cpb", "zero_spend_accounts", "accounts_flagged_3d"]) {
      const r = await score(metric, "current");
      expect([metric, r.value, num(r.denominator), r.colour]).toEqual([metric, null, 0, null]);
    }
  });
});

describe("action taken", () => {
  it("is saved by the exception's owner or the app owner, and by nobody else", async () => {
    const ex = await id(
      `insert into exceptions (type, client_id, owner_id, severity, reason, dedupe_key) values ('zero_spend', $1, $2, 'red', 'test', 'rls-1') returning id`,
      [clinic, people.aditya],
    );
    const save = async (who: keyof typeof AUTH, text: string) =>
      asUser(db, AUTH[who], async () => (await db.query(`update exceptions set action_taken = $2 where id = $1 returning id`, [ex, text])).rows.length);
    expect(await save("amanda", "not mine")).toBe(0);
    expect(await save("aditya", "Raised budget cap")).toBe(1);
    expect(await save("ryan", "Checked with the clinic")).toBe(1);
    expect((await one(`select action_taken from exceptions where id = $1`, [ex])).action_taken).toBe("Checked with the clinic");
    const audit = await rows(`select actor, new_value from audit_log where table_name = 'exceptions' and field = 'action_taken' order by created_at`);
    expect(audit.map((a) => a.actor)).toEqual(["Aditya", "Ryan"]);
  });
});
