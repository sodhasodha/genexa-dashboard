import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { AUTH, asUser, freshDb, seedStaff, type TestPeople } from "./db";
import { pgliteRpc } from "./rpc";
import type { Rpc } from "@/lib/jobs/rpc";
import { runDailySnapshot } from "@/lib/jobs/dailySnapshot";
import { runWeeklyClientReport, type SendResult } from "@/lib/reports/weeklyClientReport";

let db: PGlite;
let people: TestPeople;
let rpc: Rpc;
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(`select count(*) as n from ${sql}`, params)).n);
const id = async (sql: string, params: unknown[] = []) => (await one<{ id: string }>(sql, params)).id;

/** An instant at a given ET day and time. */
const et = (day: string, time = "12:00") => `(timestamp '${day} ${time}' at time zone 'America/New_York')`;
let entry = 0;
/** Cortana events for one clinic: [event, contact, ET day, value?]. */
async function events(clientId: string, rows: [string, string, string, number?][], extra = "") {
  for (const [event, contact, day, value] of rows) {
    await db.query(
      `insert into cortana_events (client_id, cortana_entry_id, event, occurred_at, contact_id, contact_first_name, value ${extra ? ", is_test" : ""})
       values ($1, $2, $3, ${et(day)}, $4, 'Zebediah', $5 ${extra})`,
      [clientId, `e${++entry}`, event, contact, value ?? null],
    );
  }
}

beforeAll(async () => {
  db = await freshDb();
  people = await seedStaff(db);
  rpc = pgliteRpc(db);
});

// ---------------------------------------------------------------------------
describe("onboarding_intake", () => {
  type Intake = { duplicate: boolean; client_id?: string; client_created?: boolean; launch_id?: string; launch_created?: boolean; message?: string };
  const intake = (args: string) => one<{ r: Intake }>(`select onboarding_intake(${args}) as r`).then((x) => x.r);

  it("creates the client in onboarding and its launch, owned by tech, and records the event", async () => {
    const r = await intake(
      `p_event_id => 'ev1', p_clinic_name => '  New Clinic ', p_contact_name => 'Dr A', p_contact_email => 'a@clinic.test',
       p_billing_cycle => '90', p_cycle_fee => 6000, p_paid_at => '2026-10-01T12:00:00Z', p_kickoff_url => 'https://k.test/1', p_pod => 'pod_1'`);
    expect(r).toMatchObject({ duplicate: false, client_created: true, launch_created: true });

    const c = await one<Record<string, string | null>>(`select * from clients where id = $1`, [r.client_id]);
    expect(c).toMatchObject({ name: "New Clinic", stage: "onboarding", contact_name: "Dr A", billing_cycle: "90", pod: "pod_1", kickoff_url: "https://k.test/1" });
    expect(Number(c.cycle_fee)).toBe(6000);
    expect(Number(c.monthly_fee)).toBe(2000);

    const l = await one<{ client_id: string; owner_id: string; paid_at: Date; ob_form_done_at: Date | null; live_at: Date | null }>(
      `select * from launches where id = $1`, [r.launch_id]);
    expect(l.client_id).toBe(r.client_id);
    expect(l.owner_id).toBe(people.sameer);
    expect(new Date(l.paid_at).toISOString()).toBe("2026-10-01T12:00:00.000Z");
    expect(l.ob_form_done_at).not.toBeNull(); // defaults to now
    expect(l.live_at).toBeNull();

    const ev = await one<{ payload: Record<string, unknown> }>(`select payload from webhook_events where source = 'onboarding' and event_id = 'ev1'`);
    expect(ev.payload).toMatchObject({ clinic_name: "New Clinic", contact_email: "a@clinic.test" });
  });

  it("writes the audit trail as onboarding-form", async () => {
    const actors = await db.query<{ table_name: string; actor: string }>(
      `select a.table_name, a.actor from audit_log a
       where a.field = '_created' and (
         (a.table_name = 'clients' and a.row_id in (select id from clients where name = 'New Clinic'))
         or (a.table_name = 'launches' and a.row_id in (select l.id from launches l join clients c on c.id = l.client_id where c.name = 'New Clinic')))
       order by a.table_name`);
    expect(actors.rows).toEqual([{ table_name: "clients", actor: "onboarding-form" }, { table_name: "launches", actor: "onboarding-form" }]);
    // The actor does not leak into later statements.
    const later = await id(`insert into clients (name) values ('Plain Insert') returning id`);
    expect((await one<{ actor: string }>(`select actor from audit_log where row_id = $1`, [later])).actor).toBe("system");
  });

  it("a repeated event_id creates nothing", async () => {
    const before = [await count("clients"), await count("launches"), await count("webhook_events")];
    const r = await intake(`p_event_id => 'ev1', p_clinic_name => 'Something Else Entirely'`);
    expect(r).toEqual({ duplicate: true });
    expect([await count("clients"), await count("launches"), await count("webhook_events")]).toEqual(before);
  });

  it("does not create a second client for the same name, and adds no launch while one is open", async () => {
    const r = await intake(`p_event_id => 'ev2', p_clinic_name => 'NEW CLINIC', p_cycle_fee => 1`);
    expect(r).toMatchObject({ duplicate: false, client_created: false, launch_created: false });
    expect(r.message).toMatch(/open launch/);
    expect(await count("clients where lower(name) = 'new clinic'")).toBe(1);
    expect(await count("launches where client_id = $1", [r.client_id])).toBe(1);
    // The existing client is left as it was.
    expect(Number((await one<{ cycle_fee: string }>(`select cycle_fee from clients where id = $1`, [r.client_id])).cycle_fee)).toBe(6000);
  });

  it("attaches a launch to an existing client that has no open launch", async () => {
    const none = await id(`insert into clients (name, stage) values ('Old Clinic', 'paused') returning id`);
    const a = await intake(`p_event_id => 'ev3', p_clinic_name => 'old clinic', p_ob_form_done_at => '2026-10-02T09:00:00Z'`);
    expect(a).toMatchObject({ client_id: none, client_created: false, launch_created: true });
    expect(a.message).toMatch(/new launch was attached/);
    const l = await one<{ paid_at: Date | null; ob_form_done_at: Date }>(`select paid_at, ob_form_done_at from launches where id = $1`, [a.launch_id]);
    expect(l.paid_at).toBeNull();
    expect(new Date(l.ob_form_done_at).toISOString()).toBe("2026-10-02T09:00:00.000Z");
    expect((await one<{ stage: string }>(`select stage from clients where id = $1`, [none])).stage).toBe("paused");

    // A launch that has gone live is closed: a new one can be attached.
    const live = await id(`insert into clients (name, stage) values ('Relaunch Clinic', 'live') returning id`);
    await db.query(
      `insert into launches (client_id, live_at, qc_passed_at, qc_lead_access, qc_calendar_tested, qc_test_lead_deleted, qc_pixel_firing, qc_cortana_connected, qc_clinic_sheet)
       values ($1, now(), now(), true, true, true, true, true, true)`, [live]);
    const b = await intake(`p_event_id => 'ev4', p_clinic_name => 'Relaunch Clinic'`);
    expect(b).toMatchObject({ client_id: live, launch_created: true });
    expect(await count("launches where client_id = $1", [live])).toBe(2);
  });

  it("ignores a deleted client of the same name, and refuses a blank name or event", async () => {
    await db.query(`insert into clients (name, deleted_at) values ('Gone Clinic', now())`);
    const r = await intake(`p_event_id => 'ev5', p_clinic_name => 'Gone Clinic'`);
    expect(r.client_created).toBe(true);
    await expect(intake(`p_event_id => 'ev6', p_clinic_name => '   '`)).rejects.toThrow(/clinic_name is required/);
    await expect(intake(`p_event_id => '', p_clinic_name => 'X'`)).rejects.toThrow(/event_id is required/);
    // A refused call leaves no event behind, so the form can send it again.
    expect(await count("webhook_events where event_id = 'ev6'")).toBe(0);
  });

  it("cannot be called by a logged-in user", async () => {
    await asUser(db, AUTH.ryan, async () => {
      await expect(intake(`p_event_id => 'ev7', p_clinic_name => 'Sneaky'`)).rejects.toThrow(/permission denied/);
    });
  });
});

// ---------------------------------------------------------------------------
describe("freeze_agency_month", () => {
  type Frozen = { frozen: boolean; month: string; reason?: string };
  type Snapshot = {
    month: string; month_end: string; as_of: string;
    overview: Record<string, number | null>;
    mrr: number | null; mrr_whop_recurring: number | null;
    clients_by_stage: Record<string, number>;
    clients: Record<string, number | string | null>[];
  };
  const freeze = (month: string) => one<{ r: Frozen }>(`select freeze_agency_month($1) as r`, [month]).then((x) => x.r);
  const snapshot = (month: string) =>
    one<{ snapshot: Snapshot; frozen_at: Date | null }>(`select snapshot, frozen_at from agency_month where month = $1`, [month]);
  let clinic: string;

  beforeAll(async () => {
    clinic = await id(
      `insert into clients (name, stage, cortana_business_id, billing_cycle, cycle_fee) values ('Freeze Clinic', 'live', 'bf', '30', 2500) returning id`);
    await db.query(`insert into ad_metrics_daily (client_id, date, spend) values ($1, '2025-03-10', 300), ($1, '2025-03-31', 100), ($1, '2025-04-01', 999)`, [clinic]);
    await events(clinic, [
      ["lead", "p1", "2025-03-10"], ["lead", "p2", "2025-03-11"], ["lead", "p1", "2025-03-12"],
      ["unconfirmed_appointment_booked", "p1", "2025-03-12"], ["purchase", "p1", "2025-03-20", 5000],
      ["lead", "p9", "2025-04-01"],
    ]);
    await db.query(`insert into payments (whop_payment_id, amount, paid_at, product_title) values ('fz1', 2500, ${et("2025-03-05")}, 'Genexa Scaling Growth')`);
    await db.query(
      `insert into whop_memberships (whop_membership_id, client_id, product_title, valid, billing_period_days, renewal_price, started_at)
       values ('mem_fz', null, 'Genexa Scaling Growth', true, 30, 3000, ${et("2025-01-05")})`);
  });

  it("stores the month's overview, MRR, clients by stage and per-client rows", async () => {
    await db.query(`update integration_sync_status set last_success_at = now() where source = 'whop'`);
    expect(await freeze("2025-03-17")).toMatchObject({ frozen: true, month: "2025-03-01" });
    const row = await snapshot("2025-03-01");
    const s = row.snapshot;
    expect(row.frozen_at).not.toBeNull();
    expect(s.month).toBe("2025-03-01");
    expect(s.month_end).toBe("2025-03-31");
    expect(s.overview).toMatchObject({ ad_spend: 400, leads: 2, booked: 1, closes: 1, clinic_revenue: 5000, cash_collected: 2500 });
    expect(s.mrr_whop_recurring).toBe(3000);
    // MRR and stages are today's, taken at the moment of freezing.
    expect(s.mrr).toBe(Number((await one<{ v: string }>(`select sum(monthly_fee) as v from client_fees`)).v));
    expect(s.mrr).toBeGreaterThanOrEqual(2500);
    expect(s.clients_by_stage.live).toBe(await count("clients where deleted_at is null and stage = 'live'"));
    expect(s.clients_by_stage.onboarding).toBe(await count("clients where deleted_at is null and stage = 'onboarding'"));
    expect(s.clients).toHaveLength(1);
    expect(s.clients[0]).toMatchObject({ name: "Freeze Clinic", client_id: clinic, month: "2025-03-01", spend: 400, leads: 2, booked: 1, closes: 1, revenue: 5000, cost_per_booked: 400 });
  });

  it("never overwrites a frozen month", async () => {
    const before = await snapshot("2025-03-01");
    await db.query(`insert into ad_metrics_daily (client_id, date, spend) values ($1, '2025-03-15', 7000)`, [clinic]);
    expect(await freeze("2025-03-01")).toEqual({ frozen: false, month: "2025-03-01", reason: "already_frozen" });
    const after = await snapshot("2025-03-01");
    expect(after.snapshot).toEqual(before.snapshot);
    expect(new Date(after.frozen_at!).getTime()).toBe(new Date(before.frozen_at!).getTime());
    expect(await count("agency_month where month = '2025-03-01'")).toBe(1);
  });

  it("fills a month that has a row but was never frozen, and will not freeze a month still running", async () => {
    await db.query(`insert into agency_month (month, snapshot) values ('2025-04-01', '{"draft": true}')`);
    expect((await freeze("2025-04-30")).frozen).toBe(true);
    const april = await snapshot("2025-04-01");
    expect(april.snapshot.overview).toMatchObject({ ad_spend: 999, leads: 1 });
    expect(april.frozen_at).not.toBeNull();

    const running = await one<{ r: Frozen }>(`select freeze_agency_month(app_today()) as r`);
    expect(running.r).toMatchObject({ frozen: false, reason: "month_not_over" });
    expect(await count("agency_month where month = date_trunc('month', app_today())::date")).toBe(0);
  });

  it("leaves Whop MRR null when Whop has never synced, and empty months null rather than zero", async () => {
    await db.query(`update integration_sync_status set last_success_at = null where source = 'whop'`);
    expect((await freeze("2024-06-01")).frozen).toBe(true);
    const s = (await snapshot("2024-06-01")).snapshot;
    expect(s.mrr_whop_recurring).toBeNull();
    expect(s.overview.ad_spend).toBeNull();
    expect(s.clients).toEqual([]);
  });

  it("is for jobs only", async () => {
    await asUser(db, AUTH.ryan, async () => {
      await expect(freeze("2024-01-01")).rejects.toThrow(/permission denied/);
    });
  });
});

// ---------------------------------------------------------------------------
describe("client_week_report", () => {
  type Row = Record<string, string | null>;
  const WEEK = "2025-06-02"; // a Monday
  const report = async (week = WEEK) => (await db.query<Row>(`select * from client_week_report($1)`, [week])).rows;
  const named = (rows: Row[], name: string) => rows.find((r) => r.client_name === name);
  const n = (v: string | null) => (v === null ? null : Number(v));

  beforeAll(async () => {
    const live = (name: string, stage = "live", cortana: string | null = "b") =>
      id(`insert into clients (name, stage, cortana_business_id) values ($1, $2, $3) returning id`, [name, stage, cortana]);
    const verified = await live("Week Verified");
    const unverified = await live("Week Unverified");
    await live("Week No Cortana", "live", null);
    const onboarding = await live("Week Onboarding", "onboarding");
    await live("Week Quiet");
    await db.query(`insert into client_campaign_scope (client_id, verified) values ($1, true), ($2, false)`, [verified, unverified]);

    await db.query(
      `insert into ad_metrics_daily (client_id, date, spend) values
         ($1, '2025-06-02', 100), ($1, '2025-06-08', 150), ($1, '2025-05-27', 200), ($1, '2025-06-09', 999),
         ($2, '2025-06-03', 500), ($3, '2025-06-03', 500)`,
      [verified, unverified, onboarding]);
    await events(verified, [
      // This week: 3 patients enquired (a on two days), 2 booked (a twice), 1 confirmed, 1 showed, 1 no-show, 1 sale.
      ["lead", "a", "2025-06-02"], ["lead", "a", "2025-06-04"], ["lead", "b", "2025-06-03"],
      ["unconfirmed_appointment_booked", "a", "2025-06-03"], ["unconfirmed_appointment_booked", "a", "2025-06-05"],
      ["unconfirmed_appointment_booked", "b", "2025-06-04"],
      ["appointment_booked", "a", "2025-06-04"], ["appointment_shown", "a", "2025-06-06"], ["appointment_no_show", "b", "2025-06-06"],
      ["purchase", "a", "2025-06-06", 4000],
      // The week before: 1 lead, 1 booked, nothing else.
      ["lead", "x", "2025-05-27"], ["unconfirmed_appointment_booked", "x", "2025-05-28"],
      // The week after: not counted.
      ["lead", "z", "2025-06-09"],
    ]);
    // Sunday 23:30 ET is still this week, although it is Monday in UTC.
    await db.query(
      `insert into cortana_events (client_id, cortana_entry_id, event, occurred_at, contact_id) values ($1, 'edge', 'lead', ${et("2025-06-08", "23:30")}, 'c')`, [verified]);
    await events(verified, [["lead", "tester", "2025-06-03"]], ", true");
    await events(unverified, [["lead", "u", "2025-06-03"]]);
  });

  it("gives null funnel numbers, not zeros, while Cortana has never synced", async () => {
    await db.query(`update integration_sync_status set last_success_at = null where source = 'cortana'`);
    const quiet = named(await report(), "Week Quiet")!;
    expect(quiet.spend).toBeNull();
    expect(quiet.leads).toBeNull();
    expect(quiet.revenue).toBeNull();
    await db.query(`update integration_sync_status set last_success_at = now() where source = 'cortana'`);
  });

  it("reports a seeded week and the week before, counting each patient once", async () => {
    const rows = await report();
    const r = named(rows, "Week Verified")!;
    expect(r.week_start).toEqual((await one<{ d: unknown }>(`select date '2025-06-02' as d`)).d);
    expect(r.week_end).toEqual((await one<{ d: unknown }>(`select date '2025-06-08' as d`)).d);
    expect([r.spend, r.leads, r.booked, r.confirmed, r.shows, r.no_shows, r.closes, r.revenue].map(n)).toEqual([250, 3, 2, 1, 1, 1, 1, 4000]);
    expect(n(r.cost_per_booked)).toBe(125);
    expect(n(r.show_rate)).toBe(0.5);
    expect([r.prev_spend, r.prev_leads, r.prev_booked, r.prev_confirmed, r.prev_shows, r.prev_no_shows, r.prev_closes, r.prev_revenue].map(n))
      .toEqual([200, 1, 1, 0, 0, 0, 0, 0]);
    expect(n(r.prev_cost_per_booked)).toBe(200);
    expect(r.prev_show_rate).toBeNull(); // nobody was due to show

    // A clinic with nothing that week: spend unknown, funnel zero, ratios null.
    const quiet = named(rows, "Week Quiet")!;
    expect(quiet.spend).toBeNull();
    expect(n(quiet.leads)).toBe(0);
    expect(n(quiet.revenue)).toBe(0);
    expect(quiet.cost_per_booked).toBeNull();
    expect(quiet.show_rate).toBeNull();
  });

  it("leaves out unverified, unconnected and not-live clinics", async () => {
    const names = (await report()).map((r) => r.client_name);
    expect(names).toContain("Week Verified");
    expect(names).not.toContain("Week Unverified");
    expect(names).not.toContain("Week No Cortana");
    expect(names).not.toContain("Week Onboarding");
    expect(names).toEqual([...names].sort());
  });

  it("treats any day of the week as that week", async () => {
    const r = named(await report("2025-06-05"), "Week Verified")!;
    expect(n(r.leads)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe("daily-snapshot job", () => {
  const today = async () => (await one<{ d: string }>(`select app_today()::text as d`)).d;
  const snapshotRows = () => count("person_scores_snapshot");

  it("stores the scorecards of the week containing yesterday, once", async () => {
    const t = await today();
    const week = (await one<{ w: string }>(`select app_week_start(app_today() - 1)::text as w`)).w;
    const expected = await count("person_scores_weekly where week_start = $1", [week]);
    expect(expected).toBeGreaterThan(0); // the tech card always has rows

    const first = await runDailySnapshot({ rpc, today: t });
    expect(first.ok).toBe(true);
    expect(first.summary.scores).toEqual({ week_start: week, rows: expected });
    expect(await snapshotRows()).toBe(expected);
    // The four tech metrics, plus any attendance metrics on the same card.
    expect(await count("person_scores_snapshot where staff_id = $1 and week_start = $2 and card = 'tech' and metric in ('launch_sla_pct', 'fix_sla_pct', 'broken_week1', 'paused_pct')", [people.sameer, week])).toBe(4);
    const mismatched = await count(
      `person_scores_snapshot s join person_scores_weekly w using (staff_id, week_start, card, metric)
       where s.value is distinct from w.value or s.colour is distinct from w.colour or s.numerator is distinct from w.numerator`);
    expect(mismatched).toBe(0);

    // A second run the same day updates in place.
    await runDailySnapshot({ rpc, today: t });
    expect(await snapshotRows()).toBe(expected);
  });

  it("freezes last month on the 1st only, and a named month as a back-fill", async () => {
    const months = () => count("agency_month");
    const before = await months();

    const midMonth = await runDailySnapshot({ rpc, today: "2025-08-14" });
    expect(midMonth.summary.agency_month).toBeNull();
    expect(await months()).toBe(before);

    const first = await runDailySnapshot({ rpc, today: "2025-08-01" });
    expect(first.summary.agency_month).toMatchObject({ frozen: true, month: "2025-07-01" });
    expect(await months()).toBe(before + 1);

    // Running again on the 1st changes nothing.
    const again = await runDailySnapshot({ rpc, today: "2025-08-01" });
    expect(again.ok).toBe(true);
    expect(again.summary.agency_month).toMatchObject({ frozen: false, reason: "already_frozen" });
    expect(await months()).toBe(before + 1);

    const backfill = await runDailySnapshot({ rpc, today: "2025-08-14", month: "2024-12-20" });
    expect(backfill.summary.agency_month).toMatchObject({ frozen: true, month: "2024-12-01" });
  });
});

// ---------------------------------------------------------------------------
describe("weekly-client-report job", () => {
  const WEEK = "2025-06-02";
  const sent: { to: string; text: string }[] = [];
  const okSend = async (to: string, text: string): Promise<SendResult> => {
    sent.push({ to, text });
    return { ok: true, ts: `ts-${sent.length}`, channel: "D_RYAN" };
  };
  const run = (today: string, send = okSend, lookupSlackId?: (email: string) => Promise<string | null>) =>
    runWeeklyClientReport({ rpc, send, lookupSlackId, today, appUrl: "https://os.test" });
  const notes = (week: string) =>
    db.query<{ sent_at: Date | null; slack_ts: string | null; channel: string | null; staff_id: string }>(
      `select sent_at, slack_ts, channel, staff_id from notifications where rule_key = 'weekly_client_report' and window_key = $1`, [week]).then((r) => r.rows);

  beforeAll(async () => {
    await db.query(`update integration_sync_status set last_success_at = now() where source = 'cortana'`);
    await db.query(`update staff set slack_user_id = 'U_RYAN' where id = $1`, [people.ryan]);
    const red = await id(`insert into clients (name, stage) values ('Red Clinic', 'onboarding') returning id`);
    await db.query(`insert into launches (client_id, paid_at) values ($1, now() - interval '20 days')`, [red]);
  });

  it("stores one report per clinic and sends the owner one message", async () => {
    // Wednesday 11 June 2025: last week is 2-8 June.
    const r = await run("2025-06-11");
    const clinics = await count(`client_week_report('${WEEK}')`);
    expect(r).toMatchObject({ ok: true, summary: { week_start: WEEK, reports: clinics, dm: "sent" } });
    expect(await count("client_reports where week_start = $1", [WEEK])).toBe(clinics);

    const stored = await one<{ body_markdown: string; numbers: Record<string, number | null>; emailed_at: Date | null }>(
      `select r.body_markdown, r.numbers, r.emailed_at from client_reports r join clients c on c.id = r.client_id
       where c.name = 'Week Verified' and r.week_start = $1`, [WEEK]);
    expect(stored.emailed_at).toBeNull();
    expect(stored.numbers).toMatchObject({ spend: 250, leads: 3, booked: 2, revenue: 4000, prev_spend: 200 });
    expect(stored.body_markdown).toContain("# Week Verified");
    expect(stored.body_markdown).toContain("- Ad spend: $250.00 (week before: $200.00, up 25%)");
    expect(stored.body_markdown).toContain("- Show rate: 50.0% (week before: no data)");
    const quiet = await one<{ body_markdown: string }>(
      `select r.body_markdown from client_reports r join clients c on c.id = r.client_id where c.name = 'Week Quiet' and r.week_start = $1`, [WEEK]);
    expect(quiet.body_markdown).toContain("- Ad spend: no data (week before: no data)");

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("U_RYAN");
    expect(sent[0].text).toContain(`${clinics} client reports prepared for 2 Jun to 8 Jun.`);
    expect(sent[0].text).toContain("Red clinics (1):");
    expect(sent[0].text).toContain("• Red Clinic: Paid 20 days ago, not launched");
    expect(sent[0].text).toContain("https://os.test/clients");

    const n = await notes(WEEK);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ staff_id: people.ryan, slack_ts: "ts-1", channel: "D_RYAN" });
    expect(n[0].sent_at).not.toBeNull();
  });

  it("carries no patient names anywhere", async () => {
    const bodies = await db.query<{ body_markdown: string; numbers: unknown }>(`select body_markdown, numbers from client_reports`);
    for (const b of bodies.rows) expect(b.body_markdown + JSON.stringify(b.numbers)).not.toContain("Zebediah");
    expect(sent.map((s) => s.text).join("\n")).not.toContain("Zebediah");
  });

  it("does not send twice in the same week, and does not rewrite a report already emailed", async () => {
    await db.query(
      `update client_reports set emailed_at = now(), body_markdown = 'AS SENT'
       where week_start = $1 and client_id = (select id from clients where name = 'Week Quiet')`, [WEEK]);
    const reports = await count("client_reports");
    const r = await run("2025-06-13");
    expect(r).toMatchObject({ ok: true, summary: { dm: "already_sent" } });
    expect(sent).toHaveLength(1);
    expect(await notes(WEEK)).toHaveLength(1);
    expect(await count("client_reports")).toBe(reports);
    expect(await count("client_reports where body_markdown = 'AS SENT'")).toBe(1);
  });

  it("can try again after a failed send, and then stops", async () => {
    // Wednesday 18 June 2025: last week is 9-15 June.
    const week = "2025-06-09";
    const failing = async (): Promise<SendResult> => ({ ok: false, error: "channel_not_found" });
    const failed = await run("2025-06-18", failing);
    expect(failed).toMatchObject({ ok: false, summary: { dm: "failed", error: "channel_not_found" } });
    expect(await notes(week)).toMatchObject([{ sent_at: null, channel: "failed:channel_not_found" }]);

    const throwing = async (): Promise<SendResult> => { throw new Error("network down"); };
    expect((await run("2025-06-18", throwing)).summary).toMatchObject({ dm: "failed", error: "network down" });

    const before = sent.length;
    expect((await run("2025-06-18")).summary).toMatchObject({ dm: "sent" });
    expect((await run("2025-06-19")).summary).toMatchObject({ dm: "already_sent" });
    expect(sent).toHaveLength(before + 1);
    const n = await notes(week);
    expect(n).toHaveLength(1);
    expect(n[0].sent_at).not.toBeNull();
  });

  it("sends nothing and claims nothing when the owner has no Slack id; a lookup can supply one", async () => {
    await db.query(`update staff set slack_user_id = null where id = $1`, [people.ryan]);
    const before = sent.length;
    const r = await run("2025-06-25"); // week of 16 June
    expect(r).toMatchObject({ ok: true, summary: { dm: "no_slack_user" } });
    expect(sent).toHaveLength(before);
    expect(await notes("2025-06-16")).toHaveLength(0);

    const found = await run("2025-06-25", okSend, async (email) => (email === "ryan@example.test" ? "U_FOUND" : null));
    expect(found.summary).toMatchObject({ dm: "sent" });
    expect(sent[sent.length - 1].to).toBe("U_FOUND");
  });
});
