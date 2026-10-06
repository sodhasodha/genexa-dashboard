import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshDb, seedStaff, type TestPeople } from "./db";

let db: PGlite;
let people: TestPeople;

beforeAll(async () => {
  db = await freshDb();
  people = await seedStaff(db);
});

const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];

describe("business-hours maths (09:00-17:00 ET, Mon-Fri)", () => {
  it("a fix requested Friday 16:50 ET is due Monday 09:20 ET", async () => {
    // 2026-10-09 is a Friday; ET is UTC-4 in October.
    const r = await one<{ due: string }>(
      `select to_char(add_business_minutes('2026-10-09 16:50 America/New_York'::timestamptz, 30)
         at time zone 'America/New_York', 'Dy YYYY-MM-DD HH24:MI') as due`,
    );
    expect(r.due).toBe("Mon 2026-10-12 09:20");
  });

  it("a request outside hours starts its clock at the next opening", async () => {
    const r = await one<{ due: string }>(
      `select to_char(add_business_minutes('2026-10-10 11:00 America/New_York'::timestamptz, 30)
         at time zone 'America/New_York', 'Dy HH24:MI') as due`,
    );
    expect(r.due).toBe("Mon 09:30");
  });

  it("counts only business minutes between two instants", async () => {
    const r = await one<{ m: string }>(
      `select business_minutes_between(
         '2026-10-09 16:50 America/New_York', '2026-10-12 09:20 America/New_York') as m`,
    );
    expect(Number(r.m)).toBe(30);
  });

  it("the tech_jobs trigger sets due_at from type and requested_at", async () => {
    const fix = await one<{ due: string }>(
      `insert into tech_jobs (type, title, requested_at, owner_id)
       values ('fix', 'Calendar not syncing', '2026-10-09 16:50 America/New_York', $1)
       returning to_char(due_at at time zone 'America/New_York', 'Dy HH24:MI') as due`,
      [people.sameer],
    );
    expect(fix.due).toBe("Mon 09:20");
    const launch = await one<{ h: string }>(
      `insert into tech_jobs (type, title, requested_at, owner_id)
       values ('launch', 'Launch clinic', '2026-10-05 10:00 America/New_York', $1)
       returning extract(epoch from (due_at - requested_at)) / 3600 as h`,
      [people.sameer],
    );
    expect(Number(launch.h)).toBe(48);
  });
});

describe("Genexa time = elapsed - paused", () => {
  it("removes a pause from a fix's Genexa time and keeps it inside SLA", async () => {
    // Requested Mon 10:00, done Mon 11:10 = 70 business minutes elapsed.
    // Paused 10:10-11:00 waiting on the client = 50 minutes. Genexa time = 20.
    const job = await one<{ id: string }>(
      `insert into tech_jobs (type, title, requested_at, owner_id, status, done_at)
       values ('fix', 'Pixel broken', '2026-10-05 10:00 America/New_York', $1, 'done', '2026-10-05 11:10 America/New_York')
       returning id`,
      [people.sameer],
    );
    await db.query(
      `insert into sla_pauses (tech_job_id, paused_at, resumed_at, reason, evidence_note, paused_by)
       values ($1, '2026-10-05 10:10 America/New_York', '2026-10-05 11:00 America/New_York',
               'client_access', 'Asked clinic for Meta access in Slack 10:09', $2)`,
      [job.id, people.sameer],
    );
    const sla = await one<{ elapsed_minutes: string; paused_minutes: string; genexa_minutes: string; met_sla: boolean; is_overdue: boolean }>(
      `select * from tech_job_sla where tech_job_id = $1`,
      [job.id],
    );
    expect(Number(sla.elapsed_minutes)).toBe(70);
    expect(Number(sla.paused_minutes)).toBe(50);
    expect(Number(sla.genexa_minutes)).toBe(20);
    expect(sla.met_sla).toBe(true);
    expect(sla.is_overdue).toBe(false);
  });

  it("the same job without the pause breaches SLA", async () => {
    const job = await one<{ id: string }>(
      `insert into tech_jobs (type, title, requested_at, owner_id, status, done_at)
       values ('fix', 'Form broken', '2026-10-05 10:00 America/New_York', $1, 'done', '2026-10-05 11:10 America/New_York')
       returning id`,
      [people.sameer],
    );
    const sla = await one<{ genexa_minutes: string; met_sla: boolean }>(
      `select * from tech_job_sla where tech_job_id = $1`,
      [job.id],
    );
    expect(Number(sla.genexa_minutes)).toBe(70);
    expect(sla.met_sla).toBe(false);
  });

  it("an open launch job requested weeks ago shows overdue", async () => {
    const job = await one<{ id: string }>(
      `insert into tech_jobs (type, title, requested_at, owner_id) values ('launch', 'Old launch', now() - interval '20 days', $1) returning id`,
      [people.sameer],
    );
    const sla = await one<{ is_overdue: boolean }>(`select is_overdue from tech_job_sla where tech_job_id = $1`, [job.id]);
    expect(sla.is_overdue).toBe(true);
  });

  it("a pause needs evidence, and only one pause can be open per job", async () => {
    const job = await one<{ id: string }>(
      `insert into tech_jobs (type, title, owner_id) values ('fix', 'x', $1) returning id`,
      [people.sameer],
    );
    await expect(
      db.query(`insert into sla_pauses (tech_job_id, reason, evidence_note) values ($1, 'client_access', '  ')`, [job.id]),
    ).rejects.toThrow();
    await db.query(`insert into sla_pauses (tech_job_id, reason, evidence_note) values ($1, 'client_access', 'proof')`, [job.id]);
    await expect(
      db.query(`insert into sla_pauses (tech_job_id, reason, evidence_note) values ($1, 'third_party', 'proof 2')`, [job.id]),
    ).rejects.toThrow();
  });

  it("the launch clock starts only when both the form and access are done", async () => {
    const c = await one<{ id: string }>(`insert into clients (name) values ('SLA Clinic') returning id`);
    const l = await one<{ id: string }>(
      `insert into launches (client_id, paid_at, ob_form_done_at) values ($1, now() - interval '10 days', now() - interval '9 days') returning id`,
      [c.id],
    );
    let sla = await one<{ clock_start: string | null; is_overdue: boolean | null; days_waiting_since_paid: number }>(
      `select * from launch_sla where launch_id = $1`,
      [l.id],
    );
    expect(sla.clock_start).toBeNull();
    expect(sla.is_overdue).toBeNull();
    expect(sla.days_waiting_since_paid).toBeGreaterThanOrEqual(9);
    await db.query(`update launches set access_done_at = now() - interval '3 days' where id = $1`, [l.id]);
    sla = await one(`select * from launch_sla where launch_id = $1`, [l.id]);
    expect(sla.is_overdue).toBe(true);
  });
});
