import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { AUTH, asUser, freshDb, seedStaff, type TestPeople } from "./db";

let db: PGlite;
let people: TestPeople;
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const client = async (name: string, stage = "onboarding", extra = "", vals = "") =>
  (await one<{ id: string }>(`insert into clients (name, stage ${extra}) values ('${name}', '${stage}' ${vals}) returning id`)).id;
const QC_ALL = `qc_lead_access = true, qc_calendar_tested = true, qc_test_lead_deleted = true,
  qc_pixel_firing = true, qc_cortana_connected = true, qc_clinic_sheet = true`;

beforeAll(async () => {
  db = await freshDb();
  people = await seedStaff(db);
});

describe("launch_board", () => {
  type Card = {
    stage: string; next_stage: string | null; prev_stage: string | null; days_waiting: number | null; waiting_colour: string | null;
    clock_started: boolean; qc_done: number; qc_all: boolean; is_paused: boolean; pause_reason: string | null; is_overdue: boolean | null;
    sla_hours_elapsed: string | null; sla_hours_allowed: string | null; days_paid_to_live: number | null;
  };
  const card = (id: string) => one<Card>(`select * from launch_board where launch_id = $1`, [id]);

  it("puts a launch in the furthest stage whose timestamp is set", async () => {
    const c = await client("Board Clinic");
    const l = (await one<{ id: string }>(`insert into launches (client_id, paid_at, owner_id) values ($1, now() - interval '3 days', $2) returning id`, [c, people.sameer])).id;
    let b = await card(l);
    expect(b.stage).toBe("paid");
    expect(b.prev_stage).toBeNull();
    expect(b.next_stage).toBe("ob_call_booked");
    expect(b.days_waiting).toBe(3);
    expect(b.waiting_colour).toBe("green");
    expect(b.clock_started).toBe(false);
    expect(b.sla_hours_elapsed).toBeNull();

    const steps: [string, string, string | null][] = [
      ["ob_call_booked_at", "ob_call_booked", "ob_call_done"],
      ["ob_call_done_at", "ob_call_done", "ob_form_complete"],
      ["ob_form_done_at", "ob_form_complete", "access_granted"],
      ["access_done_at", "access_granted", "built"],
      ["build_done_at", "built", "qc_passed"],
    ];
    for (const [column, stage, next] of steps) {
      await db.query(`update launches set ${column} = now() - interval '2 hours' where id = $1`, [l]);
      b = await card(l);
      expect(b.stage).toBe(stage);
      expect(b.next_stage).toBe(next);
    }
    // OB form and access both done: the 48h clock is running.
    expect(b.clock_started).toBe(true);
    expect(Number(b.sla_hours_elapsed)).toBe(2);
    expect(Number(b.sla_hours_allowed)).toBe(48);
    expect(b.is_overdue).toBe(false);
    expect(b.qc_done).toBe(0);
    expect(b.qc_all).toBe(false);

    await db.query(`update launches set ${QC_ALL}, qc_passed_at = now() where id = $1`, [l]);
    b = await card(l);
    expect(b.stage).toBe("qc_passed");
    expect(b.next_stage).toBe("live");
    expect(b.qc_done).toBe(6);
    expect(b.qc_all).toBe(true);

    await db.query(`update launches set live_at = now() where id = $1`, [l]);
    b = await card(l);
    expect(b.stage).toBe("live");
    expect(b.next_stage).toBeNull();
    expect(b.prev_stage).toBe("qc_passed");
    expect(b.days_waiting).toBeNull();
    expect(b.days_paid_to_live).toBe(3);
  });

  it("colours days waiting from scoring_config: 7+ amber, 14+ red", async () => {
    const colour = async (days: number) => {
      const c = await client(`Wait ${days}`);
      const l = (await one<{ id: string }>(`insert into launches (client_id, paid_at) values ($1, now() - ($2 || ' days')::interval) returning id`, [c, String(days)])).id;
      return (await card(l)).waiting_colour;
    };
    expect(await colour(6)).toBe("green");
    expect(await colour(7)).toBe("amber");
    expect(await colour(13)).toBe("amber");
    expect(await colour(14)).toBe("red");
  });

  it("shows an open pause, and drops live launches after 14 days", async () => {
    const c = await client("Paused Clinic");
    const l = (await one<{ id: string }>(
      `insert into launches (client_id, paid_at, ob_form_done_at, access_done_at) values ($1, now() - interval '5 days', now() - interval '60 hours', now() - interval '60 hours') returning id`, [c])).id;
    expect((await card(l)).is_overdue).toBe(true);
    await db.query(`insert into sla_pauses (launch_id, paused_at, reason, evidence_note) values ($1, now() - interval '30 hours', 'client_access', 'Asked for Meta access in Slack')`, [l]);
    const b = await card(l);
    expect(b.is_paused).toBe(true);
    expect(b.pause_reason).toBe("client_access");
    expect(Number(b.sla_hours_elapsed)).toBe(30);
    expect(b.is_overdue).toBe(false);

    const old = await client("Old Live Clinic");
    const recent = await client("Recent Live Clinic");
    const ins = (cid: string, days: number) =>
      one<{ id: string }>(
        `insert into launches (client_id, paid_at, qc_lead_access, qc_calendar_tested, qc_test_lead_deleted, qc_pixel_firing, qc_cortana_connected, qc_clinic_sheet, qc_passed_at, live_at)
         values ($1, now() - interval '40 days', true, true, true, true, true, true, now() - ($2 || ' days')::interval, now() - ($2 || ' days')::interval) returning id`,
        [cid, String(days)]);
    const lo = (await ins(old, 15)).id;
    const lr = (await ins(recent, 13)).id;
    expect(await card(lo)).toBeUndefined();
    expect((await card(lr)).stage).toBe("live");
  });
});

describe("going live", () => {
  it("the launch owner setting Live makes the clinic live and sets its launch date", async () => {
    const c = await client("Go Live Clinic");
    const l = (await one<{ id: string }>(`insert into launches (client_id, paid_at, owner_id) values ($1, now() - interval '4 days', $2) returning id`, [c, people.sameer])).id;
    await asUser(db, AUTH.sameer, async () => {
      // Sameer cannot update clients himself.
      expect((await db.query(`update clients set stage = 'live' where id = $1 returning id`, [c])).rows.length).toBe(0);
      await expect(db.query(`update launches set live_at = now() where id = $1`, [l])).rejects.toThrow(/LAUNCH_QC/);
      await db.query(`update launches set ${QC_ALL} where id = $1`, [l]);
      await db.query(`update launches set qc_passed_at = now() where id = $1`, [l]);
      await db.query(`update launches set live_at = now() where id = $1`, [l]);
    });
    const row = await one<{ stage: string; launch_date: string; today: string }>(`select stage, launch_date::text, app_today()::text as today from clients where id = $1`, [c]);
    expect(row.stage).toBe("live");
    expect(row.launch_date).toBe(row.today);
    // The change is in the audit log under the person who pressed the button.
    const audit = await one<{ actor: string }>(`select actor from audit_log where table_name = 'clients' and row_id = $1 and field = 'stage' and new_value = 'live'`, [c]);
    expect(audit.actor).toBe("Sameer");
  });

  it("never overwrites a launch date that is already set", async () => {
    const c = await client("Relaunch Clinic", "paused", ", launch_date", ", date '2026-03-01'");
    const l = (await one<{ id: string }>(`insert into launches (client_id, paid_at) values ($1, now()) returning id`, [c])).id;
    await db.query(`update launches set ${QC_ALL}, qc_passed_at = now(), live_at = now() where id = $1`, [l]);
    const row = await one<{ stage: string; launch_date: string }>(`select stage, launch_date::text from clients where id = $1`, [c]);
    expect(row.stage).toBe("live");
    expect(row.launch_date).toBe("2026-03-01");
  });

  it("only the app owner can move a launch back a stage", async () => {
    const c = await client("Step Back Clinic");
    const l = (await one<{ id: string }>(
      `insert into launches (client_id, paid_at, ob_call_booked_at, owner_id) values ($1, now(), now(), $2) returning id`, [c, people.sameer])).id;
    await asUser(db, AUTH.sameer, async () => {
      await expect(db.query(`update launches set ob_call_booked_at = null where id = $1`, [l])).rejects.toThrow(/LAUNCH_BACK/);
    });
    await asUser(db, AUTH.aditya, async () => {
      // Not his launch: RLS lets nothing through.
      expect((await db.query(`update launches set ob_call_done_at = now() where id = $1 returning id`, [l])).rows.length).toBe(0);
    });
    await asUser(db, AUTH.ryan, async () => {
      expect((await db.query(`update launches set ob_call_booked_at = null where id = $1 returning id`, [l])).rows.length).toBe(1);
    });
    expect((await one<{ stage: string }>(`select stage from launch_board where launch_id = $1`, [l])).stage).toBe("paid");
  });
});

describe("touches", () => {
  it("any staff member logging a touch moves last contact (us) forward, never back", async () => {
    const c = await client("Touch Clinic", "live");
    await asUser(db, AUTH.amanda, async () => {
      await db.query(`insert into touches (client_id, kind, note, by_id, at) values ($1, 'call', 'Weekly check-in', $2, now() - interval '2 days')`, [c, people.amanda]);
      // Logging one as somebody else is refused by RLS.
      await expect(db.query(`insert into touches (client_id, kind, by_id) values ($1, 'slack', $2)`, [c, people.sameer])).rejects.toThrow();
    });
    const first = await one<{ ok: boolean }>(`select last_contact_us = (select max(at) from touches where client_id = $1) as ok from clients where id = $1`, [c]);
    expect(first.ok).toBe(true);
    // An older touch entered late does not move the date back.
    await db.query(`insert into touches (client_id, kind, at) values ($1, 'email', now() - interval '9 days')`, [c]);
    const after = await one<{ days: number }>(`select app_today() - app_day(last_contact_us) as days from clients where id = $1`, [c]);
    expect(after.days).toBe(2);
    await db.query(`insert into touches (client_id, kind) values ($1, 'loom')`, [c]);
    expect((await one<{ days: number }>(`select app_today() - app_day(last_contact_us) as days from clients where id = $1`, [c])).days).toBe(0);
  });
});

describe("client_lanes", () => {
  const lanes = async (id: string) =>
    Object.fromEntries((await db.query<{ lane: string; colour: string; reason: string }>(
      `select lane, colour, reason from client_lanes where client_id = $1 order by lane_order`, [id])).rows.map((r) => [r.lane, r]));

  it("with the Cortana sync stale, ads and outcomes are grey rather than green", async () => {
    const c = await client("Stale Source Clinic", "live", ", cortana_business_id, last_reply_client", ", 'biz_stale', now()");
    const l = await lanes(c);
    expect(l.ads).toMatchObject({ colour: "grey", reason: "Cortana sync is stale" });
    expect(l.outcomes.colour).toBe("grey");
    expect(l.contact.colour).toBe("green");
    await db.query(`update integration_sync_status set last_success_at = now(), status = 'ok' where source = 'cortana'`);
  });

  it("a healthy live clinic is green in every lane that has a source", async () => {
    const c = await client("Green Clinic", "live", ", cortana_business_id, last_reply_client", ", 'biz_green', now() - interval '1 day'");
    const l = await lanes(c);
    expect(Object.keys(l)).toEqual(["launch", "ads", "call_centre", "outcomes", "contact"]);
    expect(l.launch.colour).toBe("green");
    expect(l.ads.colour).toBe("green");
    expect(l.outcomes.colour).toBe("green");
    expect(l.contact.colour).toBe("green");
    expect(l.ads.reason).toBe("No issues found");
    expect(l.call_centre).toMatchObject({ colour: "grey", reason: "Needs GHL" });
  });

  it("failing rules turn their lane red or amber with the reason", async () => {
    // Paid 20 days ago and not launched; no client reply for 20 days.
    const c = await client("Red Clinic", "live", ", cortana_business_id, last_reply_client", ", 'biz_red', now() - interval '20 days'");
    await db.query(`insert into launches (client_id, paid_at) values ($1, now() - interval '20 days')`, [c]);
    const l = await lanes(c);
    expect(l.launch.colour).toBe("red");
    expect(l.launch.reason).toBe("Paid 20 days ago, not launched");
    expect(l.contact.colour).toBe("red");
    expect(l.contact.reason).toBe("No client reply for 20 days");
    expect(l.ads.colour).toBe("green");

    const amber = await client("Amber Clinic", "onboarding");
    await db.query(`insert into launches (client_id, paid_at) values ($1, now() - interval '8 days')`, [amber]);
    const a = await lanes(amber);
    expect(a.launch.colour).toBe("amber");
    // Not live, nothing failing: grey, not green.
    expect(a.ads).toMatchObject({ colour: "grey", reason: "Not live (onboarding)" });
  });

  it("is grey, never green, where there is nothing to judge a live clinic on", async () => {
    const unconnected = await client("Unconnected Clinic", "live");
    const u = await lanes(unconnected);
    expect(u.ads).toMatchObject({ colour: "grey", reason: "Not connected to Cortana" });
    expect(u.outcomes.colour).toBe("grey");
    expect(u.contact).toMatchObject({ colour: "grey", reason: "No client reply on record" });
    expect(u.launch.colour).toBe("green");

    const mirror = await client("Unverified Clinic", "live", ", cortana_business_id", ", 'biz_mirror'");
    await db.query(`insert into client_campaign_scope (client_id, verified) values ($1, false)`, [mirror]);
    expect((await lanes(mirror)).ads).toMatchObject({ colour: "grey", reason: "Ad numbers unverified" });
  });
});

describe("client_list", () => {
  it("returns one row per client with the month's numbers and why they are missing", async () => {
    const c = await client("List Clinic", "live", ", cortana_business_id, billing_cycle, cycle_fee, launch_date", ", 'biz_list', '90', 6000, app_today() - 12");
    await db.query(`insert into ad_metrics_daily (client_id, date, spend, impressions, clicks) values ($1, app_today(), 400, 20000, 200)`, [c]);
    for (const contact of ["a", "b", "c", "d"]) {
      await db.query(
        `insert into cortana_events (client_id, cortana_entry_id, event, occurred_at, contact_id) values ($1, gen_random_uuid()::text, 'lead', now(), $2)`, [c, contact]);
    }
    await db.query(`insert into cortana_events (client_id, cortana_entry_id, event, occurred_at, contact_id) values ($1, gen_random_uuid()::text, 'unconfirmed_appointment_booked', now(), 'a')`, [c]);
    type Row = Record<string, string | number | boolean | null>;
    const row = (name: string, month = "app_today()") => one<Row>(`select * from client_list(${month}) where name = $1`, [name]);

    const r = await row("List Clinic");
    expect(r.ads_state).toBe("ok");
    expect(r.days_live).toBe(12);
    expect(Number(r.monthly_fee)).toBe(2000);
    expect(Number(r.spend)).toBe(400);
    expect(Number(r.leads)).toBe(4);
    expect(Number(r.cpl)).toBe(100);
    expect(Number(r.cost_per_booked)).toBe(400);
    expect(Number(r.booking_rate)).toBeCloseTo(0.25);
    expect(Number(r.ctr)).toBeCloseTo(0.01);
    expect(r.revenue).toBeNull();
    expect(r.health_colour).toBe("green");
    expect(r.renewal_status).toBe("upcoming");
    expect(r.churned).toBe(false);

    // A month with nothing recorded is null, not zero.
    const earlier = await row("List Clinic", "date '2026-01-15'");
    expect(earlier.spend).toBeNull();
    expect(earlier.leads).toBeNull();

    expect((await row("Unconnected Clinic")).ads_state).toBe("not_connected");
    expect((await row("Unverified Clinic")).ads_state).toBe("unverified");

    const gone = await client("Churned Clinic", "churned");
    const g = await row("Churned Clinic");
    expect(g.churned).toBe(true);
    expect(g.health_colour).toBeNull();
    await db.query(`update clients set deleted_at = now() where id = $1`, [gone]);
    expect(await row("Churned Clinic")).toBeUndefined();
  });
});
