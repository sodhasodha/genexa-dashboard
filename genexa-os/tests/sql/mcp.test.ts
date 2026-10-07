import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { AUTH, asUser, freshDb, seedStaff, type TestPeople } from "./db";
import { definedArgs, McpDbError, type McpData } from "@/lib/mcp/data";
import { callTool } from "@/lib/mcp/server";
import { TOOLS } from "@/lib/mcp/tools";

let db: PGlite;
let people: TestPeople;
let today: string;
let data: McpData;
const ids = {} as { alpha: string; beta: string; churned: string; deleted: string; exception: string; resolved: string; job: string };

const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const id = async (sql: string, params: unknown[] = []) => (await one<{ id: string }>(sql, params)).id;

/** McpData on the test database: the same SQL functions the endpoint calls, named arguments and all. */
function pgData(pg: PGlite): McpData {
  return {
    async call(fn, args) {
      const entries = Object.entries(definedArgs(args));
      // Everything travels as text and is cast by Postgres, the way PostgREST does it.
      const types = await pg.query<{ name: string; type: string }>(
        `select a.name, format_type(a.type, null) as type
         from pg_proc p, unnest(p.proargnames, p.proargtypes::oid[]) as a(name, type)
         where p.proname = $1`, [fn]);
      const typeOf = new Map(types.rows.map((r) => [r.name, r.type]));
      const list = entries.map(([k], i) => `${k} => ($${i + 1}::text)::${typeOf.get(k) ?? "text"}`).join(", ");
      const values = entries.map(([, v]) => (v === null ? null : typeof v === "object" ? JSON.stringify(v) : String(v)));
      try {
        return (await pg.query<{ r: unknown }>(`select ${fn}(${list}) as r`, values)).rows[0].r;
      } catch (err) {
        throw new McpDbError((err as Error).message);
      }
    },
  };
}

/** Calls a tool the way tools/call does and returns its structured result. */
async function run(name: string, args: Record<string, unknown> = {}, source: McpData = data) {
  const result = await callTool({ name, arguments: args }, { data: source, today });
  expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  return { ...result, out: result.structuredContent as Record<string, never> };
}

const audit = (table: string, rowId: string) =>
  db.query<{ field: string; actor: string; new_value: string | null }>(
    `select field, actor, new_value from audit_log where table_name = $1 and row_id = $2 order by at, field`, [table, rowId]);

beforeAll(async () => {
  db = await freshDb();
  people = await seedStaff(db);
  data = pgData(db);
  today = (await one<{ d: string }>(`select app_today()::text as d`)).d;

  ids.alpha = await id(
    `insert into clients (name, contact_name, stage, pod, cortana_business_id, billing_cycle, cycle_fee, launch_date)
     values ('Alpha Clinic', 'Dr Contactson', 'live', 'pod_1', 'biz-a', '30', 3000, app_today() - 40) returning id`);
  ids.beta = await id(`insert into clients (name, stage, billing_cycle, cycle_fee) values ('Beta Clinic', 'onboarding', '90', 6000) returning id`);
  ids.churned = await id(`insert into clients (name, stage) values ('Gone Clinic', 'churned') returning id`);
  ids.deleted = await id(`insert into clients (name, stage, deleted_at) values ('Deleted Clinic', 'live', now()) returning id`);

  await db.query(
    `insert into whop_memberships (whop_membership_id, client_id, email, valid, billing_period_days, renewal_price, renewal_period_start, renewal_period_end, started_at)
     values ('m1', $1, 'billing@alphaclinic.test', true, 30, 3500, now() - interval '10 days', now() + interval '20 days', now() - interval '70 days')`, [ids.alpha]);
  await db.query(`insert into ad_metrics_daily (client_id, date, spend, impressions, clicks) values ($1, app_today(), 100, 1000, 20), ($1, app_today() - 1, 50, 500, 5)`, [ids.alpha]);
  await db.query(
    `insert into cortana_events (client_id, cortana_entry_id, event, occurred_at, contact_id, contact_first_name) values
       ($1, 'e1', 'lead', now(), 'x', 'Maria'), ($1, 'e2', 'lead', now(), 'y', 'Tom'), ($1, 'e3', 'unconfirmed_appointment_booked', now(), 'x', 'Maria')`, [ids.alpha]);
  await db.query(
    `insert into ad_metrics_ad_window (client_id, ad_id, period, ad_name, ad_status, window_start, window_end, spend, impressions, clicks, ctr, frequency, leads, booked)
     values ($1, 'ad1', '7d', 'Knee pain video', 'ACTIVE', app_today() - 7, app_today() - 1, 140, 4000, 60, 1.5, 1.4, 6, 2),
            ($1, 'ad1', 'all', 'Knee pain video', 'ACTIVE', app_today() - 40, app_today() - 1, 900, 30000, 500, 1.67, 2.1, 40, 12)`, [ids.alpha]);
  // People and payers whose details must never leave through the endpoint.
  await db.query(`insert into leads (client_id, ghl_contact_id, name, email, created_at) values ($1, 'g1', 'Maria Lopezzi', 'maria.lopezzi@gmail.com', now())`, [ids.alpha]);
  await db.query(
    `insert into payments (client_id, whop_payment_id, customer_name, customer_email, amount, paid_at, product_title)
     values ($1, 'p1', 'Paula Payerson', 'paula@payerson.test', 3500, now(), 'Growth')`, [ids.alpha]);

  ids.exception = await id(
    `insert into exceptions (type, client_id, owner_id, severity, reason, money_at_risk, dedupe_key)
     values ('zero_spend', $1, $2, 'red', '$0 ad spend 24h+', 500, 'zero_spend:alpha') returning id`, [ids.alpha, people.aditya]);
  ids.resolved = await id(
    `insert into exceptions (type, client_id, severity, reason, money_at_risk, dedupe_key, status, resolved_at, resolved_by)
     values ('zero_spend', $1, 'red', 'Old one', 900, 'zero_spend:alpha', 'resolved', now(), 'Ryan') returning id`, [ids.alpha]);
  ids.job = await id(
    `insert into tech_jobs (type, title, client_id, owner_id, requested_at) values ('fix', 'Calendar not syncing', $1, $2, now() - interval '3 days') returning id`,
    [ids.alpha, people.sameer]);
  await db.query(`insert into launches (client_id, paid_at, owner_id) values ($1, now() - interval '3 days', $2)`, [ids.beta, people.sameer]);
  await db.query(`insert into touches (client_id, kind, note, by_id, at) values ($1, 'call', 'Weekly check-in', $2, now() - interval '2 days')`, [ids.alpha, people.ryan]);
  await db.query(`insert into eods (staff_id, date, role, answers) values ($1, app_today(), 'csr', '{"dials": 40}')`, [people.amanda]);
  await db.query(`insert into tasks (owner_id, title, category, source, due) values ($1, 'Fix the calendar', 'tech', 'ryan', app_today() - 2)`, [people.sameer]);
  await db.query(`insert into tasks (owner_id, title, source, status) values ($1, 'Already done', 'ryan', 'done')`, [people.sameer]);
  await db.query(`insert into tasks (owner_id, title, source, deleted_at) values ($1, 'Removed', 'ryan', now())`, [people.sameer]);
  await db.query(
    `insert into prospects (name, contact, heat, stage, follow_up_date, deal_size) values ('Smith Regen', '555-0100 smith@regen.test', 'hot', 'chase', app_today() - 3, 9000)`);
  await db.query(`insert into agency_month (month, snapshot, frozen_at) values ('2026-08-01', '{"cash_collected": 41000}', now())`);
  await db.query(
    `insert into integration_sync_status (source, schedule_minutes, last_attempt_at, last_success_at, status)
     values ('cortana', 15, now(), now(), 'ok')
     on conflict (source) do update set last_attempt_at = now(), last_success_at = now(), status = 'ok'`);
});

describe("mcp_* functions: who may call them", () => {
  it("only service_role can execute them, and none of them deletes", async () => {
    const fns = await db.query<{ name: string; service: boolean; anon: boolean; authed: boolean; open: boolean; body: string }>(
      `select p.proname as name,
         has_function_privilege('service_role', p.oid, 'execute') as service,
         has_function_privilege('anon', p.oid, 'execute') as anon,
         has_function_privilege('authenticated', p.oid, 'execute') as authed,
         exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0) as open,
         p.prosrc as body
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'mcp\\_%'`);
    expect(fns.rows.length).toBeGreaterThanOrEqual(21);
    for (const f of fns.rows) {
      expect(f.service, f.name).toBe(true);
      expect(f.anon, f.name).toBe(false);
      expect(f.authed, f.name).toBe(false);
      expect(f.open, f.name).toBe(false);
      expect(f.body, f.name).not.toMatch(/\bdelete\s+from\b|\btruncate\b|\bdrop\b/i);
      expect(f.name).not.toMatch(/delete|remove/);
    }
    await asUser(db, AUTH.ryan, async () => {
      await expect(db.query(`select mcp_get_prospects()`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`select mcp_add_idea('x', 'claude')`)).rejects.toThrow(/permission denied/);
    });
  });

  it("the service role can read and write through them", async () => {
    await db.exec(`set role service_role;`);
    try {
      const o = await one<{ r: { mrr: { total: number } } }>(`select mcp_get_overview(app_today(), app_today(), app_today() - 1, app_today() - 1) as r`);
      expect(o.r.mrr.total).toBe(5500);
      const c = await one<{ r: unknown[] }>(`select mcp_get_clients() as r`);
      expect(c.r.length).toBe(3);
      const i = await one<{ r: { id: string } }>(`select mcp_add_idea('From the service role', 'system') as r`);
      expect((await audit("ideas", i.r.id)).rows).toMatchObject([{ actor: "claude" }]);
    } finally {
      await db.exec(`reset role;`);
    }
  });
});

describe("write functions: audited as claude", () => {
  it("mcp_write_brief inserts, then replaces the same date and kind", async () => {
    const a = await one<{ r: { id: string; created: boolean } }>(`select mcp_write_brief('2026-10-06', 'daily', '# Tuesday') as r`);
    expect(a.r.created).toBe(true);
    const b = await one<{ r: { id: string; created: boolean; written_by: string } }>(`select mcp_write_brief('2026-10-06', 'daily', '# Tuesday, again') as r`);
    expect(b.r).toMatchObject({ id: a.r.id, created: false, written_by: "claude" });
    const rows = await db.query<{ body_markdown: string; written_by: string }>(`select body_markdown, written_by from briefs where date = '2026-10-06'`);
    expect(rows.rows).toEqual([{ body_markdown: "# Tuesday, again", written_by: "claude" }]);
    const log = await audit("briefs", a.r.id);
    expect(log.rows.map((r) => r.field)).toEqual(["_created", "body_markdown"]);
    expect(log.rows.every((r) => r.actor === "claude")).toBe(true);
    await expect(db.query(`select mcp_write_brief('2026-10-06', 'daily', '  ')`)).rejects.toThrow(/MCP_INVALID/);
  });

  it("the actor does not leak into the next write", async () => {
    const i = await id(`insert into ideas (text) values ('typed by hand') returning id`);
    expect((await audit("ideas", i)).rows[0].actor).toBe("system");
  });

  it("mcp_add_task adds a task, by name or id", async () => {
    const t = await one<{ r: { id: string; owner: string; owner_id: string; source: string } }>(
      `select mcp_add_task('amanda', 'Call back the Tuesday leads', 'call_centre', 'claude', $1, '2026-10-09', 'From the brief') as r`, [ids.alpha]);
    expect(t.r).toMatchObject({ owner: "Amanda Harder", owner_id: people.amanda, source: "claude" });
    const row = await one<{ client_id: string; due: string; notes: string }>(`select client_id, due::text, notes from tasks where id = $1`, [t.r.id]);
    expect(row).toEqual({ client_id: ids.alpha, due: "2026-10-09", notes: "From the brief" });
    expect((await audit("tasks", t.r.id)).rows).toMatchObject([{ field: "_created", actor: "claude" }]);
    const byId = await one<{ r: { owner: string } }>(`select mcp_add_task($1, 'Check the pixel', 'tech', 'slack') as r`, [people.sameer]);
    expect(byId.r.owner).toBe("Sameer");
  });

  it("rule 1: Ryan's list only takes source = pushpin", async () => {
    await expect(db.query(`select mcp_add_task('Ryan', 'Review the weekly numbers', 'general', 'claude')`)).rejects.toThrow(/TASK_OWNER_LIST/);
    await expect(db.query(`select mcp_add_task('Ryan', 'Review the weekly numbers', 'general', 'slack')`)).rejects.toThrow(/TASK_OWNER_LIST/);
    // 'ryan' is the owner's own source in the app; it is not on offer here.
    await expect(db.query(`select mcp_add_task('Ryan', 'Review the weekly numbers', 'general', 'ryan')`)).rejects.toThrow(/MCP_INVALID/);
    const ok = await one<{ r: { source: string } }>(`select mcp_add_task('Ryan', 'Sign the Beta contract', 'general', 'pushpin') as r`);
    expect(ok.r.source).toBe("pushpin");
  });

  it("rule 2: the media buyer's tasks are ads or call_centre", async () => {
    await expect(db.query(`select mcp_add_task('Aditya', 'Rebuild the landing page', 'tech', 'claude')`)).rejects.toThrow(/TASK_CATEGORY/);
    await expect(db.query(`select mcp_add_task('Aditya', 'Tidy the drive', 'general', 'claude')`)).rejects.toThrow(/TASK_CATEGORY/);
    await db.query(`select mcp_add_task('Aditya', 'Pause the fatigued ad at Alpha', 'ads', 'claude')`);
  });

  it("rule 3: a title that matches a task the owner deleted is refused", async () => {
    const t = await id(`insert into tasks (owner_id, title, category, source) values ($1, 'Refresh creatives for Multivita IV', 'ads', 'ryan') returning id`, [people.aditya]);
    await db.query(`update tasks set deleted_at = now() where id = $1`, [t]);
    await expect(db.query(`select mcp_add_task('Aditya', 'Refresh the creatives for Multivita IV', 'ads', 'claude')`)).rejects.toThrow(/TASK_DELETED_MATCH/);
    // The same title on someone else's list is fine.
    await db.query(`select mcp_add_task('Sameer', 'Refresh the creatives for Multivita IV', 'tech', 'claude')`);
    const check = await one<{ r: { owner: { role: string }; deleted_match: { title: string; similarity: number } | null } }>(
      `select mcp_task_check('Aditya', 'Refresh the creatives for Multivita IV') as r`);
    expect(check.r.owner.role).toBe("media_buyer");
    expect(check.r.deleted_match?.title).toBe("Refresh creatives for Multivita IV");
    expect(check.r.deleted_match?.similarity).toBeGreaterThanOrEqual(0.6);
  });

  it("unknown, ambiguous and departed owners are refused by name", async () => {
    await expect(db.query(`select mcp_add_task('Nobody', 'x', 'general', 'claude')`)).rejects.toThrow(/MCP_NOT_FOUND/);
    await db.query(`insert into staff (name, role) values ('Amanda Second', 'csr'), ('Leaver Lee', 'csr')`);
    await db.query(`update staff set status = 'left' where name = 'Leaver Lee'`);
    await expect(db.query(`select mcp_add_task('Amanda', 'x', 'general', 'claude')`)).rejects.toThrow(/MCP_AMBIGUOUS/);
    await expect(db.query(`select mcp_add_task('Leaver', 'x', 'general', 'claude')`)).rejects.toThrow(/MCP_NOT_FOUND/);
    await db.query(`select mcp_add_task('Amanda Harder', 'Full name still works', 'general', 'claude')`);
    await db.query(`update staff set status = 'left' where name = 'Amanda Second'`);
    await expect(db.query(`select mcp_add_task('Sameer', 'x', 'general', 'claude', $1)`, [ids.deleted])).rejects.toThrow(/MCP_NOT_FOUND/);
  });

  it("mcp_add_idea", async () => {
    const r = await one<{ r: { id: string; text: string; source: string } }>(`select mcp_add_idea('  Offer a show-rate guarantee ', 'claude') as r`);
    expect(r.r).toMatchObject({ text: "Offer a show-rate guarantee", source: "claude" });
    expect((await audit("ideas", r.r.id)).rows).toMatchObject([{ field: "_created", actor: "claude" }]);
  });

  it("mcp_upsert_prospect matches on name, writes only what it is given and never touches contact", async () => {
    const before = await one<{ id: string; contact: string }>(`select id, contact from prospects where name = 'Smith Regen'`);
    const r = await one<{ r: { created: boolean; prospect: Record<string, unknown> } }>(
      `select mcp_upsert_prospect('  smith REGEN ', '{"heat": "warm", "objection": "Price", "deal_size": 12000}') as r`);
    expect(r.r.created).toBe(false);
    expect(r.r.prospect).toMatchObject({ id: before.id, name: "Smith Regen", heat: "warm", objection: "Price", deal_size: 12000, stage: "chase" });
    expect(r.r.prospect).not.toHaveProperty("contact");
    const after = await one<{ contact: string; follow_up_date: string | null; n: number }>(
      `select contact, follow_up_date::text, (select count(*)::int from prospects where lower(name) = 'smith regen') as n from prospects where id = $1`, [before.id]);
    expect(after.contact).toBe(before.contact);
    expect(after.follow_up_date).not.toBeNull(); // not given, so left alone
    expect(after.n).toBe(1);
    const log = await audit("prospects", before.id);
    const changed = log.rows.filter((x) => x.actor === "claude").map((x) => x.field).sort();
    expect(changed).toEqual(["deal_size", "heat", "objection"]);

    await expect(db.query(`select mcp_upsert_prospect('Smith Regen', '{"contact": "new@number.test"}')`)).rejects.toThrow(/MCP_INVALID.*contact/);
    expect((await one<{ contact: string }>(`select contact from prospects where id = $1`, [before.id])).contact).toBe(before.contact);

    const made = await one<{ r: { created: boolean; prospect: { id: string; stage: string; heat: string | null } } }>(
      `select mcp_upsert_prospect('Northside Stem Cell', '{"state": "FL", "call_date": "2026-10-05"}') as r`);
    expect(made.r).toMatchObject({ created: true, prospect: { stage: "chase", heat: null } });
    const row = await one<{ contact: string | null; state: string; call_date: string }>(`select contact, state, call_date::text from prospects where id = $1`, [made.r.prospect.id]);
    expect(row).toEqual({ contact: null, state: "FL", call_date: "2026-10-05" });
    expect((await audit("prospects", made.r.prospect.id)).rows).toMatchObject([{ field: "_created", actor: "claude" }]);
  });

  it("mcp_set_next_action", async () => {
    const r = await one<{ r: Record<string, unknown> }>(`select mcp_set_next_action($1, 'Send the October report') as r`, [ids.beta]);
    expect(r.r).toMatchObject({ client_id: ids.beta, client: "Beta Clinic", next_action: "Send the October report" });
    const log = await audit("clients", ids.beta);
    expect(log.rows.filter((x) => x.field === "next_action")).toMatchObject([{ actor: "claude", new_value: "Send the October report" }]);
    await expect(db.query(`select mcp_set_next_action($1, 'x')`, [ids.deleted])).rejects.toThrow(/MCP_NOT_FOUND/);
    await expect(db.query(`select mcp_set_next_action(gen_random_uuid(), 'x')`)).rejects.toThrow(/MCP_NOT_FOUND/);
  });

  it("mcp_log_touch logs the touch and moves last contact, both as claude", async () => {
    const r = await one<{ r: { id: string; kind: string; last_contact_us: string } }>(`select mcp_log_touch($1, 'loom', 'Sent the launch walkthrough') as r`, [ids.beta]);
    expect(r.r.kind).toBe("loom");
    expect(r.r.last_contact_us).not.toBeNull();
    expect((await audit("touches", r.r.id)).rows).toMatchObject([{ field: "_created", actor: "claude" }]);
    const log = await audit("clients", ids.beta);
    expect(log.rows.filter((x) => x.field === "last_contact_us")).toMatchObject([{ actor: "claude" }]);
    await expect(db.query(`select mcp_log_touch($1, 'loom', ' ')`, [ids.beta])).rejects.toThrow(/MCP_INVALID/);
  });

  it("mcp_set_exception_action", async () => {
    const r = await one<{ r: Record<string, unknown> }>(`select mcp_set_exception_action($1, 'Asked Aditya to check billing') as r`, [ids.exception]);
    expect(r.r).toMatchObject({ id: ids.exception, status: "open", action_taken: "Asked Aditya to check billing" });
    const log = await audit("exceptions", ids.exception);
    expect(log.rows.filter((x) => x.field === "action_taken")).toMatchObject([{ actor: "claude" }]);
    await expect(db.query(`select mcp_set_exception_action(gen_random_uuid(), 'x')`)).rejects.toThrow(/MCP_NOT_FOUND/);
  });
});

describe("read tools, through the handlers", () => {
  it("get_overview: the period, the one before, MRR, exceptions and stages", async () => {
    const { out, isError } = await run("get_overview", { period: "today" });
    expect(isError).toBeUndefined();
    const o = out as unknown as {
      period: Record<string, string>; current: Record<string, number | null>; previous: Record<string, number | null>;
      mrr: Record<string, number | null>; exceptions: Record<string, number | null>; clients_by_stage: Record<string, number>;
      sources: { source: string; freshness: string }[]; history: Record<string, string | null>;
    };
    expect(o.period).toMatchObject({ key: "today", from: today, to: today });
    expect(o.current).toMatchObject({ ad_spend: 100, leads: 2, booked: 1, shows: 0, cash_collected: 3500, expenses: null, bank_revenue: null });
    expect(o.previous).toMatchObject({ ad_spend: 50, leads: 0, expenses: null });
    // Alpha is priced from its Whop plan (3,500), Beta from its record (6,000 / 3).
    expect(o.mrr).toMatchObject({ total: 5500, clients: 2, priced_from_whop: 1 });
    expect(o.exceptions).toEqual({ open: 1, money_at_risk: 500 });
    expect(o.clients_by_stage).toEqual({ live: 1, onboarding: 1, churned: 1 });
    expect(o.sources.find((s) => s.source === "cortana")?.freshness).toBe("fresh");
    expect(o.history.ad_spend_from).not.toBeNull();
    // Default period is the month to date.
    expect((await run("get_overview")).out).toMatchObject({ period: { key: "month", to: today } });
  });

  it("get_clients: every live record with fee, health, renewal and this month's numbers", async () => {
    const { out } = await run("get_clients");
    const clients = (out as unknown as { clients: Record<string, unknown>[] }).clients;
    expect(clients.map((c) => c.name)).toEqual(["Alpha Clinic", "Beta Clinic", "Gone Clinic"]); // churned last, deleted gone
    const alpha = clients[0] as { fee: Record<string, unknown>; health: Record<string, unknown>; renewal: Record<string, unknown>; this_month: Record<string, unknown> };
    expect(alpha).toMatchObject({ id: ids.alpha, stage: "live", pod: "pod_1", cortana_connected: true, ads_unverified: false });
    expect(alpha.fee).toEqual({ monthly_fee: 3500, source: "whop" });
    expect(alpha.health.colour).toMatch(/^(green|amber|red)$/);
    expect(alpha.renewal).toMatchObject({ source: "whop", amount: 3500, status: "upcoming" });
    expect(alpha.this_month).toMatchObject({ leads: 2, booked: 1, shows: 0, revenue: null });
    expect(alpha).not.toHaveProperty("contact_name");
    const beta = clients[1] as Record<string, unknown>;
    expect(beta.fee).toEqual({ monthly_fee: 2000, source: "record" });
    expect(beta.this_month).toBeNull(); // nothing recorded this month: null, not zeros
    expect(beta).toMatchObject({ cortana_connected: false, next_action: "Send the October report" });
    expect(clients[2]).toMatchObject({ stage: "churned", fee: null, health: null, renewal: null });
  });

  it("get_client: the same plus open exceptions, tech jobs and touches", async () => {
    const { out } = await run("get_client", { id: ids.alpha });
    const c = out as unknown as { name: string; open_exceptions: Record<string, unknown>[]; tech_jobs: Record<string, unknown>[]; recent_touches: Record<string, unknown>[] };
    expect(c.name).toBe("Alpha Clinic");
    expect(c.open_exceptions).toMatchObject([{ id: ids.exception, money_at_risk: 500, owner: "Aditya", action_taken: "Asked Aditya to check billing" }]);
    expect(c.tech_jobs).toMatchObject([{ id: ids.job, type: "fix", is_overdue: true, met_sla: null }]);
    expect(c.recent_touches).toMatchObject([{ kind: "call", by: "Ryan", note: "Weekly check-in" }]);
    const missing = await run("get_client", { id: ids.deleted });
    expect(missing.isError).toBe(true);
    expect(missing.out).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("get_ad_metrics: account numbers for the window, ads at 7d and all time", async () => {
    const d7 = (await run("get_ad_metrics", { client_id: ids.alpha, window: "7d" })).out as unknown as { window: string; account: Record<string, unknown>; ads: Record<string, unknown>[] };
    expect(d7.window).toBe("7d");
    expect(d7.account).toMatchObject({ name: "Alpha Clinic", days_live: 40, spend: 50, spend_7d: 50, booked_7d: 0, cost_per_booked_7d: null, verdict: null });
    expect(typeof d7.account.sop_stage).toBe("string");
    expect(d7.ads).toMatchObject([{ ad_id: "ad1", ad_name: "Knee pain video", spend_7d: 140, booked_7d: 2, cost_per_booked_7d: 70, spend_all: 900, cost_per_booked_all: 75 }]);
    const all = (await run("get_ad_metrics", { client_id: ids.alpha, window: "all" })).out as unknown as { account: Record<string, unknown> };
    expect(all.account).toMatchObject({ spend: 150, leads: 2, booked: 1, cost_per_booked: 150 });
    const none = (await run("get_ad_metrics", { client_id: ids.beta, window: "3d" })).out as unknown as { account: unknown; ads: unknown[]; note: string };
    expect(none.account).toBeNull();
    expect(none.ads).toEqual([]);
    expect(none.note).toMatch(/Cortana/);
  });

  it("get_exceptions: open by default, with the total at risk", async () => {
    const open = (await run("get_exceptions")).out as unknown as { status: string; count: number; money_at_risk: number; exceptions: Record<string, unknown>[] };
    expect(open).toMatchObject({ status: "open", count: 1, money_at_risk: 500 });
    expect(open.exceptions).toMatchObject([{ id: ids.exception, client: "Alpha Clinic", owner: "Aditya", severity: "red" }]);
    const resolved = (await run("get_exceptions", { status: "resolved" })).out as unknown as { count: number; exceptions: Record<string, unknown>[] };
    expect(resolved.exceptions).toMatchObject([{ id: ids.resolved, resolved_by: "Ryan" }]);
    expect((await run("get_exceptions", { status: "snoozed" })).out).toMatchObject({ count: 0, money_at_risk: null, exceptions: [] });
  });

  it("get_tech_jobs: SLA figures from the board", async () => {
    const open = (await run("get_tech_jobs")).out as unknown as { status: string; jobs: Record<string, unknown>[] };
    expect(open.status).toBe("not_done");
    expect(open.jobs).toMatchObject([{ id: ids.job, title: "Calendar not syncing", client: "Alpha Clinic", owner: "Sameer", status: "todo", sla_minutes: 30, is_overdue: true, is_paused: false }]);
    expect(open.jobs[0].genexa_minutes).toBeGreaterThan(30);
    expect((await run("get_tech_jobs", { status: "done" })).out).toMatchObject({ status: "done", jobs: [] });
  });

  it("get_launches: the board", async () => {
    const { launches } = (await run("get_launches")).out as unknown as { launches: Record<string, unknown>[] };
    expect(launches).toMatchObject([{ client_name: "Beta Clinic", owner_name: "Sameer", stage: "paid", days_waiting: 3, clock_started: false, sla_hours_elapsed: null, qc_done: 0 }]);
  });

  it("get_call_centre: not available, and nothing else", async () => {
    const { out, isError } = await run("get_call_centre", { window: "7d" });
    expect(isError).toBeUndefined();
    expect(out).toEqual({ status: "not_available", reason: "Call centre moves to Hot Prospector — not set up yet." });
  });

  it("get_scores: the week's scorecard rows with names", async () => {
    const monday = (await one<{ d: string }>(`select app_week_start(app_today())::text as d`)).d;
    const now = (await run("get_scores")).out as unknown as { week_start: string; scores: { name: string; metric: string; staff_id: string }[] };
    expect(now.week_start).toBe(monday);
    const expected = await one<{ n: number }>(`select count(*)::int as n from person_scores_weekly where week_start = $1`, [monday]);
    expect(now.scores.length).toBe(expected.n);
    expect(now.scores.length).toBeGreaterThan(0);
    expect(now.scores.every((s) => typeof s.name === "string" && typeof s.metric === "string")).toBe(true);
    const same = (await run("get_scores", { week: monday })).out as unknown as { scores: unknown[] };
    expect(same.scores.length).toBe(expected.n);
  });

  it("get_eods: rows in the range with the person's name", async () => {
    const { eods } = (await run("get_eods", { from: today, to: today })).out as unknown as { eods: Record<string, unknown>[] };
    expect(eods).toMatchObject([{ name: "Amanda Harder", date: today, role: "csr", answers: { dials: 40 } }]);
    expect(((await run("get_eods", { from: "2026-01-01", to: "2026-01-31" })).out as unknown as { eods: unknown[] }).eods).toEqual([]);
  });

  it("get_tasks: open tasks grouped by owner", async () => {
    const all = (await run("get_tasks")).out as unknown as { owners: { owner: string; overdue_tasks: number; tasks: { title: string; days_overdue: number | null }[] }[] };
    const sameer = all.owners.find((o) => o.owner === "Sameer");
    expect(sameer?.tasks.map((t) => t.title)).toContain("Fix the calendar");
    expect(sameer?.tasks.map((t) => t.title)).not.toContain("Already done");
    expect(sameer?.tasks.map((t) => t.title)).not.toContain("Removed");
    expect(sameer?.tasks.find((t) => t.title === "Fix the calendar")?.days_overdue).toBe(2);
    expect(sameer?.overdue_tasks).toBe(1);
    expect(all.owners.every((o) => o.tasks.length > 0)).toBe(true);
    const mine = (await run("get_tasks", { owner: "marjorie" })).out as unknown as { owners: { owner: string; tasks: unknown[] }[] };
    expect(mine.owners).toMatchObject([{ owner: "Marjorie Grace Villarino", tasks: [] }]);
    const nobody = await run("get_tasks", { owner: "Nobody" });
    expect(nobody.isError).toBe(true);
    expect(nobody.out).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("get_prospects: no contact details", async () => {
    const { prospects } = (await run("get_prospects")).out as unknown as { prospects: Record<string, unknown>[] };
    const smith = prospects.find((p) => p.name === "Smith Regen");
    expect(smith).toMatchObject({ heat: "warm", stage: "chase", deal_size: 12000, follow_up_days_overdue: 3 });
    for (const p of prospects) expect(p).not.toHaveProperty("contact");
    expect(JSON.stringify(prospects)).not.toMatch(/555-0100|smith@regen/);
  });

  it("get_agency_month: the frozen snapshot, else live figures flagged frozen: false", async () => {
    expect((await run("get_agency_month", { month: "2026-08" })).out).toMatchObject({ month: "2026-08", frozen: true, snapshot: { cash_collected: 41000 } });
    const live = (await run("get_agency_month", { month: today.slice(0, 7) })).out as unknown as { frozen: boolean; from: string; to: string; figures: Record<string, number | null>; mrr: number };
    expect(live).toMatchObject({ frozen: false, from: `${today.slice(0, 8)}01`, to: today, mrr: 5500 });
    expect(live.figures).toMatchObject({ leads: 2, booked: 1, cash_collected: 3500, expenses: null });
    expect(live.figures.ad_spend).toBeGreaterThanOrEqual(100);
    // An unfrozen row is not a snapshot.
    await db.query(`insert into agency_month (month, snapshot) values ('2026-09-01', '{"draft": true}')`);
    expect((await run("get_agency_month", { month: "2026-09" })).out).toMatchObject({ frozen: false, from: "2026-09-01", to: "2026-09-30" });
    const future = await run("get_agency_month", { month: "2099-01" });
    expect(future.isError).toBe(true);
  });

  it("get_sync_status: source freshness", async () => {
    const { sources } = (await run("get_sync_status")).out as unknown as { sources: Record<string, unknown>[] };
    expect(sources.find((s) => s.source === "cortana")).toMatchObject({ freshness: "fresh", is_stale: false });
  });

  it("no read tool returns a patient surname, a payer, a phone number or an email", async () => {
    const args: Record<string, Record<string, unknown>> = {
      get_client: { id: ids.alpha }, get_ad_metrics: { client_id: ids.alpha, window: "all" },
      get_eods: { from: today, to: today }, get_agency_month: { month: today.slice(0, 7) },
    };
    for (const tool of TOOLS.filter((t) => t.readOnly)) {
      const { content, isError } = await run(tool.name, args[tool.name] ?? {});
      expect(isError, tool.name).toBeUndefined();
      expect(content[0].text, tool.name).not.toMatch(/Lopezzi|Payerson|Contactson|555-0100|@/);
    }
  });
});

describe("write tools, through the handlers", () => {
  it("write_brief, add_idea, set_next_action, log_touch, set_exception_action", async () => {
    expect((await run("write_brief", { date: "2026-10-07", kind: "weekly", markdown: "# Week 41" })).out).toMatchObject({ created: true, kind: "weekly", written_by: "claude" });
    expect((await run("add_idea", { text: "Clinic referral scheme", source: "call" })).out).toMatchObject({ text: "Clinic referral scheme", source: "call" });
    expect((await run("set_next_action", { client_id: ids.alpha, text: "Renewal call Friday" })).out).toMatchObject({ client: "Alpha Clinic", next_action: "Renewal call Friday" });
    expect((await run("log_touch", { client_id: ids.alpha, kind: "email", note: "Sent the weekly report" })).out).toMatchObject({ kind: "email", client_id: ids.alpha });
    expect((await run("set_exception_action", { id: ids.exception, text: "Card updated" })).out).toMatchObject({ action_taken: "Card updated" });
    const gone = await run("set_next_action", { client_id: ids.deleted, text: "x" });
    expect(gone.isError).toBe(true);
    expect(gone.out).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("upsert_prospect sends only the listed fields", async () => {
    const r = (await run("upsert_prospect", { name: "smith regen", stage: "contract_out", follow_up_date: "2026-10-12" })).out as unknown as { created: boolean; prospect: Record<string, unknown> };
    expect(r.created).toBe(false);
    expect(r.prospect).toMatchObject({ stage: "contract_out", follow_up_date: "2026-10-12", heat: "warm" });
    expect(r.prospect).not.toHaveProperty("contact");
    expect((await one<{ contact: string }>(`select contact from prospects where name = 'Smith Regen'`)).contact).toBe("555-0100 smith@regen.test");
  });

  it("add_task adds a task", async () => {
    const before = await one<{ n: number }>(`select count(*)::int as n from tasks`);
    const r = await run("add_task", { owner: "Sameer", title: "Reconnect the Alpha pixel", category: "tech", source: "claude", client_id: ids.alpha, due: "2026-10-10" });
    expect(r.isError).toBeUndefined();
    expect(r.out).toMatchObject({ owner: "Sameer", title: "Reconnect the Alpha pixel", client_id: ids.alpha, due: "2026-10-10", source: "claude" });
    expect((await one<{ n: number }>(`select count(*)::int as n from tasks`)).n).toBe(before.n + 1);
  });

  it("add_task refuses each rule in the endpoint, naming it, and writes nothing", async () => {
    const before = await one<{ n: number }>(`select count(*)::int as n from tasks`);
    const cases: [Record<string, unknown>, string][] = [
      [{ owner: "Ryan", title: "Look at churn", category: "general", source: "claude" }, "TASK_OWNER_LIST"],
      [{ owner: "Aditya", title: "Fix the booking form", category: "tech", source: "claude" }, "TASK_CATEGORY"],
      [{ owner: "Aditya", title: "Refresh the creatives for Multivita IV", category: "ads", source: "system" }, "TASK_DELETED_MATCH"],
    ];
    for (const [args, code] of cases) {
      const r = await run("add_task", args);
      expect(r.isError, code).toBe(true);
      const error = (r.out as unknown as { error: Record<string, unknown> }).error;
      expect(error).toMatchObject({ code, enforced_by: "endpoint" });
      expect(typeof error.rule).toBe("string");
      expect(typeof error.message).toBe("string");
    }
    expect((await one<{ n: number }>(`select count(*)::int as n from tasks`)).n).toBe(before.n);
    expect((await run("add_task", { owner: "Ryan", title: "Call the bank", category: "general", source: "pushpin" })).isError).toBeUndefined();
  });

  it("add_task: if the endpoint's check were skipped, the database still refuses and the error is the same shape", async () => {
    // A data layer whose pre-check sees nothing wrong: only the trigger stands in the way.
    const blind: McpData = {
      async call(fn, args) {
        if (fn !== "mcp_task_check") return data.call(fn, args);
        const real = (await data.call(fn, args)) as { owner: Record<string, unknown> };
        return { owner: { ...real.owner, role: "csr" }, deleted_match: null };
      },
    };
    const before = await one<{ n: number }>(`select count(*)::int as n from tasks`);
    const cases: [Record<string, unknown>, string][] = [
      [{ owner: "Ryan", title: "Look at churn", category: "general", source: "claude" }, "TASK_OWNER_LIST"],
      [{ owner: "Aditya", title: "Fix the booking form", category: "tech", source: "claude" }, "TASK_CATEGORY"],
      [{ owner: "Aditya", title: "Refresh the creatives for Multivita IV", category: "ads", source: "system" }, "TASK_DELETED_MATCH"],
    ];
    for (const [args, code] of cases) {
      const r = await run("add_task", args, blind);
      expect(r.isError, code).toBe(true);
      expect((r.out as unknown as { error: Record<string, unknown> }).error).toMatchObject({ code, enforced_by: "database" });
    }
    expect((await one<{ n: number }>(`select count(*)::int as n from tasks`)).n).toBe(before.n);
  });
});
