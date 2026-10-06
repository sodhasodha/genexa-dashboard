import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { AUTH, asAnon, asUser, freshDb, seedStaff, type TestPeople } from "./db";

let db: PGlite;
let people: TestPeople;
let clientId: string;
let amandaTask: string;
let sameerJob: string;

const count = async (table: string) =>
  (await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0].n;

beforeAll(async () => {
  db = await freshDb();
  people = await seedStaff(db);
  await db.query(`insert into staff_pay (staff_id, hourly_rate, weekly_pay) values ($1, 6, 240)`, [people.amanda]);
  await db.query(`insert into finance_transactions (mercury_id, amount, counterparty) values ('m1', 5000, 'Whop')`);
  clientId = (await db.query<{ id: string }>(`insert into clients (name, monthly_fee) values ('RLS Clinic', 3000) returning id`)).rows[0].id;
  amandaTask = (
    await db.query<{ id: string }>(`insert into tasks (owner_id, title, source) values ($1, 'Call back patient', 'ryan') returning id`, [people.amanda])
  ).rows[0].id;
  sameerJob = (
    await db.query<{ id: string }>(`insert into tech_jobs (type, title, owner_id) values ('fix', 'Fix calendar', $1) returning id`, [people.sameer])
  ).rows[0].id;
  await db.query(`insert into agency_month (month, snapshot) values ('2026-09-01', '{"profit": 1}')`);
});

describe("owner", () => {
  it("reads pay, finance and audit, and can edit a client", async () => {
    await asUser(db, AUTH.ryan, async () => {
      expect(await count("staff_pay")).toBe(1);
      expect(await count("finance_transactions")).toBe(1);
      expect(await count("audit_log")).toBeGreaterThan(0);
      expect(await count("agency_month")).toBe(1);
      const r = await db.query(`update clients set next_action = 'Renewal call' where id = $1 returning id`, [clientId]);
      expect(r.rows.length).toBe(1);
    });
    const audit = await db.query<{ actor: string }>(
      `select actor from audit_log where table_name = 'clients' and field = 'next_action' and row_id = $1`,
      [clientId],
    );
    expect(audit.rows[0].actor).toBe("Ryan");
  });
});

describe.each([
  ["media buyer", "aditya"],
  ["tech", "sameer"],
  ["csr", "amanda"],
] as const)("%s", (_label, who) => {
  it("reads operational data but not pay, finance, audit or agency month", async () => {
    await asUser(db, AUTH[who], async () => {
      expect(await count("clients")).toBe(1);
      expect(await count("staff")).toBe(5);
      expect(await count("tech_jobs")).toBeGreaterThanOrEqual(1);
      expect(await count("scoring_config")).toBeGreaterThan(10);
      expect(await count("staff_pay")).toBe(0);
      expect(await count("finance_transactions")).toBe(0);
      expect(await count("finance_rules")).toBe(0);
      expect(await count("audit_log")).toBe(0);
      expect(await count("agency_month")).toBe(0);
    });
  });

  it("cannot edit clients, staff or scoring rules", async () => {
    await asUser(db, AUTH[who], async () => {
      for (const sql of [
        `update clients set monthly_fee = 1 returning id`,
        `update staff set role = 'owner' returning id`,
        `update scoring_config set green = 0 returning id`,
      ]) {
        expect((await db.query(sql)).rows.length, sql).toBe(0);
      }
      await expect(db.query(`insert into clients (name) values ('Sneaky')`)).rejects.toThrow(/row-level security/);
      await expect(db.query(`insert into staff_pay (staff_id, weekly_pay) values ($1, 9999)`, [people[who]])).rejects.toThrow(
        /row-level security/,
      );
    });
  });

  it("can request tech work as themselves only", async () => {
    await asUser(db, AUTH[who], async () => {
      const r = await db.query<{ requested_by: string }>(
        `insert into tech_jobs (type, title, owner_id) values ('fix', 'Request from ${who}', $1) returning requested_by`,
        [people.sameer],
      );
      expect(r.rows[0].requested_by).toBe(people[who]);
      await expect(
        db.query(`insert into tech_jobs (type, title, requested_by) values ('fix', 'Forged', $1)`, [people.ryan]),
      ).rejects.toThrow(/row-level security/);
    });
  });
});

describe("staff writes", () => {
  it("a CSR files their own EOD for today, not someone else's and not yesterday's", async () => {
    await asUser(db, AUTH.amanda, async () => {
      await db.query(
        `insert into eods (staff_id, date, answers) values ($1, (now() at time zone 'America/New_York')::date, '{"focus": 4}')`,
        [people.amanda],
      );
      await expect(
        db.query(`insert into eods (staff_id, date) values ($1, (now() at time zone 'America/New_York')::date)`, [people.marjorie]),
      ).rejects.toThrow(/row-level security|EOD_OWN/);
      await expect(
        db.query(`insert into eods (staff_id, date) values ($1, (now() at time zone 'America/New_York')::date - 1)`, [people.amanda]),
      ).rejects.toThrow(/EOD_CLOSED/);
      // Editable the same day.
      const r = await db.query(`update eods set answers = '{"focus": 5}' where staff_id = $1 returning id`, [people.amanda]);
      expect(r.rows.length).toBe(1);
    });
    const role = await db.query<{ role: string }>(`select role from eods where staff_id = $1`, [people.amanda]);
    expect(role.rows[0].role).toBe("csr");
  });

  it("a CSR changes the status of their own task, nothing else, and nobody else's task", async () => {
    await asUser(db, AUTH.amanda, async () => {
      const ok = await db.query(`update tasks set status = 'doing' where id = $1 returning id`, [amandaTask]);
      expect(ok.rows.length).toBe(1);
      await expect(db.query(`update tasks set title = 'Easier task' where id = $1`, [amandaTask])).rejects.toThrow(/TASK_STATUS_ONLY/);
      await expect(db.query(`update tasks set deleted_at = now() where id = $1`, [amandaTask])).rejects.toThrow(/TASK_STATUS_ONLY/);
    });
    await asUser(db, AUTH.marjorie, async () => {
      const r = await db.query(`update tasks set status = 'done' where id = $1 returning id`, [amandaTask]);
      expect(r.rows.length).toBe(0);
    });
  });

  it("a CSR cannot add to Ryan's list", async () => {
    await asUser(db, AUTH.amanda, async () => {
      await expect(
        db.query(`insert into tasks (owner_id, title, source) values ($1, 'Pay me more', 'ryan')`, [people.ryan]),
      ).rejects.toThrow(/TASK_OWNER_LIST/);
    });
  });

  it("only the job's owner can work or pause a tech job, and a pause needs evidence", async () => {
    await asUser(db, AUTH.amanda, async () => {
      const r = await db.query(`update tech_jobs set status = 'done' where id = $1 returning id`, [sameerJob]);
      expect(r.rows.length).toBe(0);
      await expect(
        db.query(
          `insert into sla_pauses (tech_job_id, reason, evidence_note, paused_by) values ($1, 'client_access', 'pls', $2)`,
          [sameerJob, people.amanda],
        ),
      ).rejects.toThrow(/row-level security/);
    });
    await asUser(db, AUTH.sameer, async () => {
      await db.query(
        `insert into sla_pauses (tech_job_id, reason, evidence_note, paused_by) values ($1, 'client_access', 'Slack msg 14:02', $2)`,
        [sameerJob, people.sameer],
      );
      const r = await db.query(`update tech_jobs set status = 'working' where id = $1 returning id`, [sameerJob]);
      expect(r.rows.length).toBe(1);
    });
  });

  it("an exception can be actioned by its owner or the owning pod, not by others", async () => {
    await db.query(
      `insert into exceptions (type, severity, reason, dedupe_key, owner_id) values ('zero_spend', 'red', 'r', 'k1', $1)`,
      [people.aditya],
    );
    await db.query(
      `insert into exceptions (type, severity, reason, dedupe_key, owner_pod) values ('lead_not_called', 'red', 'r', 'k2', 'pod_2')`,
    );
    await asUser(db, AUTH.aditya, async () => {
      expect((await db.query(`update exceptions set action_taken = 'Raised budget' where dedupe_key = 'k1' returning id`)).rows.length).toBe(1);
      expect((await db.query(`update exceptions set action_taken = 'x' where dedupe_key = 'k2' returning id`)).rows.length).toBe(0);
    });
    await asUser(db, AUTH.amanda, async () => {
      expect((await db.query(`update exceptions set action_taken = 'Called' where dedupe_key = 'k2' returning id`)).rows.length).toBe(1);
    });
    await asUser(db, AUTH.marjorie, async () => {
      expect((await db.query(`update exceptions set action_taken = 'x' where dedupe_key = 'k2' returning id`)).rows.length).toBe(0);
    });
  });
});

describe("not logged in / not on the team", () => {
  it("anon reads nothing", async () => {
    await asAnon(db, async () => {
      await expect(db.query(`select * from clients`)).rejects.toThrow(/permission denied/);
    });
  });

  it("a logged-in user with no staff row, or a leaver, reads nothing", async () => {
    await asUser(db, "00000000-0000-0000-0000-0000000000ff", async () => {
      expect(await count("clients")).toBe(0);
      expect(await count("staff")).toBe(0);
    });
    await db.query(`update staff set status = 'left' where id = $1`, [people.marjorie]);
    await asUser(db, AUTH.marjorie, async () => {
      expect(await count("clients")).toBe(0);
    });
  });
});
