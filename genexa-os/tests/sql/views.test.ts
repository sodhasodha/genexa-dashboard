import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { AUTH, asUser, freshDb, seedStaff, type TestPeople } from "./db";

let db: PGlite;
let people: TestPeople;
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const client = async (name: string, extra = "", vals = "") =>
  (await one<{ id: string }>(`insert into clients (name, stage ${extra}) values ('${name}', 'live' ${vals}) returning id`)).id;

beforeAll(async () => {
  db = await freshDb();
  people = await seedStaff(db);
});

const ev = (clientId: string, event: string, contact: string, opts: { value?: number; test?: boolean; daysAgo?: number } = {}) =>
  db.query(
    `insert into cortana_events (client_id, cortana_entry_id, event, occurred_at, value, contact_id, contact_first_name, is_test)
     values ($1, gen_random_uuid()::text, $2, now() - ($3 || ' days')::interval, $4, $5, 'Pat', $6)`,
    [clientId, event, String(opts.daysAgo ?? 0), opts.value ?? null, contact, opts.test ?? false],
  );

describe("client_mtd (all patient-side numbers from Cortana)", () => {
  it("counts unique contacts per event, computes ratios from sums, and never counts test contacts", async () => {
    const id = await client("Perf Clinic");
    await db.query(
      `insert into ad_metrics_daily (client_id, date, spend, impressions, clicks, unique_visitors) values
         ($1, app_today(), 300, 10000, 150, 120), ($1, date_trunc('month', app_today())::date, 200, 10000, 50, 80)`,
      [id],
    );
    // 10 real leads; 4 booked, 3 confirmed; 2 showed, 1 no-show, 1 cancelled; 1 purchase of $8,000.
    for (let i = 0; i < 10; i++) await ev(id, "lead", `c${i}`);
    await ev(id, "lead", "c0"); // the same contact submitting twice is one lead
    for (let i = 0; i < 4; i++) await ev(id, "unconfirmed_appointment_booked", `c${i}`);
    for (let i = 0; i < 3; i++) await ev(id, "appointment_booked", `c${i}`);
    await ev(id, "appointment_shown", "c0");
    await ev(id, "appointment_shown", "c1");
    await ev(id, "appointment_no_show", "c2");
    await ev(id, "appointment_cancelled", "c3");
    await ev(id, "purchase", "c0", { value: 8000 });
    // A test contact going through the whole funnel changes nothing.
    for (const e of ["lead", "unconfirmed_appointment_booked", "appointment_shown"]) await ev(id, e, "zz", { test: true });
    await ev(id, "purchase", "zz", { value: 999, test: true });

    const m = await one<Record<string, string>>(`select * from client_mtd where client_id = $1`, [id]);
    expect(Number(m.spend)).toBe(500);
    expect(Number(m.leads)).toBe(10);
    expect(Number(m.booked)).toBe(4);
    expect(Number(m.confirmed)).toBe(3);
    expect(Number(m.shows)).toBe(2);
    expect(Number(m.no_shows)).toBe(1);
    expect(Number(m.cancelled)).toBe(1);
    expect(Number(m.closes)).toBe(1);
    expect(Number(m.revenue)).toBe(8000);
    expect(Number(m.cpl)).toBe(50);
    expect(Number(m.cost_per_booked)).toBe(125);
    expect(Number(m.lp_conversion_rate)).toBeCloseTo(10 / 200);
    expect(Number(m.booking_rate)).toBeCloseTo(0.4);
    expect(Number(m.confirmation_rate)).toBeCloseTo(0.75);
    expect(Number(m.show_rate)).toBeCloseTo(2 / 3);
    expect(Number(m.close_rate)).toBeCloseTo(0.5);
    expect(Number(m.ctr)).toBeCloseTo(0.01);
    expect(Number(m.roas)).toBe(16);
    expect(Number(m.rev_share)).toBe(400);
  });

  it("counts a patient once per period even when they book on two different days", async () => {
    const id = await client("Twice Clinic");
    await ev(id, "lead", "p1", { daysAgo: 0 });
    await ev(id, "unconfirmed_appointment_booked", "p1", { daysAgo: 0 });
    await db.query(
      `insert into cortana_events (client_id, cortana_entry_id, event, occurred_at, contact_id) values
         ($1, 'tw1', 'unconfirmed_appointment_booked', (app_today() - 1 + time '12:00') at time zone 'America/New_York', 'p1'),
         ($1, 'tw2', 'unconfirmed_appointment_booked', (app_today() - 1 + time '13:00') at time zone 'America/New_York', 'p2')`,
      [id],
    );
    const byDay = await one<{ n: string }>(`select sum(booked) as n from client_performance_daily where client_id = $1 and day >= app_today() - 1`, [id]);
    expect(Number(byDay.n)).toBe(3); // p1 yesterday, p2 yesterday, p1 today
    const period = await one<{ booked: string }>(`select booked from client_funnel_period(app_today() - 1, app_today()) where client_id = $1`, [id]);
    expect(Number(period.booked)).toBe(2); // two patients
  });

  it("shows null, not zero, where there is no ad row or no revenue", async () => {
    const id = await client("Leads Only Clinic");
    await ev(id, "lead", "a");
    const m = await one<Record<string, string | null>>(`select * from client_mtd where client_id = $1`, [id]);
    expect(Number(m.leads)).toBe(1);
    expect(m.spend).toBeNull();
    expect(m.cpl).toBeNull();
    expect(m.revenue).toBeNull();
    expect(m.roas).toBeNull();
    expect(m.show_rate).toBeNull();
  });

  it("leaves a clinic with an unverified Cortana business out entirely", async () => {
    const id = await client("Mirror Clinic");
    await db.query(`insert into client_campaign_scope (client_id, verified) values ($1, false)`, [id]);
    await db.query(`insert into ad_metrics_daily (client_id, date, spend) values ($1, app_today(), 100)`, [id]);
    await ev(id, "lead", "m1");
    expect(await one(`select 1 from client_mtd where client_id = $1`, [id])).toBeUndefined();
    await db.query(`update client_campaign_scope set verified = true where client_id = $1`, [id]);
    expect(Number((await one<{ leads: string }>(`select leads from client_mtd where client_id = $1`, [id])).leads)).toBe(1);
  });
});

describe("renewals", () => {
  const status = async (id: string) =>
    one<{ status: string | null; renewal_amount: string | null; days_until: number | null; renewal_date: string | null }>(
      `select status, renewal_amount, days_until, renewal_date::text from renewals where client_id = $1`,
      [id],
    );

  it("not started without a launch date", async () => {
    const id = await client("R0", ", billing_cycle, cycle_fee", ", '30', 3000");
    expect((await status(id)).status).toBe("not_started");
  });

  it("upcoming, then due within 7 days", async () => {
    const a = await client("R1", ", billing_cycle, cycle_fee, launch_date", ", '30', 3000, app_today() - 10");
    const sa = await status(a);
    expect(sa.status).toBe("upcoming");
    expect(sa.days_until).toBe(20);
    expect(Number(sa.renewal_amount)).toBe(3000);
    const b = await client("R2", ", billing_cycle, cycle_fee, launch_date", ", '30', 3000, app_today() - 25");
    const sb = await status(b);
    expect(sb.status).toBe("due_7d");
    expect(sb.days_until).toBe(5);
  });

  it("overdue when the last renewal date passed unpaid; amount = the cycle fee exactly, monthly fee derived", async () => {
    const id = await client("R3", ", billing_cycle, cycle_fee, launch_date", ", '90', 5000, app_today() - 100");
    const s = await status(id);
    expect(s.status).toBe("overdue");
    expect(s.days_until).toBe(-10);
    expect(Number(s.renewal_amount)).toBe(5000);
    const fee = await one<{ monthly_fee: string }>(`select monthly_fee from clients where id = $1`, [id]);
    expect(Number(fee.monthly_fee)).toBe(1666.67);
  });

  it("a classified payment near the renewal date clears it; an unclassified one does not", async () => {
    const id = await client("R4", ", billing_cycle, cycle_fee, launch_date", ", '30', 3000, app_today() - 40");
    expect((await status(id)).status).toBe("overdue");
    await db.query(`insert into payments (client_id, whop_payment_id, amount, paid_at, product_title) values ($1, 'r4a', 3000, now() - interval '9 days', null)`, [id]);
    expect((await status(id)).status).toBe("overdue");
    await db.query(`insert into payments (client_id, whop_payment_id, amount, paid_at, product_title) values ($1, 'r4b', 3000, now() - interval '9 days', 'Growth Plan')`, [id]);
    const s = await status(id);
    expect(s.status).toBe("upcoming");
    expect(s.days_until).toBe(20);
  });

  it("paid early (within 5 days before the date) shows paid", async () => {
    const id = await client("R5", ", billing_cycle, cycle_fee, launch_date", ", '30', 3000, app_today() - 27");
    await db.query(`insert into payments (client_id, whop_payment_id, amount, paid_at, product_title) values ($1, 'r5', 3000, now() - interval '1 day', 'Growth Plan')`, [id]);
    expect((await status(id)).status).toBe("paid");
  });

  it("legacy billing renews every 30 days; no cycle set means no renewal; churned clients are left out", async () => {
    const id = await client("R6", ", billing_cycle, cycle_fee, launch_date", ", 'legacy', 1500, app_today() - 40");
    const s = await status(id);
    expect(s.status).toBe("overdue");
    expect(s.days_until).toBe(-10);
    expect(Number(s.renewal_amount)).toBe(1500);
    const none = await client("R7", ", cycle_fee, launch_date", ", 1000, app_today() - 40");
    const sn = await status(none);
    expect(sn.status).toBeNull();
    expect(sn.renewal_date).toBeNull();
    await db.query(`update clients set stage = 'churned' where id = $1`, [id]);
    expect(await status(id)).toBeUndefined();
  });
});

describe("source_freshness", () => {
  it("is stale when the last success is older than 2x the schedule", async () => {
    await db.query(`update integration_sync_status set last_success_at = now() - interval '30 minutes' where source = 'cortana'`);
    await db.query(`update integration_sync_status set last_success_at = now() - interval '90 minutes' where source = 'whop'`);
    await db.query(`update integration_sync_status set last_success_at = now() - interval '121 minutes' where source = 'fathom'`);
    const rows = await db.query<{ source: string; freshness: string; is_stale: boolean }>(`select source, freshness, is_stale from source_freshness`);
    const by = Object.fromEntries(rows.rows.map((r) => [r.source, r]));
    expect(by.cortana.freshness).toBe("fresh");
    expect(by.whop.freshness).toBe("late");
    expect(by.whop.is_stale).toBe(false);
    expect(by.fathom.freshness).toBe("stale");
    expect(by.fathom.is_stale).toBe(true);
    expect(by.ghl.freshness).toBe("never");
    expect(by.ghl.is_stale).toBe(true);
  });
});

describe("person_scores_weekly: EODs", () => {
  it("scores on EODs missed so far, per the thresholds in scoring_config", async () => {
    const lastWeek = `app_week_start(app_today()) - 7`;
    // Before a go-live date is set nobody is scored.
    const before = await db.query(`select 1 from person_scores_weekly where metric = 'eods' and week_start = ${lastWeek}`);
    expect(before.rows.length).toBe(0);
    await db.query(`update app_settings set value = to_jsonb((app_today() - 60)::text) where key = 'go_live_date'`);
    // Last full week: tech filed 4 of 5 -> amber; media buyer 5 of 5 -> green; CSR 3 of 7 -> red.
    const file = async (staff: string, offsets: number[]) => {
      for (const o of offsets) {
        await db.query(`insert into eods (staff_id, date) values ($1, ${lastWeek} + $2::int)`, [staff, o]);
      }
    };
    await file(people.sameer, [0, 1, 2, 3]);
    await file(people.aditya, [0, 1, 2, 3, 4]);
    await file(people.amanda, [0, 1, 2]);
    const rows = await db.query<{ staff_id: string; value: string; denominator: string; colour: string }>(
      `select staff_id, value, denominator, colour from person_scores_weekly where metric = 'eods' and week_start = ${lastWeek}`,
    );
    const by = Object.fromEntries(rows.rows.map((r) => [r.staff_id, r]));
    expect([Number(by[people.sameer].value), Number(by[people.sameer].denominator), by[people.sameer].colour]).toEqual([4, 5, "amber"]);
    expect([Number(by[people.aditya].value), Number(by[people.aditya].denominator), by[people.aditya].colour]).toEqual([5, 5, "green"]);
    expect([Number(by[people.amanda].value), Number(by[people.amanda].denominator), by[people.amanda].colour]).toEqual([3, 7, "red"]);
    expect(by[people.ryan]).toBeUndefined();
  });

  it("changing a threshold in scoring_config changes the colour", async () => {
    await db.query(`update scoring_config set amber = 4 where key = 'csr_eods_missed'`);
    const r = await one<{ colour: string }>(
      `select colour from person_scores_weekly where metric = 'eods' and staff_id = $1 and week_start = app_week_start(app_today()) - 7`,
      [people.amanda],
    );
    expect(r.colour).toBe("amber");
  });

  it("is readable by staff through RLS", async () => {
    await asUser(db, AUTH.amanda, async () => {
      const r = await one<{ n: number }>(`select count(*)::int as n from person_scores_weekly`);
      expect(r.n).toBeGreaterThan(0);
    });
  });
});
