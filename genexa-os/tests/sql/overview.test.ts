import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { AUTH, asUser, freshDb, seedStaff, type TestPeople } from "./db";

let db: PGlite;
let people: TestPeople;
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const id = async (sql: string, params: unknown[] = []) => (await one<{ id: string }>(sql, params)).id;

beforeAll(async () => {
  db = await freshDb();
  people = await seedStaff(db);
});

describe("overview_period", () => {
  it("totals a date range per source and leaves unverified clinics out of ad spend", async () => {
    const a = await id(`insert into clients (name, stage) values ('A Clinic', 'live') returning id`);
    const b = await id(`insert into clients (name, stage) values ('B Mirror', 'live') returning id`);
    await db.query(`insert into client_campaign_scope (client_id, verified) values ($1, false)`, [b]);
    for (const c of [a, b]) {
      await db.query(`insert into ad_metrics_daily (client_id, date, spend) values ($1, app_today(), 100), ($1, app_today() - 1, 50), ($1, app_today() - 40, 999)`, [c]);
    }
    await db.query(
      `insert into cortana_events (client_id, cortana_entry_id, event, occurred_at, contact_id, value) values
         ($1, 'e1', 'lead', now(), 'x', null), ($1, 'e2', 'lead', now(), 'y', null), ($1, 'e3', 'unconfirmed_appointment_booked', now(), 'x', null),
         ($1, 'e4', 'purchase', now(), 'x', 5000), ($2, 'e5', 'lead', now(), 'z', null)`,
      [a, b],
    );
    await db.query(`insert into payments (whop_payment_id, amount, paid_at, product_title, status) values ('o3', 900, now(), 'Growth', 'open')`);
    await db.query(`insert into payments (whop_payment_id, amount, paid_at, product_title) values ('o1', 2000, now(), 'Growth'), ('o2', 700, now(), null)`);
    await db.query(`insert into finance_transactions (mercury_id, posted_at, amount, category, included) values
      ('f1', now(), -300, 'ads', true), ('f2', now(), -120, 'software', true), ('f3', now(), -500, 'personal', false), ('f4', now(), 4000, 'revenue', true), ('f5', now(), -80, 'unclassified', true)`);
    const r = await one<Record<string, string | null>>(`select * from overview_period(app_today() - 1, app_today())`);
    expect(Number(r.ad_spend)).toBe(150);
    expect(Number(r.leads)).toBe(2);
    expect(Number(r.booked)).toBe(1);
    expect(Number(r.clinic_revenue)).toBe(5000);
    expect(Number(r.cash_collected)).toBe(2000); // unclassified and unpaid invoices are not cash
    expect(Number(r.expenses)).toBe(420);
    expect(Number(r.bank_revenue)).toBe(4000);
  });

  it("returns null, not zero, for a range with no ad or bank rows; staff cannot see finance", async () => {
    const r = await one<Record<string, string | null>>(`select * from overview_period(app_today() - 400, app_today() - 390)`);
    expect(r.ad_spend).toBeNull();
    expect(r.expenses).toBeNull();
    await asUser(db, AUTH.amanda, async () => {
      const s = await one<Record<string, string | null>>(`select * from overview_period(app_today() - 1, app_today())`);
      expect(Number(s.ad_spend)).toBe(150);
      expect(s.expenses).toBeNull();
      expect(s.bank_revenue).toBeNull();
    });
  });
});

describe("client_health", () => {
  it("is the worst live rule, and ignores rules whose source is stale", async () => {
    const c = await id(
      `insert into clients (name, stage, cortana_business_id, billing_cycle, cycle_fee, launch_date, last_reply_client)
       values ('Health Clinic', 'live', 'b1', '30', 2000, app_today() - 40, now() - interval '9 days') returning id`,
    );
    await db.query(`insert into ad_metrics_daily (client_id, date, spend) values ($1, app_today() - 1, 0)`, [c]);
    const health = () => one<{ colour: string; reasons: string | null; sources_missing: string[] }>(`select colour, reasons, sources_missing from client_health where client_id = $1`, [c]);

    // Nothing has synced: only the rule with no source (client reply) counts. The unpaid renewal and $0 spend do not.
    let h = await health();
    expect(h.colour).toBe("amber");
    expect(h.reasons).toBe("No client reply for 9 days");
    expect(h.sources_missing).toEqual(["cortana", "whop"]);

    await db.query(`update integration_sync_status set last_success_at = now() where source = 'cortana'`);
    h = await health();
    expect(h.colour).toBe("red");
    expect(h.reasons).toBe("$0 ad spend 24h+ · No client reply for 9 days");

    await db.query(`update integration_sync_status set last_success_at = now() where source = 'whop'`);
    h = await health();
    expect(h.reasons).toMatch(/^Renewal overdue since \d\d \w{3} · \$0 ad spend 24h\+ · No client reply for 9 days$/);

    await db.query(`update clients set last_reply_client = now() - interval '2 days' where id = $1`, [c]);
    await db.query(`insert into ad_metrics_daily (client_id, date, spend) values ($1, app_today(), 60)`, [c]);
    await db.query(`insert into payments (client_id, whop_payment_id, amount, paid_at, product_title) values ($1, 'h1', 2000, now() - interval '8 days', 'Growth')`, [c]);
    expect((await health()).colour).toBe("green");
  });
});

describe("data_review_items", () => {
  it("lists anomalies: missing launch date / fee / cycle, unverified scope, and mirrored spend", async () => {
    const k = await id(`insert into clients (name, stage, cortana_business_id, billing_cycle, cycle_fee, launch_date) values ('Knox', 'live', 'k', '90', 5000, app_today() - 60) returning id`);
    const cl = await id(`insert into clients (name, stage, cortana_business_id) values ('Cleve', 'live', 'c') returning id`);
    for (let d = 1; d <= 4; d++) {
      await db.query(`insert into ad_metrics_daily (client_id, date, spend) values ($1, app_today() - $3::int, $4), ($2, app_today() - $3::int, $4)`, [k, cl, d, 100 + d]);
    }
    const rows = await db.query<{ title: string; detail: string }>(
      `select title, detail from data_review_items where kind = 'anomaly' and client_id in ($1, $2) order by title`,
      [k, cl],
    );
    const titles = rows.rows.map((r) => r.title);
    expect(titles).toContain("Cleve · live with no launch date");
    expect(titles).toContain("Cleve · no fee on record");
    expect(titles).toContain("Cleve · no billing cycle");
    expect(titles.filter((t) => t.includes("same daily spend"))).toHaveLength(1);
    expect(rows.rows.find((r) => r.title.includes("same daily spend"))?.detail).toMatch(/^Identical spend on 4 of the last 7 days/);
    expect(titles.some((t) => t.startsWith("Knox · live with no"))).toBe(false);
  });

  it("queues unlogged outcomes, unmatched payments, uncategorised expenses and test leads", async () => {
    const c = await id(`insert into clients (name, stage, billing_cycle, cycle_fee, launch_date, cortana_business_id) values ('Queue Clinic', 'live', '30', 1, app_today(), 'q') returning id`);
    const lead = await id(`insert into leads (client_id, ghl_contact_id, name, created_at) values ($1, 'q1', 'Dana Smith', now()) returning id`, [c]);
    await db.query(`insert into leads (client_id, ghl_contact_id, name, created_at) values ($1, 'q2', 'ZZ Test', now())`, [c]);
    await db.query(`insert into appointments (lead_id, client_id, scheduled_for) values ($1, $2, now() - interval '30 hours'), ($1, $2, now() - interval '3 hours')`, [lead, c]);
    const kinds = async () =>
      Object.fromEntries(
        (await db.query<{ kind: string; n: number }>(`select kind, count(*)::int as n from data_review_items where client_id = $1 or kind in ('unmatched_payment','uncategorised_expense') group by kind`, [c])).rows.map((r) => [r.kind, r.n]),
      );
    const k = await kinds();
    expect(k.unlogged_outcome).toBe(1);
    expect(k.test_lead).toBe(1);
    expect(k.unmatched_payment).toBeGreaterThanOrEqual(3);
    expect(k.uncategorised_expense).toBe(1);
    const row = await one<{ title: string }>(`select title from data_review_items where kind = 'unlogged_outcome' and client_id = $1`, [c]);
    expect(row.title).toBe("Dana · Queue Clinic"); // first name only
  });

  it("lists a failed Whop charge only until that customer pays", async () => {
    const titles = async () =>
      (await db.query<{ title: string; kind: string }>(`select kind, title from data_review_items where title like 'Fail Co%' or title like 'Retry Co%'`)).rows.map((r) => `${r.kind}:${r.title}`).sort();
    await db.query(
      `insert into payments (whop_payment_id, whop_user_id, customer_name, amount, paid_at, product_title, status, billing_reason, failure_message) values
         ('w1', 'u_fail', 'Fail Co', 2000, now() - interval '5 days', 'Growth', 'open', 'subscription_cycle', 'Card declined'),
         ('w2', 'u_retry', 'Retry Co', 1500, now() - interval '5 days', 'Growth', 'open', 'subscription_create', 'Card declined'),
         ('w3', 'u_retry', 'Retry Co', 1500, now() - interval '4 days', 'Growth', 'paid', 'subscription_create', null)`,
    );
    expect(await titles()).toEqual([
      "anomaly:Fail Co · Whop charge of $2000.00 failed, not paid since",
      "unmatched_payment:Fail Co · $2000.00",
      "unmatched_payment:Retry Co · $1500.00",
    ]);
    const d = await one<{ detail: string }>(`select detail from data_review_items where kind = 'anomaly' and title like 'Fail Co%'`);
    expect(d.detail).toMatch(/^Renewal on \d\d \w{3} · Card declined$/);
  });

  it("counts missing EODs only from the go-live date", async () => {
    const n = async () => (await one<{ n: number }>(`select count(*)::int as n from data_review_items where kind = 'eod_issue'`)).n;
    expect(await n()).toBe(0);
    await db.query(`update app_settings set value = to_jsonb((app_today() - 3)::text) where key = 'go_live_date'`);
    expect(await n()).toBeGreaterThan(0);
  });
});

describe("staff_on_shift", () => {
  it("is true only inside the person's shift; no shift means never", async () => {
    const on = async (who: string, at: string) => (await one<{ v: boolean }>(`select staff_on_shift($1, ${at}) as v`, [who])).v;
    expect(await on(people.sameer, "now()")).toBe(false);
    await db.query(`update staff set shift_start = '09:00', shift_end = '17:00', timezone = 'America/New_York', working_days = '{1,2,3,4,5,6,7}' where id = $1`, [people.sameer]);
    expect(await on(people.sameer, "(app_today() + time '10:00') at time zone 'America/New_York'")).toBe(true);
    expect(await on(people.sameer, "(app_today() + time '18:00') at time zone 'America/New_York'")).toBe(false);
  });
});

describe("fees, MRR from Whop and dismissals", () => {
  const member = (clientId: string | null, price: number, days: number, opts: { valid?: boolean; started?: string; ends?: string } = {}) =>
    db.query(
      `insert into whop_memberships (whop_membership_id, client_id, status, valid, billing_period_days, renewal_price, started_at, renewal_period_end, product_title)
       values (gen_random_uuid()::text, $1, 'active', $2, $3, $4, ${opts.started ?? "now() - interval '100 days'"}, ${opts.ends ?? "now() + interval '10 days'"}, 'Genexa Scaling: Patient Protocol')`,
      [clientId, opts.valid ?? true, days, price],
    );
  const fee = (id: string) => one<{ monthly_fee: string; source: string; mismatch: boolean; whop_monthly: string | null }>(`select monthly_fee, source, mismatch, whop_monthly from client_fees where client_id = $1`, [id]);

  it("takes a matched client's fee from Whop, compares monthly figures, and honours a confirmed fee", async () => {
    const a = await id(`insert into clients (name, stage, billing_cycle, cycle_fee) values ('Fee A', 'live', '30', 2000) returning id`);
    expect(await fee(a)).toMatchObject({ source: "record", mismatch: false });
    expect(Number((await fee(a)).monthly_fee)).toBe(2000);
    await member(a, 1500, 30);
    let f = await fee(a);
    expect([Number(f.monthly_fee), f.source, f.mismatch]).toEqual([1500, "whop", true]);
    // $2,000 every 45 days is the same money as $4,000 every 90: no mismatch.
    const q = await id(`insert into clients (name, stage, billing_cycle, cycle_fee) values ('Fee Q', 'onboarding', '90', 4000) returning id`);
    await member(q, 2000, 45);
    f = await fee(q);
    expect([Number(f.monthly_fee), f.mismatch]).toEqual([1333.33, false]);
    // Two locations on two memberships add up.
    const v = await id(`insert into clients (name, stage, billing_cycle, cycle_fee) values ('Fee V', 'live', '30', 3000) returning id`);
    await member(v, 2000, 30);
    await member(v, 1000, 30);
    expect((await fee(v)).mismatch).toBe(false);
    // An owner-confirmed fee wins and is not listed as a mismatch.
    await db.query(`update clients set fee_locked = true where id = $1`, [a]);
    f = await fee(a);
    expect([Number(f.monthly_fee), f.source, f.mismatch]).toEqual([2000, "confirmed", false]);
  });

  it("lists a fee mismatch for review, and a dismissal hides an item without deleting anything", async () => {
    const c = await id(`insert into clients (name, stage, billing_cycle, cycle_fee, launch_date, cortana_business_id) values ('Fee M', 'live', '30', 2000, app_today(), 'm') returning id`);
    await member(c, 1200, 30);
    const open = async () => (await db.query<{ title: string; item_key: string; record_table: string }>(`select title, item_key, record_table from data_review_open where client_id = $1`, [c])).rows;
    let rows = await open();
    expect(rows.map((r) => r.title)).toEqual(["Fee M · fee on record $2000.00/month, Whop charges $1200.00/month"]);
    expect(rows[0].record_table).toBe("client_fees");
    await db.query(`insert into data_review_dismissals (item_key, kind, title, reason, dismissed_by) values ($1, 'anomaly', $2, 'Discount agreed for October', $3)`, [rows[0].item_key, rows[0].title, people.ryan]);
    expect(await open()).toEqual([]);
    // A different amount is a new item and shows again.
    await db.query(`update whop_memberships set renewal_price = 1000 where client_id = $1`, [c]);
    rows = await open();
    expect(rows.length).toBe(1);
    await expect(db.query(`delete from data_review_dismissals`)).rejects.toThrow(/Hard deletes/);
    await expect(db.query(`insert into data_review_dismissals (item_key, kind, title, reason) values ('k', 'anomaly', 't', '  ')`)).rejects.toThrow();
  });

  it("recurring MRR on a past day counts memberships that had started and not yet ended", async () => {
    const before = Number((await one<{ v: string }>(`select whop_mrr_at(app_today() - 30) as v`)).v);
    await member(null, 900, 30, { started: "now() - interval '60 days'" }); // live then and now
    await member(null, 600, 30, { started: "now() - interval '5 days'" }); // not started 30 days ago
    await member(null, 300, 30, { valid: false, started: "now() - interval '90 days'", ends: "now() - interval '40 days'" }); // ended before
    await member(null, 500, 30, { valid: false, started: "now() - interval '90 days'", ends: "now() - interval '10 days'" }); // ended after
    await member(null, 3000, 90, { started: "now() - interval '60 days'" }); // $1,000 a month
    // Another business's product on the same Whop account is not Genexa MRR.
    await db.query(`insert into whop_memberships (whop_membership_id, status, valid, billing_period_days, renewal_price, started_at, product_title) values ('other-biz', 'active', true, 30, 9999, now() - interval '60 days', 'Irrigation Growth Plan')`);
    const then = Number((await one<{ v: string }>(`select whop_mrr_at(app_today() - 30) as v`)).v);
    expect(then - before).toBe(900 + 500 + 1000);
  });
});

describe("appointments: outcomes copied from Cortana, consults tomorrow", () => {
  it("marks a consult from the same person's Cortana event, show beating no-show, and leaves others waiting", async () => {
    const c = await id(`insert into clients (name, stage) values ('Appt Clinic', 'live') returning id`);
    const appt = (key: string | null, when: string, contact: string) =>
      id(`insert into appointments (client_id, ghl_contact_id, contact_key, contact_first_name, scheduled_for, calendar_kind) values ($1, $2, $3, 'Pat', ${when}, 'confirmed') returning id`, [c, contact, key]);
    const shown = await appt("p:aaa", "now() - interval '2 days'", "g1");
    const noShow = await appt("p:bbb", "now() - interval '2 days'", "g2");
    const waiting = await appt("p:ccc", "now() - interval '2 days'", "g3");
    const old = await appt("p:aaa", "now() - interval '60 days'", "g1");
    await db.query(
      `insert into cortana_events (client_id, cortana_entry_id, event, occurred_at, contact_id, contact_key) values
         ($1, 'o1', 'appointment_no_show', now() - interval '40 hours', 'x1', 'p:aaa'),
         ($1, 'o2', 'appointment_shown', now() - interval '30 hours', 'x1', 'p:aaa'),
         ($1, 'o3', 'appointment_no_show', now() - interval '30 hours', 'x2', 'p:bbb'),
         ($1, 'o4', 'lead', now() - interval '30 hours', 'x3', 'p:ccc')`,
      [c],
    );
    const n = await one<{ n: number }>(`select appointments_apply_outcomes() as n`);
    expect(n.n).toBe(2);
    const att = async (a: string) => (await one<{ attendance: string; attendance_logged_by: string | null }>(`select attendance, attendance_logged_by from appointments where id = $1`, [a]));
    expect(await att(shown)).toEqual({ attendance: "showed", attendance_logged_by: "clinic" });
    expect((await att(noShow)).attendance).toBe("no_show");
    expect((await att(waiting)).attendance).toBe("scheduled");
    expect((await att(old)).attendance).toBe("scheduled"); // an event weeks later is not that consult's outcome
    const queue = await db.query<{ title: string }>(`select title from data_review_open where kind = 'unlogged_outcome' and client_id = $1`, [c]);
    expect(queue.rows.map((r) => r.title)).toEqual(["Pat · Appt Clinic"]); // the 60-day-old one has aged out of the queue
  });

  it("counts tomorrow's consults per clinic with how many are confirmed", async () => {
    const c = await id(`insert into clients (name, stage) values ('Tomorrow Clinic', 'live') returning id`);
    const at = `((app_today() + 1 + time '10:00') at time zone 'America/New_York')`;
    await db.query(
      `insert into appointments (client_id, ghl_contact_id, scheduled_for, calendar_kind, attendance) values
         ($1, 't1', ${at}, 'confirmed', 'scheduled'), ($1, 't2', ${at}, 'unconfirmed', 'scheduled'),
         ($1, 't3', ${at}, 'unconfirmed', 'cancelled'), ($1, 't4', ${at} + interval '2 days', 'confirmed', 'scheduled')`,
      [c],
    );
    const r = await one<{ consults: string; confirmed: string }>(`select consults, confirmed from consults_tomorrow where client_id = $1`, [c]);
    expect([Number(r.consults), Number(r.confirmed)]).toEqual([2, 1]);
  });
});

describe("finance rules", () => {
  it("categorises by the first matching rule, respects direction, and never overrides a person", async () => {
    await db.query(`insert into finance_transactions (mercury_id, posted_at, amount, counterparty) values
      ('r1', now(), -500, 'Facebook'), ('r2', now(), 3000, 'Whop'), ('r3', now(), -2000, 'Whop'),
      ('r4', now(), -900, 'Wise'), ('r5', now(), -77, 'Mystery Vendor LLC'), ('r6', now(), -40, 'Amazon'), ('r7', now(), -1000, 'Mercury Credit')`);
    await db.query(`update finance_transactions set category = 'software', included = true, categorised_by = 'manual' where mercury_id = 'r6'`);
    await db.query(`select apply_finance_rules()`);
    const rows = await db.query<{ mercury_id: string; category: string; included: boolean }>(`select mercury_id, category, included from finance_transactions where mercury_id like 'r_' order by mercury_id`);
    expect(rows.rows.map((r) => `${r.mercury_id}:${r.category}:${r.included}`)).toEqual([
      "r1:ads:true", "r2:revenue:true", "r3:unclassified:true", // money OUT to Whop is not a payout
      "r4:payroll:true", "r5:unclassified:true", "r6:software:true", // a person's choice stands
      "r7:excluded:false",
    ]);
    // A vendor rule added from the review queue beats the defaults and applies to the rest.
    await db.query(`insert into finance_rules (priority, match_field, pattern, category, included) values (5, 'counterparty', 'Mystery Vendor LLC', 'software', true)`);
    await db.query(`select apply_finance_rules()`);
    expect((await one<{ category: string }>(`select category from finance_transactions where mercury_id = 'r5'`)).category).toBe("software");
  });
});

describe("outcome nudges", () => {
  it("counts only consults that are definitely unlogged, per live clinic, for the General channel", async () => {
    const c = await id(`insert into clients (name, stage, slack_scheduling_id, slack_general_id, timezone) values ('Nudge Clinic', 'live', 'CNUDGESCHED', 'CNUDGEGEN', 'America/Chicago') returning id`);
    const off = await id(`insert into clients (name, stage, slack_general_id) values ('Paused Clinic', 'paused', 'CPAUSED') returning id`);
    const silent = await id(`insert into clients (name, stage, slack_general_id) values ('Silent Clinic', 'live', 'CSILENT') returning id`);
    const appt = (clientId: string, name: string, key: string | null, when: string, attendance = "scheduled") =>
      db.query(`insert into appointments (client_id, ghl_contact_id, contact_first_name, contact_key, scheduled_for, attendance) values ($1, $2, $2, $3, ${when}, $4)`, [clientId, name, key, attendance]);
    const event = (clientId: string, name: string, key: string, ev: string, when: string) =>
      db.query(`insert into cortana_events (client_id, cortana_entry_id, contact_id, event, occurred_at, contact_first_name, contact_key) values ($1, $2, $5, $3, ${when}, $4, $5)`, [clientId, `${name}-${ev}-${Math.random()}`, ev, name, key]);
    // The clinic's outcomes do reach us: one logged in the last 30 days.
    await event(c, "Zed", "p:z", "appointment_shown", "now() - interval '6 days'");
    await appt(c, "Ann", "p:1", "now() - interval '30 hours'"); await event(c, "Ann", "p:1", "lead", "now() - interval '9 days'"); // definite
    await appt(c, "Bob", "p:2", "now() - interval '20 days'"); await event(c, "Bob", "p:2", "appointment_booked", "now() - interval '25 days'"); // definite (backlog)
    await appt(c, "Cat", null, "now() - interval '3 days'"); // no phone or email: cannot be matched
    await appt(c, "Dan", "p:4", "now() - interval '3 days'"); // Cortana does not know this phone
    await appt(c, "Eve", "p:5", "now() - interval '4 days'"); await event(c, "Eve", "p:5", "lead", "now() - interval '9 days'");
    await event(c, "eve Smith", "p:other", "appointment_shown", "now() - interval '3 days'"); // same first name logged under another number
    await appt(c, "Fay", "p:6", "now() - interval '3 hours'"); // under 24h
    await appt(c, "Gil", "p:7", "now() - interval '4 days'", "showed"); // logged
    await appt(off, "Hal", "p:8", "now() - interval '2 days'");
    // A clinic with no outcome from Cortana in 30 days: we cannot tell "never logs" from "not reaching us".
    await appt(silent, "Ian", "p:9", "now() - interval '2 days'"); await event(silent, "Ian", "p:9", "lead", "now() - interval '9 days'");

    const due = (clientId: string) => one<{ channel: string; timezone: string; overdue_count: number; uncertain_count: number; link: string | null; local_dow: number }>(
      `select channel, timezone, overdue_count, uncertain_count, link, local_dow from outcome_nudges_due where client_id = $1`, [clientId]);
    const d = await due(c);
    expect(d).toMatchObject({ channel: "CNUDGEGEN", timezone: "America/Chicago", overdue_count: 2, uncertain_count: 3, link: null });
    expect(d.local_dow).toBeGreaterThanOrEqual(1);
    expect(d.local_dow).toBeLessThanOrEqual(7);
    expect(await due(silent)).toMatchObject({ overdue_count: 0, uncertain_count: 1 });
    expect(await due(off)).toBeUndefined();
    // The owner's queue still shows every open consult, certain or not.
    const queue = await one<{ n: number }>(`select count(*)::int as n from data_review_open where kind = 'unlogged_outcome' and client_id = $1`, [c]);
    expect(queue.n).toBe(5);

    await db.query(`insert into app_settings (key, value) values ('client_outcome_link', '"https://example.test/default"') on conflict (key) do update set value = excluded.value`);
    expect((await due(c)).link).toBe("https://example.test/default");
    await db.query(`update clients set outcome_link = 'https://example.test/own' where id = $1`, [c]);
    expect((await due(c)).link).toBe("https://example.test/own");

    await db.query(`insert into notifications (rule_key, channel, record_id, window_key) values ('outcome_nudge', 'CNUDGEGEN', $1, 'w1'), ('weekly_scorecard', 'CNUDGEGEN', $1, 'w1')`, [c]);
    const queued = await db.query<{ rule_key: string }>(`select rule_key from notifications where channel = 'CNUDGEGEN'`);
    expect(queued.rows.map((r) => r.rule_key)).toEqual(["outcome_nudge"]);
  });

  it("the CSR outcome and unconfirmed reminders cannot be switched back on", async () => {
    await expect(db.query(`update reminder_rules set enabled = true where key = 'outcome_overdue'`)).rejects.toThrow(/reminder_rules_retired/);
    await expect(db.query(`update reminder_rules set enabled = true where key = 'unconfirmed_tomorrow'`)).rejects.toThrow(/reminder_rules_retired/);
    const cols = (await db.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'appointments'`)).rows.map((r) => r.column_name);
    expect(cols).not.toContain("nudge1_at");
  });
});
