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
    expect(b.next_stage).toBe("assets_in");
    expect(b.days_waiting).toBe(3);
    expect(b.waiting_colour).toBe("green");
    expect(b.clock_started).toBe(false);
    expect(b.sla_hours_elapsed).toBeNull();

    // The old onboarding steps are history only: they no longer move the card or start the clock.
    await db.query(`update launches set ob_call_booked_at = now(), ob_form_done_at = now(), access_done_at = now() where id = $1`, [l]);
    expect((await card(l)).stage).toBe("paid");
    expect((await card(l)).clock_started).toBe(false);

    await db.query(`update launches set assets_in_at = now() - interval '2 hours' where id = $1`, [l]);
    b = await card(l);
    expect([b.stage, b.next_stage]).toEqual(["assets_in", "tech_built"]);
    // Assets in: the 48h clock is running.
    expect(b.clock_started).toBe(true);
    expect(Number(b.sla_hours_elapsed)).toBe(2);
    expect(Number(b.sla_hours_allowed)).toBe(48);
    expect(b.is_overdue).toBe(false);

    await db.query(`update launches set build_done_at = now() where id = $1`, [l]);
    b = await card(l);
    expect([b.stage, b.next_stage]).toEqual(["tech_built", "tech_qc_passed"]);
    expect([b.qc_done, b.qc_all]).toEqual([0, false]);

    await db.query(`update launches set ${QC_ALL}, qc_passed_at = now() where id = $1`, [l]);
    b = await card(l);
    expect([b.stage, b.next_stage, b.qc_done, b.qc_all]).toEqual(["tech_qc_passed", "ads_built", 6, true]);

    await db.query(`update launches set ads_built_at = now() where id = $1`, [l]);
    b = await card(l);
    expect([b.stage, b.next_stage, (b as unknown as { awaiting_approval: boolean }).awaiting_approval]).toEqual(["ads_built", "live", true]);

    await db.query(`update launches set approved_at = now(), approved_by = 'Ryan' where id = $1`, [l]);
    expect((b = await card(l)) && (b as unknown as { awaiting_approval: boolean }).awaiting_approval).toBe(false);
    await db.query(`update launches set live_at = now() where id = $1`, [l]);
    b = await card(l);
    expect(b.stage).toBe("live");
    expect(b.next_stage).toBeNull();
    expect(b.prev_stage).toBe("ads_built");
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
      `insert into launches (client_id, paid_at, assets_in_at) values ($1, now() - interval '5 days', now() - interval '60 hours') returning id`, [c])).id;
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
        `insert into launches (client_id, paid_at, assets_in_at, build_done_at, qc_lead_access, qc_calendar_tested, qc_test_lead_deleted, qc_pixel_firing, qc_cortana_connected, qc_clinic_sheet, qc_passed_at, ads_built_at, approved_at, live_at)
         values ($1, now() - interval '40 days', now() - interval '39 days', now() - interval '38 days', true, true, true, true, true, true, now() - ($2 || ' days')::interval, now() - ($2 || ' days')::interval, now() - ($2 || ' days')::interval, now() - ($2 || ' days')::interval) returning id`,
        [cid, String(days)]);
    const lo = (await ins(old, 15)).id;
    const lr = (await ins(recent, 13)).id;
    expect(await card(lo)).toBeUndefined();
    expect((await card(lr)).stage).toBe("live");
  });
});

describe("going live", () => {
  const card = (id: string) => one<{ stage: string }>(`select stage from launch_board where launch_id = $1`, [id]);
  it("each person moves their own stages, the work is handed on, and Live needs Aryan's approval", async () => {
    const c = await client("Go Live Clinic");
    const l = (await one<{ id: string }>(`insert into launches (client_id, paid_at, owner_id) values ($1, now() - interval '4 days', $2) returning id`, [c, people.sameer])).id;
    // Ryan: assets in. Sameer gets a build job due in 24 hours.
    await asUser(db, AUTH.ryan, async () => { await db.query(`update launches set assets_in_at = now() where id = $1`, [l]); });
    const job = await one<{ owner_id: string; type: string; title: string; hours: number }>(
      `select owner_id, type, title, round(extract(epoch from due_at - requested_at) / 3600)::int as hours from tech_jobs where launch_id = $1`, [l]);
    expect(job).toEqual({ owner_id: people.sameer, type: "launch", title: "Build Go Live Clinic", hours: 24 });
    // Sameer finishing the job moves the card to Tech built.
    await asUser(db, AUTH.sameer, async () => { await db.query(`update tech_jobs set status = 'done' where launch_id = $1`, [l]); });
    expect((await card(l)).stage).toBe("tech_built");
    await asUser(db, AUTH.sameer, async () => {
      await expect(db.query(`update launches set qc_passed_at = now() where id = $1`, [l])).rejects.toThrow(/LAUNCH_QC/);
      await db.query(`update launches set ${QC_ALL} where id = $1`, [l]);
      await db.query(`update launches set qc_passed_at = now() where id = $1`, [l]);
    });
    // Tech QC passed: the media buyer gets an ads task due in 24 hours, and finishing it moves the card to Ads built.
    const task = await one<{ owner_id: string; category: string; title: string; hours: number }>(
      `select owner_id, category, title, round(extract(epoch from due_at - now()) / 3600)::int as hours from tasks where launch_id = $1`, [l]);
    expect(task).toEqual({ owner_id: people.aditya, category: "ads", title: "Build ads for Go Live Clinic", hours: 24 });
    await asUser(db, AUTH.aditya, async () => { await db.query(`update tasks set status = 'done' where launch_id = $1`, [l]); });
    expect((await card(l)).stage).toBe("ads_built");
    // Aryan gets one DM; nobody but him can approve; nothing goes live before he does.
    const dms = (await db.query<{ staff_id: string }>(`select staff_id from notifications where rule_key = 'launch_approval' and record_id = $1`, [l])).rows;
    expect(dms).toEqual([{ staff_id: people.ryan }]);
    await asUser(db, AUTH.aditya, async () => {
      await expect(db.query(`update launches set live_at = now() where id = $1`, [l])).rejects.toThrow(/LAUNCH_APPROVAL/);
      await expect(db.query(`update launches set approved_at = now() where id = $1`, [l])).rejects.toThrow(/LAUNCH_APPROVAL/);
    });
    await asUser(db, AUTH.ryan, async () => { await db.query(`update launches set approved_at = now(), approved_by = 'Ryan' where id = $1`, [l]); });
    await asUser(db, AUTH.aditya, async () => {
      // Aditya cannot update clients himself; the trigger does it.
      expect((await db.query(`update clients set stage = 'live' where id = $1 returning id`, [c])).rows.length).toBe(0);
      await db.query(`update launches set live_at = now() where id = $1`, [l]);
    });
    const row = await one<{ stage: string; launch_date: string; today: string }>(`select stage, launch_date::text, app_today()::text as today from clients where id = $1`, [c]);
    expect(row.stage).toBe("live");
    expect(row.launch_date).toBe(row.today);
    const audit = await one<{ actor: string }>(`select actor from audit_log where table_name = 'clients' and row_id = $1 and field = 'stage' and new_value = 'live'`, [c]);
    expect(audit.actor).toBe("Aditya");
  });

  it("stages go in order", async () => {
    const c = await client("Order Clinic");
    const l = (await one<{ id: string }>(`insert into launches (client_id, paid_at) values ($1, now()) returning id`, [c])).id;
    await expect(db.query(`update launches set build_done_at = now() where id = $1`, [l])).rejects.toThrow(/LAUNCH_ORDER/);
    await expect(db.query(`update launches set ads_built_at = now() where id = $1`, [l])).rejects.toThrow(/LAUNCH_ORDER/);
    await expect(db.query(`update launches set approved_at = now() where id = $1`, [l])).rejects.toThrow(/LAUNCH_ORDER/);
  });

  it("never overwrites a launch date that is already set", async () => {
    const c = await client("Relaunch Clinic", "paused", ", launch_date", ", date '2026-03-01'");
    const l = (await one<{ id: string }>(`insert into launches (client_id, paid_at) values ($1, now()) returning id`, [c])).id;
    await db.query(`update launches set assets_in_at = now(), build_done_at = now(), ${QC_ALL}, qc_passed_at = now(), ads_built_at = now(), approved_at = now(), live_at = now() where id = $1`, [l]);
    const row = await one<{ stage: string; launch_date: string }>(`select stage, launch_date::text from clients where id = $1`, [c]);
    expect(row.stage).toBe("live");
    expect(row.launch_date).toBe("2026-03-01");
  });

  it("only the app owner can move a launch back a stage", async () => {
    const c = await client("Step Back Clinic");
    const l = (await one<{ id: string }>(`insert into launches (client_id, paid_at, assets_in_at, owner_id) values ($1, now(), now(), $2) returning id`, [c, people.sameer])).id;
    await asUser(db, AUTH.sameer, async () => {
      await expect(db.query(`update launches set assets_in_at = null where id = $1`, [l])).rejects.toThrow(/LAUNCH_BACK/);
    });
    await asUser(db, AUTH.marjorie, async () => {
      // A CSR does not run launches: RLS lets nothing through.
      expect((await db.query(`update launches set build_done_at = now() where id = $1 returning id`, [l])).rows.length).toBe(0);
    });
    await asUser(db, AUTH.ryan, async () => {
      expect((await db.query(`update launches set assets_in_at = null where id = $1 returning id`, [l])).rows.length).toBe(1);
    });
    expect((await one<{ stage: string }>(`select stage from launch_board where launch_id = $1`, [l])).stage).toBe("paid");
  });
});

describe("touches", () => {
  it("any staff member logging a touch moves last contact (us) forward, never back", async () => {
    const c = await client("Touch Clinic", "live");
    await asUser(db, AUTH.aditya, async () => {
      await db.query(`insert into touches (client_id, kind, note, by_id, at) values ($1, 'call', 'Weekly check-in', $2, now() - interval '2 days')`, [c, people.aditya]);
      // Logging one as somebody else is refused by RLS.
      await expect(db.query(`insert into touches (client_id, kind, by_id) values ($1, 'slack', $2)`, [c, people.sameer])).rejects.toThrow();
    });
    // CSRs are not staff here (0063): not even as themselves.
    await asUser(db, AUTH.amanda, async () => {
      await expect(db.query(`insert into touches (client_id, kind, by_id) values ($1, 'call', $2)`, [c, people.amanda])).rejects.toThrow(/row-level security/);
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
