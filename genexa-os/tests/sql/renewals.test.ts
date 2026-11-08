import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { AUTH, asUser, freshDb, seedStaff } from "./db";

let db: PGlite;
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const all = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const client = async (name: string, launchDaysAgo = 60) =>
  (await one<{ id: string }>(`insert into clients (name, stage, launch_date) values ($1, 'live', app_today() - $2::int) returning id`, [name, launchDaysAgo])).id;
/** A Whop subscription whose period started `startedDaysAgo` and ends `endsInDays` from now. */
const sub = async (clientId: string | null, ref: string, o: { days?: number | null; price?: number; startedDaysAgo?: number; endsInDays?: number; status?: string; valid?: boolean; cancelling?: boolean } = {}) =>
  (await one<{ id: string }>(
    `insert into whop_memberships (whop_membership_id, client_id, product_title, status, valid, cancel_at_period_end, billing_period_days, renewal_price, renewal_period_start, renewal_period_end, started_at)
     values ($1, $2, 'Genexa Scaling: Patient Protocol', $3, $4, $5, $6, $7, now() - ($8 || ' days')::interval, now() + ($9 || ' days')::interval, now() - interval '200 days') returning id`,
    [ref, clientId, o.status ?? "active", o.valid ?? true, o.cancelling ?? false, o.days === undefined ? 30 : o.days, o.price ?? 2000, String(o.startedDaysAgo ?? 20), String(o.endsInDays ?? 10)],
  )).id;
const spend = (clientId: string, daysAgo: number, amount: number) =>
  db.query(`insert into ad_metrics_daily (client_id, date, spend) values ($1, app_today() - $2::int, $3)`, [clientId, daysAgo, amount]);
const purchase = (clientId: string, daysAgo: number, value: number) =>
  db.query(
    `insert into cortana_events (client_id, cortana_entry_id, event, occurred_at, value, contact_id) values ($1, gen_random_uuid()::text, 'purchase', now() - ($2 || ' days')::interval, $3, gen_random_uuid()::text)`,
    [clientId, String(daysAgo), value],
  );

beforeAll(async () => {
  db = await freshDb();
  await seedStaff(db);
});

describe("renewals", () => {
  it("lists recurring subscriptions under their client with state, and leaves out one-offs and subscriptions with no client", async () => {
    const c = await client("Renew A");
    await sub(c, "r_active");
    await sub(c, "r_pastdue", { status: "past_due", valid: false });
    await sub(c, "r_cancelling", { valid: true, cancelling: true });
    await sub(c, "r_cancelled_running", { status: "canceled", valid: false, endsInDays: 3 });
    await sub(c, "r_ended", { status: "canceled", valid: false, endsInDays: -5 });
    await sub(c, "r_oneoff", { days: null });
    await sub(null, "r_orphan");
    const rows = await all<{ ref: string; state: string }>(
      `select m.whop_membership_id as ref, r.state from renewal_subscriptions r join whop_memberships m on m.id = r.membership_id where r.client_id = $1 order by 1`, [c]);
    expect(rows).toEqual([
      { ref: "r_active", state: "active" },
      { ref: "r_cancelled_running", state: "cancelling" },
      { ref: "r_cancelling", state: "cancelling" },
      { ref: "r_ended", state: "ended" },
      { ref: "r_pastdue", state: "past_due" },
    ]);
    expect(await all(`select 1 from renewal_subscriptions r join whop_memberships m on m.id = r.membership_id where m.whop_membership_id = 'r_orphan'`)).toEqual([]);
  });

  it("the cycle is set by the soonest-due running subscription; profit = revenue - spend - 30% of revenue", async () => {
    const c = await client("Renew B", 60);
    await sub(c, "b_soon", { startedDaysAgo: 20, endsInDays: 10 });
    await sub(c, "b_later", { startedDaysAgo: 5, endsInDays: 25 });
    await spend(c, 30, 999); // before this cycle, after launch
    await spend(c, 10, 300);
    await spend(c, 0, 200);
    await purchase(c, 25, 4000); // before this cycle
    await purchase(c, 3, 2000);
    const r = await one<Record<string, string>>(`select * from renewal_clients where client_id = $1`, [c]);
    expect(Number(r.cycle_spend)).toBe(500);
    expect(Number(r.cycle_revenue)).toBe(2000);
    expect(Number(r.cycle_profit)).toBe(2000 - 500 - 600);
    expect(Number(r.launch_spend)).toBe(1499);
    expect(Number(r.launch_revenue)).toBe(6000);
    expect(Number(r.launch_profit)).toBe(6000 - 1499 - 1800);
    expect(String(r.next_due)).toBe(String((await one<{ d: string }>(`select app_day(now() + interval '10 days') as d`)).d));
  });

  it("an edit wins over Whop until Whop's own due date moves; frequency and amount edits stay", async () => {
    const c = await client("Renew C");
    const m = await sub(c, "c_sub", { days: 30, price: 2000, startedDaysAgo: 20, endsInDays: 10 });
    await db.query(
      `insert into renewal_overrides (membership_id, billing_period_days, amount, next_due, next_due_whop_date)
       select $1, 90, 5000, app_today() + 40, app_day(renewal_period_end) from whop_memberships where id = $1`, [m]);
    const row = () => one<{ every_days: number; amount: string; next_due: string; cycle_start: string; edit_due_expired: boolean; d40: string; d50: string }>(
      `select every_days, amount, next_due::text, cycle_start::text, edit_due_expired, (app_today() + 40)::text as d40, (app_today() + 40 - 90)::text as d50 from renewal_subscriptions where membership_id = $1`, [m]);
    let r = await row();
    expect([r.every_days, Number(r.amount), r.next_due, r.cycle_start, r.edit_due_expired]).toEqual([90, 5000, r.d40, r.d50, false]);
    // Whop renews: its date moves, the old typed date is no longer used.
    await db.query(`update whop_memberships set renewal_period_end = now() + interval '40 days' where id = $1`, [m]);
    r = await row();
    expect(r.edit_due_expired).toBe(true);
    expect(r.next_due).toBe((await one<{ d: string }>(`select app_day(now() + interval '40 days')::text as d`)).d);
    expect([r.every_days, Number(r.amount)]).toEqual([90, 5000]);
  });

  it("only the owner can see or change edits, and none can be deleted", async () => {
    const c = await client("Renew D");
    const m = await sub(c, "d_sub");
    await asUser(db, AUTH.ryan, () => db.query(`insert into renewal_overrides (membership_id, note) values ($1, 'call Mitch first')`, [m]));
    expect((await all(`select note from renewal_overrides where membership_id = $1`, [m])).length).toBe(1);
    expect(await asUser(db, AUTH.aditya, () => all(`select 1 from renewal_overrides`))).toEqual([]);
    const two = await sub(c, "d_two");
    await expect(asUser(db, AUTH.aditya, () => db.query(`insert into renewal_overrides (membership_id, note) values ($1, 'x')`, [two]))).rejects.toThrow();
    await expect(db.query(`delete from renewal_overrides where membership_id = $1`, [m])).rejects.toThrow();
    await asUser(db, AUTH.ryan, () => db.query(`update renewal_overrides set note = 'call Mitch on Friday' where membership_id = $1`, [m]));
    const audit = await all<{ old_value: string; new_value: string; actor: string }>(`select old_value, new_value, actor from audit_log where table_name = 'renewal_overrides' and field = 'note'`);
    expect(audit).toEqual([{ old_value: "call Mitch first", new_value: "call Mitch on Friday", actor: "Ryan" }]);
  });

  it("a client whose subscriptions all ended still has a row, with no cycle and no figures", async () => {
    const c = await client("Renew E");
    await sub(c, "e_ended", { status: "canceled", valid: false, endsInDays: -3 });
    expect(await all(`select 1 from renewal_clients where client_id = $1`, [c])).toEqual([]);
    const r = await one<{ next_due: string | null; cycle_spend: string | null }>(`select next_due, cycle_spend from renewal_clients_all where client_id = $1`, [c]);
    expect(r).toEqual({ next_due: null, cycle_spend: null });
  });
});
