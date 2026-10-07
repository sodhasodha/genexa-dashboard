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
