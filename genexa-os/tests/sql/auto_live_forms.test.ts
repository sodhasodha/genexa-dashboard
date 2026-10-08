import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { AUTH, asUser, freshDb, seedStaff, type TestPeople } from "./db";

let db: PGlite;
let people: TestPeople;
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const live = async () => (await db.query<{ name: string; live_date: string }>(`select name, live_date::text from launches_auto_live() order by name`)).rows;
const intake = async (id: string, kind: string, client: string | null, org: string, at = "2026-10-01T15:00:00Z") =>
  (await one<{ r: { result: string; client_id?: string; launch_id?: string } }>(`select ghl_form_intake($1, $2, $3, $4, 'Jane Owner', $5) as r`, [id, kind, client, org, at])).r;

beforeEach(async () => {
  db = await freshDb();
  people = await seedStaff(db);
});

describe("live from the first day of ad spend", () => {
  it("an onboarding clinic goes live the first day it spends, QC boxes or not; a clinic with no spend or unverified ads does not", async () => {
    const mk = async (name: string, biz: string | null) => (await one<{ id: string }>(`insert into clients (name, stage, cortana_business_id) values ($1, 'onboarding', $2) returning id`, [name, biz])).id;
    const spending = await mk("Spending Clinic", "biz-a");
    const quiet = await mk("Quiet Clinic", "biz-b");
    const unverified = await mk("Unverified Clinic", "biz-c");
    await db.query(`insert into client_campaign_scope (client_id, verified) values ($1, false)`, [unverified]);
    await db.query(`insert into launches (client_id, paid_at) values ($1, now() - interval '6 days')`, [spending]);
    await db.query(`insert into ad_metrics_daily (client_id, date, spend) values ($1, app_today() - 3, 0), ($1, app_today() - 2, 41.5), ($1, app_today() - 1, 60), ($2, app_today() - 1, 0), ($3, app_today() - 1, 25)`, [spending, quiet, unverified]);
    const went = await live();
    expect(went.map((w) => w.name)).toEqual(["Spending Clinic"]);
    const l = await one<{ live_source: string; d: boolean; qc: boolean }>(`select live_source, app_day(live_at) = app_today() - 2 as d, qc_lead_access as qc from launches where client_id = $1`, [spending]);
    expect(l).toEqual({ live_source: "ad_spend", d: true, qc: false });
    const c = await one<{ stage: string; ld: boolean }>(`select stage, launch_date = app_today() - 2 as ld from clients where id = $1`, [spending]);
    expect(c).toEqual({ stage: "live", ld: true });
    expect(await live()).toEqual([]);
    expect((await one<{ stage: string }>(`select stage from clients where id = $1`, [quiet])).stage).toBe("onboarding");
    expect((await one<{ stage: string }>(`select stage from clients where id = $1`, [unverified])).stage).toBe("onboarding");
  });

  it("creates the launch when an onboarding clinic has none, and a person still cannot skip QC by hand", async () => {
    const id = (await one<{ id: string }>(`insert into clients (name, stage, cortana_business_id) values ('No Launch Clinic', 'onboarding', 'biz-d') returning id`)).id;
    await db.query(`insert into ad_metrics_daily (client_id, date, spend) values ($1, app_today() - 1, 12)`, [id]);
    expect((await live()).length).toBe(1);
    expect((await one<{ owner_id: string }>(`select owner_id from launches where client_id = $1`, [id])).owner_id).toBe(people.sameer);
    const other = (await one<{ id: string }>(`insert into clients (name, stage) values ('Manual Clinic', 'onboarding') returning id`)).id;
    const launch = (await one<{ id: string }>(`insert into launches (client_id) values ($1) returning id`, [other])).id;
    await asUser(db, AUTH.ryan, async () => {
      await expect(db.query(`update launches set live_at = now() where id = $1`, [launch])).rejects.toThrow(/LAUNCH_QC/);
    });
  });
});

describe("GHL forms", () => {
  it("a New Client Form with no matching client creates the client and its launch, once", async () => {
    const r = await intake("sub_1", "new_client", null, "Brand New Clinic");
    expect(r.result).toBe("client_created");
    const c = await one<{ stage: string; contact_name: string }>(`select stage, contact_name from clients where id = $1`, [r.client_id]);
    expect(c).toEqual({ stage: "onboarding", contact_name: "Jane Owner" });
    expect((await db.query(`select 1 from launches where client_id = $1`, [r.client_id])).rows.length).toBe(1);
    expect((await intake("sub_1", "new_client", null, "Brand New Clinic")).result).toBe("already_taken");
    expect((await db.query(`select 1 from clients where name = 'Brand New Clinic'`)).rows.length).toBe(1);
  });

  it("an Onboarding Form marks the open launch 'OB form complete' at the time it was submitted, and waits when no client fits", async () => {
    const r = await intake("sub_2", "new_client", null, "Form Clinic");
    expect((await intake("sub_3", "onboarding", null, "Unknown Name")).result).toBe("unmatched");
    expect((await intake("sub_3", "onboarding", r.client_id as string, "Form Clinic LLC", "2026-10-02T09:30:00Z")).result).toBe("matched");
    const l = await one<{ at: string; stage: string }>(`select to_char(l.ob_form_done_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as at, b.stage from launches l join launch_board b on b.launch_id = l.id where l.client_id = $1`, [r.client_id]);
    expect(l).toEqual({ at: "2026-10-02 09:30", stage: "ob_form_complete" });
    const stored = await one<{ p: Record<string, unknown> }>(`select payload as p from webhook_events where event_id = 'sub_3'`);
    expect(Object.keys(stored.p).sort()).toEqual(["at", "client_id", "kind", "organization"]);
  });

  it("a form for a clinic that is already live changes nothing about its stage and makes no new launch", async () => {
    const id = (await one<{ id: string }>(`insert into clients (name, stage, contact_name) values ('Live Clinic', 'live', 'Existing Contact') returning id`)).id;
    expect((await intake("sub_4", "new_client", id, "Live Clinic")).result).toBe("matched");
    expect((await intake("sub_5", "onboarding", id, "Live Clinic")).result).toBe("matched");
    expect((await db.query(`select 1 from launches where client_id = $1`, [id])).rows.length).toBe(0);
    expect(await one<{ stage: string; contact_name: string }>(`select stage, contact_name from clients where id = $1`, [id])).toEqual({ stage: "live", contact_name: "Existing Contact" });
  });

  it("Whop first, form second: the form lands on the Whop-made client and gives it the clinic's name", async () => {
    await db.query(`insert into app_settings (key, value) values ('whop_mrr_product_prefix', '"Genexa Scaling"') on conflict (key) do update set value = excluded.value`);
    await db.query(`update app_settings set value = to_jsonb(now() - interval '1 day') where key = 'whop_new_client_from'`);
    await db.query(`insert into payments (whop_payment_id, whop_user_id, customer_name, customer_email, amount, paid_at, product_title, status) values ('pay_w', 'user_w', 'Jane Owner', 'jane@clinic.test', 2000, now() - interval '1 hour', 'Genexa Scaling: Patient Protocol', 'paid')`);
    const made = (await db.query<{ client_id: string }>(`select client_id from whop_create_new_clients()`)).rows[0].client_id;
    const r = (await one<{ r: { result: string } }>(`select ghl_form_intake('sub_w', 'new_client', $1, 'Owner Regenerative Clinic', 'Jane Owner', now(), 'Jane@Clinic.test') as r`, [made])).r;
    expect(r.result).toBe("matched");
    expect(await one<{ name: string; contact_email: string }>(`select name, contact_email from clients where id = $1`, [made])).toEqual({ name: "Owner Regenerative Clinic", contact_email: "jane@clinic.test" });
    expect((await db.query(`select 1 from clients`)).rows.length).toBe(1);
  });

  it("form first, Whop second: the payment attaches to the form's client and no second client is created", async () => {
    await db.query(`insert into app_settings (key, value) values ('whop_mrr_product_prefix', '"Genexa Scaling"') on conflict (key) do update set value = excluded.value`);
    await db.query(`update app_settings set value = to_jsonb(now() - interval '1 day') where key = 'whop_new_client_from'`);
    const r = (await one<{ r: { client_id: string } }>(`select ghl_form_intake('sub_f', 'new_client', null, 'Form First Clinic', 'Sam Payer', now(), 'sam@clinic.test') as r`)).r;
    await db.query(`insert into payments (whop_payment_id, whop_user_id, customer_name, customer_email, amount, paid_at, product_title, status) values ('pay_f', 'user_f', 'S Payer', 'SAM@clinic.test', 2000, now(), 'Genexa Scaling: Patient Protocol', 'paid')`);
    expect((await one<{ n: number }>(`select whop_attach_known_contacts() as n`)).n).toBe(1);
    expect((await db.query(`select * from whop_create_new_clients()`)).rows).toEqual([]);
    expect(await one<{ client_id: string }>(`select client_id from payments where whop_payment_id = 'pay_f'`)).toEqual({ client_id: r.client_id });
    expect((await db.query(`select 1 from clients`)).rows.length).toBe(1);
  });
});
