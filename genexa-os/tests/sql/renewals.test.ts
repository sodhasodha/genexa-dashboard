import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { AUTH, asUser, freshDb, seedStaff } from "./db";

let db: PGlite;
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const all = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const client = async (name: string, launchDaysAgo = 60) =>
  (await one<{ id: string }>(`insert into clients (name, stage, launch_date) values ($1, 'live', app_today() - $2::int) returning id`, [name, launchDaysAgo])).id;
/** A hand-kept subscription due `dueInDays` from today. */
const plan = async (clientId: string, o: { every?: number; amount?: number; dueInDays?: number; status?: string } = {}) =>
  (await one<{ id: string }>(
    `insert into renewal_plans (client_id, name, every_days, amount, next_due, status) values ($1, 'Patient Protocol', $2, $3, app_today() + $4::int, $5) returning id`,
    [clientId, o.every ?? 30, o.amount ?? 2000, o.dueInDays ?? 10, o.status ?? "active"],
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

describe("renewals (kept by hand)", () => {
  it("the soonest-due subscription that has not ended sets the cycle; profit = revenue - spend - 30% of revenue", async () => {
    const c = await client("Renew B", 60);
    await plan(c, { every: 30, dueInDays: 10 }); // cycle started 20 days ago
    await plan(c, { every: 30, dueInDays: 25 });
    await plan(c, { every: 30, dueInDays: 2, status: "ended" }); // ignored for the cycle
    await spend(c, 30, 999); // before this cycle, after launch
    await spend(c, 10, 300);
    await spend(c, 0, 200);
    await purchase(c, 25, 4000); // before this cycle
    await purchase(c, 3, 2000);
    const r = await one<Record<string, string>>(`select *, next_due::text as due, (app_today() + 10)::text as want from renewal_clients where client_id = $1`, [c]);
    expect(r.due).toBe(r.want);
    expect(Number(r.cycle_spend)).toBe(500);
    expect(Number(r.cycle_revenue)).toBe(2000);
    expect(Number(r.cycle_profit)).toBe(2000 - 500 - 600);
    expect(Number(r.launch_spend)).toBe(1499);
    expect(Number(r.launch_revenue)).toBe(6000);
    expect(Number(r.launch_profit)).toBe(6000 - 1499 - 1800);
  });

  it("a removed subscription takes the client off the page; one with only ended subscriptions has no cycle", async () => {
    const gone = await client("Renew Gone");
    const p = await plan(gone);
    await db.query(`update renewal_plans set archived_at = now() where id = $1`, [p]);
    expect(await all(`select 1 from renewal_clients where client_id = $1`, [gone])).toEqual([]);

    const ended = await client("Renew Ended");
    await plan(ended, { status: "ended" });
    const r = await one<{ next_due: string | null; cycle_spend: string | null }>(`select next_due, cycle_spend from renewal_clients where client_id = $1`, [ended]);
    expect(r).toEqual({ next_due: null, cycle_spend: null });
  });

  it("only the owner can see or change subscriptions, every change is audited, and none can be deleted", async () => {
    const c = await client("Renew D");
    const p = await asUser(db, AUTH.ryan, async () =>
      (await one<{ id: string }>(`insert into renewal_plans (client_id, name, every_days, amount, next_due) values ($1, 'Retainer', 30, 1500, app_today() + 5) returning id`, [c])).id);
    await asUser(db, AUTH.ryan, () => db.query(`update renewal_plans set amount = 1800 where id = $1`, [p]));
    expect(await asUser(db, AUTH.aditya, () => all(`select 1 from renewal_plans`))).toEqual([]);
    await expect(asUser(db, AUTH.aditya, () => db.query(`insert into renewal_plans (client_id, name, every_days, amount, next_due) values ($1, 'x', 30, 1, app_today())`, [c]))).rejects.toThrow();
    await expect(db.query(`delete from renewal_plans where id = $1`, [p])).rejects.toThrow();
    const audit = await all<{ old_value: string; new_value: string; actor: string }>(`select old_value, new_value, actor from audit_log where table_name = 'renewal_plans' and field = 'amount'`);
    expect(audit).toEqual([{ old_value: "1500.00", new_value: "1800.00", actor: "Ryan" }]);
  });

  it("refuses nonsense: zero-day frequency, negative amount, unknown status, blank name", async () => {
    const c = await client("Renew F");
    const bad = (cols: string) => db.query(`insert into renewal_plans (client_id, name, every_days, amount, next_due, status) values ($1, ${cols})`, [c]);
    await expect(bad(`'P', 0, 10, app_today(), 'active'`)).rejects.toThrow();
    await expect(bad(`'P', 30, -1, app_today(), 'active'`)).rejects.toThrow();
    await expect(bad(`'P', 30, 10, app_today(), 'paused'`)).rejects.toThrow();
    await expect(bad(`'  ', 30, 10, app_today(), 'active'`)).rejects.toThrow();
  });
});
