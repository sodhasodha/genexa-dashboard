import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshDb, seedStaff, type TestPeople } from "./db";

let db: PGlite;
let people: TestPeople;
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const id = async (sql: string, params: unknown[] = []) => (await one<{ id: string }>(sql, params)).id;
const QC = "qc_lead_access = true, qc_calendar_tested = true, qc_test_lead_deleted = true, qc_pixel_firing = true, qc_cortana_connected = true, qc_clinic_sheet = true";

beforeAll(async () => {
  db = await freshDb();
  people = await seedStaff(db);
  await db.query(`insert into app_settings (key, value) values ('whop_mrr_product_prefix', '"Genexa Scaling"') on conflict (key) do update set value = excluded.value`);
});

describe("Whop payment -> Paid", () => {
  it("a paying client still onboarding gets a card at Paid, and an open card with no payment date gets one", async () => {
    const noCard = await id(`insert into clients (name, stage) values ('No Card Clinic', 'onboarding') returning id`);
    const formFirst = await id(`insert into clients (name, stage) values ('Form First Clinic', 'onboarding') returning id`);
    const liveOne = await id(`insert into clients (name, stage) values ('Live Clinic', 'live') returning id`);
    const card = await id(`insert into launches (client_id) values ($1) returning id`, [formFirst]);
    for (const [c, k] of [[noCard, "a"], [formFirst, "b"], [liveOne, "c"]] as const) {
      await db.query(`insert into payments (whop_payment_id, client_id, customer_name, amount, paid_at, product_title, status) values ($1, $2, 'X', 2000, now() - interval '2 days', 'Genexa Scaling: Patient Protocol', 'paid')`, [`p_${k}`, c]);
    }
    expect((await one<{ n: number }>(`select launches_from_payments() as n`)).n).toBe(2);
    const made = await one<{ stage: string; owner_id: string }>(`select b.stage, b.owner_id from launch_board b where b.client_id = $1`, [noCard]);
    expect(made).toEqual({ stage: "paid", owner_id: people.sameer });
    expect((await one<{ ok: boolean }>(`select paid_at < now() - interval '1 day' as ok from launches where id = $1`, [card])).ok).toBe(true);
    // A live clinic's renewal never makes a card, and running again changes nothing.
    expect((await db.query(`select 1 from launches where client_id = $1`, [liveOne])).rows.length).toBe(0);
    expect((await one<{ n: number }>(`select launches_from_payments() as n`)).n).toBe(0);
  });
});

describe("Onboarding Form -> Assets in", () => {
  it("moves the card to Assets in, starts the clock and hands Sameer the build", async () => {
    const c = await id(`insert into clients (name, stage) values ('Form Clinic', 'onboarding') returning id`);
    const l = await id(`insert into launches (client_id, paid_at) values ($1, now() - interval '3 days') returning id`, [c]);
    const r = await one<{ r: { result: string } }>(`select ghl_form_intake('sub_x', 'onboarding', $1, 'Form Clinic', 'Jo', now()) as r`, [c]);
    expect(r.r.result).toBe("matched");
    const b = await one<{ stage: string; clock_started: boolean }>(`select stage, clock_started from launch_board where launch_id = $1`, [l]);
    expect(b).toEqual({ stage: "assets_in", clock_started: true });
    expect((await one<{ owner_id: string }>(`select owner_id from tech_jobs where launch_id = $1`, [l])).owner_id).toBe(people.sameer);
  });
});

describe("stuck cards", () => {
  const due = () => db.query<{ staff_id: string; window_key: string; payload: { clinic: string; stage: string } }>(
    `select staff_id, window_key, payload from notifications where rule_key = 'launch_stuck' order by created_at, window_key`);
  it("pings the stage's owner once the limit passes, again every 24 hours, and not after the card moves", async () => {
    const c = await id(`insert into clients (name, stage) values ('Stuck Clinic', 'onboarding') returning id`);
    const l = await id(`insert into launches (client_id, paid_at) values ($1, now() - interval '47 hours') returning id`, [c]);
    const mine = async () => (await one<{ n: number }>(`select count(*)::int as n from notifications where rule_key = 'launch_stuck' and record_id = $1`, [l])).n;
    await db.query(`select launch_stuck_enqueue()`);
    expect(await mine()).toBe(0); // 47h in Paid: under 48
    await db.query(`update launches set paid_at = now() - interval '49 hours' where id = $1`, [l]);
    await db.query(`select launch_stuck_enqueue()`);
    expect(await mine()).toBe(1);
    await db.query(`select launch_stuck_enqueue()`);
    expect(await mine()).toBe(1); // same day: once
    let rows = (await due()).rows.filter((r) => r.payload.clinic === "Stuck Clinic");
    expect(rows.map((r) => [r.staff_id, r.window_key])).toEqual([[people.ryan, "paid:0"]]);
    await db.query(`update launches set paid_at = now() - interval '73 hours' where id = $1`, [l]); // a day later
    await db.query(`select launch_stuck_enqueue()`);
    expect(await mine()).toBe(2);
    // Assets in for 25h: Sameer's turn.
    await db.query(`update launches set assets_in_at = now() - interval '25 hours' where id = $1`, [l]);
    await db.query(`select launch_stuck_enqueue()`);
    rows = (await due()).rows.filter((r) => r.payload.clinic === "Stuck Clinic");
    expect(rows.map((r) => [r.staff_id, r.window_key])).toEqual([[people.ryan, "paid:0"], [people.ryan, "paid:1"], [people.sameer, "assets_in:0"]]);
    // Ads built and waiting 30h: back to Aryan. A paused card is never pinged.
    await db.query(`update launches set build_done_at = now() - interval '40 hours', ${QC}, qc_passed_at = now() - interval '35 hours', ads_built_at = now() - interval '30 hours' where id = $1`, [l]);
    await db.query(`select launch_stuck_enqueue()`);
    expect((await due()).rows.filter((r) => r.payload.clinic === "Stuck Clinic").at(-1)?.window_key).toBe("awaiting_approval:0");
    await db.query(`insert into sla_pauses (launch_id, reason, evidence_note) values ($1, 'client_access', 'Asked for Meta access')`, [l]);
    expect((await one<{ n: number }>(`select count(*)::int as n from launch_stuck where launch_id = $1`, [l])).n).toBe(0);
  });

  it("an unsent ping is dropped when the card moves on before it goes out", async () => {
    const c = await id(`insert into clients (name, stage) values ('Moving Clinic', 'onboarding') returning id`);
    const l = await id(`insert into launches (client_id, paid_at) values ($1, now() - interval '50 hours') returning id`, [c]);
    await db.query(`select launch_stuck_enqueue()`);
    await db.query(`update launches set assets_in_at = now() where id = $1`, [l]);
    await db.query(`select launch_stuck_enqueue()`);
    const n = await one<{ slack_ts: string }>(`select slack_ts from notifications where rule_key = 'launch_stuck' and record_id = $1`, [l]);
    expect(n.slack_ts).toBe("skipped:resolved");
  });

  it("a card already past Tech built does not get a build job when its Assets in date is filled in later", async () => {
    const c = await id(`insert into clients (name, stage) values ('Legacy Clinic', 'onboarding') returning id`);
    const l = await id(`insert into launches (client_id, paid_at, build_done_at, ${QC.replaceAll(" = true", "")}, qc_passed_at)
      values ($1, now() - interval '9 days', now() - interval '5 days', true, true, true, true, true, true, now() - interval '4 days') returning id`, [c]);
    await db.query(`update launches set assets_in_at = now() where id = $1`, [l]);
    expect((await db.query(`select 1 from tech_jobs where launch_id = $1`, [l])).rows.length).toBe(0);
  });
});
