import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshDb, seedStaff, type TestPeople } from "./db";

let db: PGlite;
let people: TestPeople;
const make = async () => (await db.query<{ client_id: string; name: string; amount: string; paid_at: string }>(`select * from whop_create_new_clients()`)).rows;
const pay = (id: string, user: string, name: string, amount: number, when: string, product = "Genexa Scaling: Patient Protocol", status = "paid") =>
  db.query(`insert into payments (whop_payment_id, whop_user_id, customer_name, amount, paid_at, product_title, status)
            values ($1, $2, $3, $4, ${when}, $5, $6)`, [id, user, name, amount, product, status]);

beforeEach(async () => {
  db = await freshDb();
  people = await seedStaff(db);
  await db.query(`insert into app_settings (key, value) values ('whop_mrr_product_prefix', '"Genexa Scaling"') on conflict (key) do update set value = excluded.value`);
  await db.query(`update app_settings set value = to_jsonb(now() - interval '1 day') where key = 'whop_new_client_from'`);
});

describe("new clients from Whop", () => {
  it("a first payment for a Genexa product creates the client in onboarding and a launch at Paid, once", async () => {
    await pay("pay_1", "user_new", "Dr Jane Newclinic", 2000, "now() - interval '2 hours'");
    await db.query(`insert into whop_memberships (whop_membership_id, whop_user_id, product_title, status, valid, billing_period_days, renewal_price, started_at)
                    values ('mem_new', 'user_new', 'Genexa Scaling: Patient Protocol', 'active', true, 30, 2000, now() - interval '2 hours')`);
    const made = await make();
    expect(made.map((m) => [m.name, Number(m.amount)])).toEqual([["Dr Jane Newclinic", 2000]]);
    const c = (await db.query<{ stage: string; contact_name: string; whop_customer_ids: string[]; billing_cycle: string; cycle_fee: string }>(
      `select stage, contact_name, whop_customer_ids, billing_cycle, cycle_fee from clients where id = $1`, [made[0].client_id])).rows[0];
    expect(c).toMatchObject({ stage: "onboarding", contact_name: "Dr Jane Newclinic", whop_customer_ids: ["user_new"], billing_cycle: "30" });
    expect(Number(c.cycle_fee)).toBe(2000);
    const l = (await db.query<{ same: boolean; live_at: string | null; owner_id: string }>(
      `select l.paid_at = p.paid_at as same, l.live_at, l.owner_id from launches l join payments p on p.whop_payment_id = 'pay_1' where l.client_id = $1`, [made[0].client_id])).rows;
    expect(l).toEqual([{ same: true, live_at: null, owner_id: people.sameer }]);
    const linked = await db.query(`select 1 from payments where client_id = $1 union all select 1 from whop_memberships where client_id = $1`, [made[0].client_id]);
    expect(linked.rows.length).toBe(2);
    const stage = (await db.query<{ stage: string }>(`select stage from launch_board where client_id = $1`, [made[0].client_id])).rows[0];
    expect(stage.stage).toMatch(/paid/i);
    // Running again creates nothing, and neither does the customer's next payment.
    expect(await make()).toEqual([]);
    await pay("pay_2", "user_new", "Dr Jane Newclinic", 2000, "now()");
    expect(await make()).toEqual([]);
    expect((await db.query(`select 1 from clients where name = 'Dr Jane Newclinic'`)).rows.length).toBe(1);
  });

  it("does not create a client for an old customer we failed to match, another product, an unpaid charge, or a matched customer", async () => {
    await pay("pay_old1", "user_old", "Old Customer", 2000, "now() - interval '40 days'");
    await pay("pay_old2", "user_old", "Old Customer", 2000, "now() - interval '1 hour'"); // renewing: an existing client, not a new one
    await pay("pay_other", "user_other", "Course Buyer", 97, "now() - interval '1 hour'", "Some Other Product");
    await pay("pay_open", "user_open", "Declined Card", 2000, "now() - interval '1 hour'", "Genexa Scaling: Patient Protocol", "open");
    const known = (await db.query<{ id: string }>(`insert into clients (name, stage, whop_customer_ids) values ('Known Clinic', 'live', '{user_known}') returning id`)).rows[0].id;
    await db.query(`insert into payments (whop_payment_id, whop_user_id, client_id, customer_name, amount, paid_at, product_title, status)
                    values ('pay_known', 'user_known', $1, 'Known', 2000, now() - interval '1 hour', 'Genexa Scaling: Patient Protocol', 'paid')`, [known]);
    expect(await make()).toEqual([]);
    expect((await db.query(`select 1 from clients`)).rows.length).toBe(1);
  });

  it("never reuses a name that is already taken, and does nothing before the switch-on time is set", async () => {
    await db.query(`insert into clients (name, stage) values ('Same Name', 'live')`);
    await pay("pay_same", "user_same", "Same Name", 1500, "now() - interval '1 hour'");
    const made = await make();
    expect(made[0].name).toMatch(/^Same Name \(Whop \d\d \w{3}\)$/);
    await db.query(`update app_settings set value = 'null'::jsonb where key = 'whop_new_client_from'`);
    await pay("pay_x", "user_x", "Another One", 1500, "now() - interval '1 hour'");
    expect(await make()).toEqual([]);
  });
});
