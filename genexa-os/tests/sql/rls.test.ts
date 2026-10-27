import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { AUTH, asAnon, asUser, freshDb, seedStaff, type TestPeople } from "./db";

let db: PGlite;
let people: TestPeople;
let clientId: string;
let amandaTask: string;
let adityaTask: string;
let sameerJob: string;

const count = async (table: string) =>
  (await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0].n;

beforeAll(async () => {
  db = await freshDb();
  people = await seedStaff(db);
  await db.query(`insert into staff_pay (staff_id, hourly_rate, weekly_pay) values ($1, 6, 240)`, [people.amanda]);
  await db.query(`insert into finance_transactions (mercury_id, amount, counterparty) values ('m1', 5000, 'Whop')`);
  clientId = (await db.query<{ id: string }>(`insert into clients (name, cycle_fee) values ('RLS Clinic', 3000) returning id`)).rows[0].id;
  amandaTask = (
    await db.query<{ id: string }>(`insert into tasks (owner_id, title, source) values ($1, 'Call back patient', 'ryan') returning id`, [people.amanda])
  ).rows[0].id;
  adityaTask = (
    await db.query<{ id: string }>(`insert into tasks (owner_id, title, category, source) values ($1, 'Check ad spend', 'ads', 'ryan') returning id`, [
      people.aditya,
    ])
  ).rows[0].id;
  sameerJob = (
    await db.query<{ id: string }>(`insert into tech_jobs (type, title, owner_id) values ('fix', 'Fix calendar', $1) returning id`, [people.sameer])
  ).rows[0].id;
  await db.query(`insert into agency_month (month, snapshot) values ('2026-09-01', '{"profit": 1}')`);
  // Rows in the tables a CSR must not see, so "reads nothing" is not just "nothing there".
  const lead = (
    await db.query<{ id: string }>(`insert into leads (client_id, ghl_contact_id, name, created_at) values ($1, 'rls1', 'Pat Lead', now()) returning id`, [
      clientId,
    ])
  ).rows[0].id;
  await db.query(`insert into appointments (lead_id, client_id, scheduled_for) values ($1, $2, now() + interval '1 day')`, [lead, clientId]);
  await db.query(`insert into exceptions (type, severity, reason, dedupe_key, owner_pod) values ('lead_not_called', 'red', 'r', 'k0', 'pod_2')`);
  await db.query(`insert into prospects (name, stage) values ('Seed Prospect', 'chase')`);
  await db.query(`insert into ideas (text) values ('Seed idea')`);
  await db.query(`insert into touches (client_id, kind) values ($1, 'call')`, [clientId]);
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
        `update clients set cycle_fee = 1 returning id`,
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

describe("csr", () => {
  // CSRs use the confirmation desk and nothing else (0063). Aditya is the comparison: each of
  // these has rows that ordinary staff can see.
  const operational = [
    "clients", "tasks", "tech_jobs", "exceptions", "prospects", "leads", "appointments", "touches", "ideas", "scoring_config",
    "task_list", "tech_jobs_board",
  ];

  it("reads nothing from operational tables, nor pay, finance, audit or agency month", async () => {
    for (const table of operational) {
      await asUser(db, AUTH.aditya, async () => expect(await count(table), table).toBeGreaterThan(0));
      await asUser(db, AUTH.amanda, async () => expect(await count(table), table).toBe(0));
    }
    await asUser(db, AUTH.amanda, async () => {
      for (const table of ["staff_pay", "finance_transactions", "finance_rules", "audit_log", "agency_month", "eods", "attendance", "eod_status_7d"]) {
        expect(await count(table), table).toBe(0);
      }
    });
  });

  it("reads their own staff row and no one else's", async () => {
    await asUser(db, AUTH.amanda, async () => {
      const r = await db.query<{ id: string }>(`select id from staff`);
      expect(r.rows).toEqual([{ id: people.amanda }]);
    });
  });

  it("cannot write anywhere outside the desk", async () => {
    const today = `(now() at time zone 'America/New_York')::date`;
    const inserts: [string, unknown[], RegExp][] = [
      [`insert into clients (name) values ('Sneaky')`, [], /row-level security/],
      [`insert into staff_pay (staff_id, weekly_pay) values ($1, 9999)`, [people.amanda], /row-level security/],
      [`insert into tasks (owner_id, title, source) values ($1, 'My own task', 'staff')`, [people.amanda], /row-level security/],
      [`insert into tech_jobs (type, title, owner_id) values ('fix', 'Request from amanda', $1)`, [people.sameer], /row-level security/],
      [`insert into touches (client_id, kind, by_id) values ($1, 'call', $2)`, [clientId, people.amanda], /row-level security/],
      [`insert into ideas (text, source) values ('An idea', 'Amanda')`, [], /row-level security/],
      [`insert into eods (staff_id, date, answers) values ($1, ${today}, '{"v": 1}')`, [people.amanda], /EOD_OWN/],
      [
        `insert into sla_pauses (tech_job_id, reason, evidence_note, paused_by) values ($1, 'client_access', 'pls', $2)`,
        [sameerJob, people.amanda],
        /row-level security/,
      ],
    ];
    await asUser(db, AUTH.amanda, async () => {
      for (const sql of [
        `update clients set cycle_fee = 1 returning id`,
        `update staff set role = 'owner' returning id`,
        `update scoring_config set green = 0 returning id`,
        `update tasks set status = 'doing' returning id`,
        `update tech_jobs set status = 'done' returning id`,
        `update exceptions set action_taken = 'Called' returning id`,
      ]) {
        expect((await db.query(sql)).rows.length, sql).toBe(0);
      }
      for (const [sql, params, error] of inserts) {
        await expect(db.query(sql, params), sql).rejects.toThrow(error);
      }
    });
    const task = await db.query<{ status: string }>(`select status from tasks where id = $1`, [amandaTask]);
    expect(task.rows[0].status).toBe("todo");
  });

  it("reads the desk tables and logs calls through the desk function", async () => {
    await asUser(db, AUTH.amanda, async () => {
      expect(await count("confirmation_appointments")).toBe(0);
      expect(await count("confirmation_calls")).toBe(0);
      // Let in: the refusal is about the appointment, not about who is calling.
      await expect(db.query(`select confirmation_log_call(gen_random_uuid(), 'confirmed')`)).rejects.toThrow(/DESK_NOT_FOUND/);
    });
  });
});

describe("staff writes", () => {
  const today = `(now() at time zone 'America/New_York')::date`;

  it("a staff member files their own EOD for today, not someone else's and not yesterday's; a CSR files none", async () => {
    await asUser(db, AUTH.aditya, async () => {
      await db.query(`insert into eods (staff_id, date, answers) values ($1, ${today}, '{"focus": 4}')`, [people.aditya]);
      await expect(db.query(`insert into eods (staff_id, date) values ($1, ${today})`, [people.sameer])).rejects.toThrow(
        /row-level security|EOD_OWN/,
      );
      await expect(db.query(`insert into eods (staff_id, date) values ($1, ${today} - 1)`, [people.aditya])).rejects.toThrow(/EOD_CLOSED/);
      // Editable the same day.
      const r = await db.query(`update eods set answers = '{"focus": 5}' where staff_id = $1 returning id`, [people.aditya]);
      expect(r.rows.length).toBe(1);
    });
    const role = await db.query<{ role: string }>(`select role from eods where staff_id = $1`, [people.aditya]);
    expect(role.rows[0].role).toBe("media_buyer");
    await asUser(db, AUTH.amanda, async () => {
      await expect(
        db.query(`insert into eods (staff_id, date, answers) values ($1, ${today}, '{"focus": 4}')`, [people.amanda]),
      ).rejects.toThrow(/EOD_OWN/);
    });
    expect((await db.query(`select 1 from eods where staff_id = $1`, [people.amanda])).rows).toHaveLength(0);
  });

  it("staff change the status of their own task, nothing else, and nobody else's task; a CSR not even their own", async () => {
    await asUser(db, AUTH.aditya, async () => {
      const ok = await db.query(`update tasks set status = 'doing' where id = $1 returning id`, [adityaTask]);
      expect(ok.rows.length).toBe(1);
      await expect(db.query(`update tasks set title = 'Easier task' where id = $1`, [adityaTask])).rejects.toThrow(/TASK_STATUS_ONLY/);
      await expect(db.query(`update tasks set deleted_at = now() where id = $1`, [adityaTask])).rejects.toThrow(/TASK_STATUS_ONLY/);
    });
    await asUser(db, AUTH.sameer, async () => {
      const r = await db.query(`update tasks set status = 'done' where id = $1 returning id`, [adityaTask]);
      expect(r.rows.length).toBe(0);
    });
    await asUser(db, AUTH.amanda, async () => {
      const r = await db.query(`update tasks set status = 'doing' where id = $1 returning id`, [amandaTask]);
      expect(r.rows.length).toBe(0);
    });
    const statuses = await db.query<{ id: string; status: string }>(`select id, status from tasks where id in ($1, $2)`, [adityaTask, amandaTask]);
    expect(Object.fromEntries(statuses.rows.map((t) => [t.id, t.status]))).toEqual({ [adityaTask]: "doing", [amandaTask]: "todo" });
  });

  it("staff cannot add to Ryan's list", async () => {
    await asUser(db, AUTH.aditya, async () => {
      await expect(
        db.query(`insert into tasks (owner_id, title, category, source) values ($1, 'Pay me more', 'ads', 'ryan')`, [people.ryan]),
      ).rejects.toThrow(/TASK_OWNER_LIST/);
    });
  });

  it("only the job's owner can work or pause a tech job, and a pause needs evidence", async () => {
    await asUser(db, AUTH.aditya, async () => {
      const r = await db.query(`update tech_jobs set status = 'done' where id = $1 returning id`, [sameerJob]);
      expect(r.rows.length).toBe(0);
      await expect(
        db.query(
          `insert into sla_pauses (tech_job_id, reason, evidence_note, paused_by) values ($1, 'client_access', 'pls', $2)`,
          [sameerJob, people.aditya],
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
    // The seeded pod members are CSRs, who no longer action anything: put the non-CSR staff in pods.
    await db.query(`update staff set pod = 'pod_2' where id = $1`, [people.sameer]);
    await db.query(`update staff set pod = 'pod_1' where id = $1`, [people.aditya]);
    try {
      await asUser(db, AUTH.sameer, async () => {
        expect((await db.query(`update exceptions set action_taken = 'Called' where dedupe_key = 'k2' returning id`)).rows.length).toBe(1);
      });
      await asUser(db, AUTH.aditya, async () => {
        expect((await db.query(`update exceptions set action_taken = 'x' where dedupe_key = 'k2' returning id`)).rows.length).toBe(0);
      });
      // A CSR in the owning pod cannot action it.
      await asUser(db, AUTH.amanda, async () => {
        expect((await db.query(`update exceptions set action_taken = 'x' where dedupe_key = 'k2' returning id`)).rows.length).toBe(0);
      });
    } finally {
      await db.query(`update staff set pod = null where id in ($1, $2)`, [people.sameer, people.aditya]);
    }
    const k2 = await db.query<{ action_taken: string }>(`select action_taken from exceptions where dedupe_key = 'k2'`);
    expect(k2.rows[0].action_taken).toBe("Called");
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

describe("prospect contact details are owner only", () => {
  it("staff can read a prospect but never its contact details; the owner can", async () => {
    const p = (await db.query<{ id: string }>(`insert into prospects (name, stage) values ('Dr Prospect', 'chase') returning id`)).rows[0].id;
    await db.query(`insert into prospect_contacts (prospect_id, contact) values ($1, 'dr@example.org / 555-0100')`, [p]);
    const cols = await db.query(`select 1 from information_schema.columns where table_name = 'prospects' and column_name = 'contact'`);
    expect(cols.rows.length).toBe(0);
    await asUser(db, AUTH.aditya, async () => {
      expect(await count("prospects")).toBeGreaterThanOrEqual(1);
      expect(await count("prospect_contacts")).toBe(0);
      await expect(db.query(`insert into prospect_contacts (prospect_id, contact) values ($1, 'x')`, [p])).rejects.toThrow(/row-level security|duplicate/);
    });
    // A CSR reads neither.
    await asUser(db, AUTH.amanda, async () => {
      expect(await count("prospects")).toBe(0);
      expect(await count("prospect_contacts")).toBe(0);
    });
    await asUser(db, AUTH.ryan, async () => {
      expect(await count("prospect_contacts")).toBe(1);
    });
  });
});
