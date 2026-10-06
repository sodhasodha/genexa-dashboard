import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshDb, seedStaff, type TestPeople } from "./db";

let db: PGlite;
let people: TestPeople;
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];

beforeAll(async () => {
  db = await freshDb();
  people = await seedStaff(db);
});

describe("no hard deletes + audit log", () => {
  it("rejects DELETE on every table", async () => {
    const tables = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    for (const { table_name } of tables.rows) {
      const hasTrigger = await one<{ n: number }>(
        `select count(*)::int as n from pg_trigger where tgrelid = $1::regclass and tgname = $2`,
        [table_name, `${table_name}_forbid_delete`],
      );
      expect(hasTrigger.n, table_name).toBe(1);
    }
    await db.query(`insert into ideas (text) values ('x')`);
    await expect(db.query(`delete from ideas`)).rejects.toThrow(/Hard deletes are not allowed/);
  });

  it("writes one audit row per changed field", async () => {
    const c = await one<{ id: string }>(`insert into clients (name, monthly_fee) values ('Audit Clinic', 3000) returning id`);
    await db.query(`update clients set monthly_fee = 3500, next_action = 'Call Friday' where id = $1`, [c.id]);
    const rows = await db.query<{ field: string; old_value: string | null; new_value: string | null; actor: string }>(
      `select field, old_value, new_value, actor from audit_log where table_name = 'clients' and row_id = $1 order by field`,
      [c.id],
    );
    const byField = Object.fromEntries(rows.rows.map((r) => [r.field, r]));
    expect(Object.keys(byField).sort()).toEqual(["_created", "monthly_fee", "next_action"]);
    expect(Number(byField.monthly_fee.old_value)).toBe(3000);
    expect(Number(byField.monthly_fee.new_value)).toBe(3500);
    expect(byField.next_action.new_value).toBe("Call Friday");
    expect(byField.monthly_fee.actor).toBe("system");
  });

  it("records the actor set by the server (e.g. claude)", async () => {
    await db.exec(`begin; select set_config('app.actor', 'claude', true); insert into ideas (text, source) values ('idea', 'claude'); commit;`);
    const r = await one<{ actor: string }>(`select actor from audit_log where table_name = 'ideas' order by at desc limit 1`);
    expect(r.actor).toBe("claude");
  });
});

describe("task rules", () => {
  it("only Ryan's own entries or pushpin can land on Ryan's list", async () => {
    await db.query(`insert into tasks (owner_id, title, source) values ($1, 'Ryan task', 'ryan')`, [people.ryan]);
    await db.query(`insert into tasks (owner_id, title, source) values ($1, 'Pushpin task', 'pushpin')`, [people.ryan]);
    await expect(
      db.query(`insert into tasks (owner_id, title, source) values ($1, 'Claude task', 'claude')`, [people.ryan]),
    ).rejects.toThrow(/TASK_OWNER_LIST/);
  });

  it("the media buyer's tasks must be ads or call_centre", async () => {
    await db.query(`insert into tasks (owner_id, title, category, source) values ($1, 'Scale Pivotal', 'ads', 'ryan')`, [people.aditya]);
    await expect(
      db.query(`insert into tasks (owner_id, title, category, source) values ($1, 'Fix the form', 'tech', 'ryan')`, [people.aditya]),
    ).rejects.toThrow(/TASK_CATEGORY/);
  });

  it("deleting soft-deletes and blocks automated re-creates that fuzzy-match", async () => {
    const t = await one<{ id: string }>(
      `insert into tasks (owner_id, title, category, source) values ($1, 'Refresh creatives for Multivita IV', 'ads', 'ryan') returning id`,
      [people.aditya],
    );
    await db.query(`update tasks set deleted_at = now() where id = $1`, [t.id]);
    const d = await one<{ n: number }>(`select count(*)::int as n from deleted_tasks where owner_id = $1`, [people.aditya]);
    expect(d.n).toBe(1);
    await expect(
      db.query(`insert into tasks (owner_id, title, category, source) values ($1, 'Refresh the creatives for Multivita IV', 'ads', 'claude')`, [people.aditya]),
    ).rejects.toThrow(/TASK_DELETED_MATCH/);
    // A human can still re-add it, and unrelated automated tasks pass.
    await db.query(`insert into tasks (owner_id, title, category, source) values ($1, 'Refresh creatives for Multivita IV', 'ads', 'ryan')`, [people.aditya]);
    await db.query(`insert into tasks (owner_id, title, category, source) values ($1, 'Coach Amanda on confirmations', 'call_centre', 'claude')`, [people.aditya]);
  });

  it("marking done stamps done_at and moves the task to Done", async () => {
    const t = await one<{ id: string }>(`insert into tasks (owner_id, title, source) values ($1, 'Do thing', 'ryan') returning id`, [people.sameer]);
    const r = await one<{ done_at: string | null; task_group: string }>(
      `update tasks set status = 'done' where id = $1 returning done_at, task_group`,
      [t.id],
    );
    expect(r.done_at).not.toBeNull();
    expect(r.task_group).toBe("done");
  });
});

describe("launch QC gate", () => {
  it("refuses Live until all six QC boxes are ticked", async () => {
    const c = await one<{ id: string }>(`insert into clients (name) values ('QC Clinic') returning id`);
    const l = await one<{ id: string }>(`insert into launches (client_id, paid_at) values ($1, now()) returning id`, [c.id]);
    await db.query(
      `update launches set qc_lead_access = true, qc_calendar_tested = true, qc_test_lead_deleted = true,
         qc_pixel_firing = true, qc_cortana_connected = true where id = $1`,
      [l.id],
    );
    await expect(db.query(`update launches set live_at = now() where id = $1`, [l.id])).rejects.toThrow(/LAUNCH_QC/);
    await db.query(`update launches set qc_clinic_sheet = true, qc_passed_at = now(), live_at = now() where id = $1`, [l.id]);
  });
});

describe("test-lead filter", () => {
  it("flags whole-word test names, ZZ names and staff; leaves real patients (incl. Testa) alone", async () => {
    const c = await one<{ id: string }>(`insert into clients (name) values ('Lead Clinic') returning id`);
    const names: [string, string | null, boolean][] = [
      ["Test Lead", null, true],
      ["ZZ Sameer", null, true],
      ["Amanda Harder", null, true],
      ["John Smith", "sameer@example.test", true],
      ["John Smith", "qa+test@clinic.com", true],
      ["zztest", null, true],
      ["Jane Doe", "test@gmail.com", true],
      ["Jane Doe", "ryan@genexascaling.com", true],
      ["Maria Lopez", "maria.lopez@gmail.com", false],
      ["Maria Testa", "mtesta@gmail.com", false],
      ["Tom Contestabile", "contestabile.t@yahoo.com", false],
      ["Lizzy Greatest", "latest.lizzy@gmail.com", false],
    ];
    for (const [i, [name, email, expected]] of names.entries()) {
      const r = await one<{ is_test: boolean }>(
        `insert into leads (client_id, ghl_contact_id, name, email, created_at) values ($1, $2, $3, $4, now()) returning is_test`,
        [c.id, `c${i}`, name, email],
      );
      expect(r.is_test, `${name} / ${email}`).toBe(expected);
    }
    const perf = await one<{ leads: string }>(`select sum(leads) as leads from client_performance_daily where client_id = $1`, [c.id]);
    expect(Number(perf.leads)).toBe(4);
  });
});

describe("sale outcome implies attendance", () => {
  it("not closed (or any close decision) moves the appointment to showed; open leaves it alone", async () => {
    const c = (await one<{ id: string }>(`insert into clients (name, stage) values ('Outcome Clinic', 'live') returning id`)).id;
    const appt = async (attendance: string) =>
      (await one<{ id: string }>(`insert into appointments (client_id, scheduled_for, attendance) values ($1, now() - interval '1 hour', $2) returning id`, [c, attendance])).id;
    const att = async (id: string) => (await one<{ attendance: string }>(`select attendance from appointments where id = $1`, [id])).attendance;

    const pending = await appt("scheduled");
    await db.query(`insert into sales (appointment_id, client_id, close_status) values ($1, $2, 'closed_lost')`, [pending, c]);
    expect(await att(pending)).toBe("showed");

    const noShow = await appt("no_show");
    await db.query(`insert into sales (appointment_id, client_id) values ($1, $2)`, [noShow, c]);
    expect(await att(noShow)).toBe("no_show");
    await db.query(`update sales set close_status = 'closed_lost' where appointment_id = $1`, [noShow]);
    expect(await att(noShow)).toBe("showed");
    const m = await one<{ attendance_logged_by: string; attendance_logged_at: string | null }>(`select attendance_logged_by, attendance_logged_at from appointments where id = $1`, [noShow]);
    expect(m.attendance_logged_by).toBe("clinic");
    expect(m.attendance_logged_at).not.toBeNull();
  });
});

describe("unclassified payments", () => {
  it("a payment with no product title is unclassified", async () => {
    await db.query(
      `insert into payments (whop_payment_id, amount, paid_at, product_title) values ('p1', 3000, now(), 'Growth Plan'), ('p2', 500, now(), null), ('p3', 500, now(), '  ')`,
    );
    const r = await db.query<{ whop_payment_id: string; classified: boolean }>(`select whop_payment_id, classified from payments order by 1`);
    expect(r.rows.map((x) => x.classified)).toEqual([true, false, false]);
  });
});

describe("exceptions dedupe", () => {
  it("is unique while open and can reopen after resolve", async () => {
    await db.query(`insert into exceptions (type, severity, reason, dedupe_key) values ('zero_spend', 'red', 'r', 'zero_spend:c1')`);
    await expect(
      db.query(`insert into exceptions (type, severity, reason, dedupe_key) values ('zero_spend', 'red', 'r', 'zero_spend:c1')`),
    ).rejects.toThrow();
    await db.query(`update exceptions set status = 'resolved', resolved_at = now() where dedupe_key = 'zero_spend:c1'`);
    await db.query(`insert into exceptions (type, severity, reason, dedupe_key) values ('zero_spend', 'red', 'r', 'zero_spend:c1')`);
  });
});
