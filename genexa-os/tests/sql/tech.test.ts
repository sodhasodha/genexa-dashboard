import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { AUTH, asUser, freshDb, seedStaff, type TestPeople } from "./db";

let db: PGlite;
let people: TestPeople;
let clinicA: string;
let clinicB: string;

// An instant in ET, `weeksAgo` weeks before the current ET week. Day 0 = Monday.
const at = (weeksAgo: number, day: number, time: string) =>
  `((app_week_start(app_today()) - ${weeksAgo * 7} + ${day} + time '${time}') at time zone 'America/New_York')`;

type Score = { metric: string; value: string | null; numerator: string; denominator: string; colour: string | null; card: string };

async function scores(weeksAgo: number, staffId = people.sameer): Promise<Record<string, Score>> {
  const r = await db.query<Score>(
    `select metric, value, numerator, denominator, colour, card from score_tech_weekly
     where staff_id = $1 and week_start = app_week_start(app_today()) - $2::int`,
    [staffId, weeksAgo * 7],
  );
  return Object.fromEntries(r.rows.map((row) => [row.metric, row]));
}

async function doneJob(type: string, title: string, requested: string, done: string, clientId: string | null = null, extra = ""): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into tech_jobs (type, title, client_id, requested_at, owner_id, status, done_at ${extra ? ", broke_after_live" : ""})
     values ($1, $2, $3, ${requested}, $4, 'done', ${done} ${extra ? ", true" : ""}) returning id`,
    [type, title, clientId, people.sameer],
  );
  return r.rows[0].id;
}

beforeAll(async () => {
  db = await freshDb();
  people = await seedStaff(db);
  clinicA = (await db.query<{ id: string }>(`insert into clients (name) values ('Clinic A') returning id`)).rows[0].id;
  clinicB = (await db.query<{ id: string }>(`insert into clients (name) values ('Clinic B') returning id`)).rows[0].id;

  // --- Last week (fully in the past) ---
  // Launches: 24h (met), 72h (missed), 72h with a 30h client pause = 42h Genexa time (met).
  await doneJob("launch", "Launch met", at(1, 0, "10:00"), at(1, 1, "10:00"), clinicA);
  await doneJob("launch", "Launch missed", at(1, 0, "10:00"), at(1, 3, "10:00"));
  const paused = await doneJob("launch", "Launch paused", at(1, 0, "10:00"), at(1, 3, "10:00"));
  await db.query(
    `insert into sla_pauses (tech_job_id, paused_at, resumed_at, reason, evidence_note, paused_by)
     values ($1, ${at(1, 1, "10:00")}, ${at(1, 2, "16:00")}, 'client_access', 'Asked for Meta access in Slack', $2)`,
    [paused, people.sameer],
  );
  // Fixes: 20 business minutes (met), 70 business minutes (missed).
  await doneJob("fix", "Fix met", at(1, 1, "10:00"), at(1, 1, "10:20"));
  await doneJob("fix", "Fix missed", at(1, 1, "10:00"), at(1, 1, "11:10"));
  // A build job has no SLA; it only counts towards the week's jobs.
  await doneJob("build", "Build", at(1, 2, "10:00"), at(1, 2, "15:00"));
});

describe("score_tech_weekly", () => {
  it("has exactly the scorecard columns, card = tech, four metrics per week", async () => {
    const r = await db.query(`select * from score_tech_weekly where staff_id = $1 and week_start = app_week_start(app_today())`, [people.sameer]);
    expect(r.fields.map((f) => f.name)).toEqual(["staff_id", "week_start", "card", "metric", "value", "numerator", "denominator", "colour"]);
    expect(r.rows.length).toBe(4);
    const weeks = await db.query<{ n: string }>(`select count(distinct week_start) as n from score_tech_weekly where staff_id = $1`, [people.sameer]);
    expect(Number(weeks.rows[0].n)).toBe(13);
    // Only the tech person gets a tech card.
    const others = await db.query(`select 1 from score_tech_weekly where staff_id <> $1`, [people.sameer]);
    expect(others.rows.length).toBe(0);
  });

  it("scores launches and fixes that met or missed SLA, with a pause taken off Genexa time", async () => {
    const s = await scores(1);
    expect(s.launch_sla_pct.card).toBe("tech");
    expect(Number(s.launch_sla_pct.numerator)).toBe(2);
    expect(Number(s.launch_sla_pct.denominator)).toBe(3);
    expect(Number(s.launch_sla_pct.value)).toBe(66.7);
    expect(s.launch_sla_pct.colour).toBe("red"); // below 70
    expect(Number(s.fix_sla_pct.numerator)).toBe(1);
    expect(Number(s.fix_sla_pct.denominator)).toBe(2);
    expect(Number(s.fix_sla_pct.value)).toBe(50);
    expect(s.fix_sla_pct.colour).toBe("red"); // below 60
  });

  it("counts jobs paused at least once, and never colours that metric", async () => {
    const s = await scores(1);
    expect(Number(s.paused_pct.numerator)).toBe(1);
    expect(Number(s.paused_pct.denominator)).toBe(6);
    expect(Number(s.paused_pct.value)).toBe(16.7);
    expect(s.paused_pct.colour).toBeNull();
  });

  it("takes its colours from scoring_config", async () => {
    await db.query(`update scoring_config set amber = 50 where key = 'tech_fix_sla_pct'`);
    expect((await scores(1)).fix_sla_pct.colour).toBe("amber");
    await db.query(`update scoring_config set green = 50 where key = 'tech_fix_sla_pct'`);
    expect((await scores(1)).fix_sla_pct.colour).toBe("green");
    await db.query(`update scoring_config set green = 80, amber = 60 where key = 'tech_fix_sla_pct'`);
  });

  it("a week with nothing to measure has null value and null colour", async () => {
    const s = await scores(3);
    for (const metric of ["launch_sla_pct", "fix_sla_pct", "broken_week1", "paused_pct"]) {
      expect(s[metric].value, metric).toBeNull();
      expect(s[metric].colour, metric).toBeNull();
      expect(Number(s[metric].denominator), metric).toBe(0);
    }
  });

  it("counts launches broken in week 1 from both launches and tech jobs, once per clinic", async () => {
    // Last week so far: three launch jobs live, none flagged.
    let s = await scores(1);
    expect(Number(s.broken_week1.denominator)).toBe(3);
    expect(Number(s.broken_week1.value)).toBe(0);
    expect(s.broken_week1.colour).toBe("green");

    // Clinic A's launch row (same clinic as the "Launch met" job) is flagged broken: 1 = amber.
    const qc = `qc_lead_access, qc_calendar_tested, qc_test_lead_deleted, qc_pixel_firing, qc_cortana_connected, qc_clinic_sheet`;
    await db.query(
      `insert into launches (client_id, ${qc}, live_at, broke_week1) values ($1, true, true, true, true, true, true, ${at(1, 1, "12:00")}, true)`,
      [clinicA],
    );
    s = await scores(1);
    expect(Number(s.broken_week1.denominator)).toBe(3); // not double counted with the job
    expect(Number(s.broken_week1.value)).toBe(1);
    expect(s.broken_week1.colour).toBe("amber");

    // A second one, flagged on the tech job: 2 = red.
    await doneJob("launch", "Launch broke", at(1, 3, "10:00"), at(1, 4, "10:00"), clinicB, "broke");
    s = await scores(1);
    expect(Number(s.broken_week1.value)).toBe(2);
    expect(Number(s.broken_week1.denominator)).toBe(4);
    expect(s.broken_week1.colour).toBe("red");
  });

  it("ignores deleted jobs and jobs that are not done", async () => {
    const before = await scores(2);
    await db.query(
      `insert into tech_jobs (type, title, requested_at, owner_id, status, done_at, deleted_at)
       values ('fix', 'Deleted', ${at(2, 1, "10:00")}, $1, 'done', ${at(2, 1, "10:10")}, now())`,
      [people.sameer],
    );
    await db.query(`insert into tech_jobs (type, title, requested_at, owner_id) values ('fix', 'Open', ${at(2, 1, "10:00")}, $1)`, [people.sameer]);
    expect(await scores(2)).toEqual(before);
    expect(before.fix_sla_pct.value).toBeNull();
  });
});

describe("tech_jobs_board", () => {
  it("shows an open job with its pause, then closes the pause when the job is marked done", async () => {
    const job = (
      await db.query<{ id: string }>(
        `insert into tech_jobs (type, title, client_id, owner_id, requested_by, requested_at) values ('launch', 'Board job', $1, $2, $3, now() - interval '2 hours') returning id`,
        [clinicA, people.sameer, people.amanda],
      )
    ).rows[0].id;
    await db.query(
      `insert into sla_pauses (tech_job_id, paused_at, reason, evidence_note, paused_by) values ($1, now() - interval '1 hour', 'client_assets', 'Waiting on logo', $2)`,
      [job, people.sameer],
    );
    type Row = { client_name: string; requested_by_name: string; is_paused: boolean; pause_reason: string | null; open_pause_id: string | null; done_this_week: boolean; paused_minutes: string; genexa_minutes: string };
    const read = async () => (await db.query<Row>(`select * from tech_jobs_board where tech_job_id = $1`, [job])).rows[0];
    let row = await read();
    expect(row.client_name).toBe("Clinic A");
    expect(row.requested_by_name).toBe("Amanda Harder");
    expect(row.is_paused).toBe(true);
    expect(row.pause_reason).toBe("client_assets");
    expect(row.done_this_week).toBe(false);
    expect(Math.round(Number(row.paused_minutes))).toBe(60);
    expect(Math.round(Number(row.genexa_minutes))).toBe(60);

    await db.query(`update tech_jobs set status = 'done' where id = $1`, [job]);
    row = await read();
    expect(row.is_paused).toBe(false);
    expect(row.open_pause_id).toBeNull();
    expect(row.done_this_week).toBe(true);
    expect(Math.round(Number(row.paused_minutes))).toBe(60);
  });
});

describe("request form and job controls (RLS)", () => {
  let requested: string;

  it("a CSR can request tech work; it lands with the tech person and a due time", async () => {
    await asUser(db, AUTH.amanda, async () => {
      const r = await db.query<{ id: string; requested_by: string; owner_id: string; status: string; due_at: string | null }>(
        `insert into tech_jobs (type, title, notes, client_id, requested_by, owner_id)
         values ('fix', 'Calendar not booking', 'Patients see no slots', $1, $2, app_role_holder('tech'))
         returning id, requested_by, owner_id, status, due_at`,
        [clinicA, people.amanda],
      );
      requested = r.rows[0].id;
      expect(r.rows[0].requested_by).toBe(people.amanda);
      expect(r.rows[0].owner_id).toBe(people.sameer);
      expect(r.rows[0].status).toBe("todo");
      expect(r.rows[0].due_at).not.toBeNull();
      // The requester sees it on the board.
      const seen = await db.query(`select 1 from tech_jobs_board where tech_job_id = $1`, [requested]);
      expect(seen.rows.length).toBe(1);
    });
  });

  it("a CSR cannot request work in someone else's name", async () => {
    await asUser(db, AUTH.amanda, async () => {
      await expect(
        db.query(`insert into tech_jobs (type, title, requested_by, owner_id) values ('fix', 'Forged', $1, $2)`, [people.marjorie, people.sameer]),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it("a CSR cannot update, pause or resume someone else's job", async () => {
    await db.query(`insert into sla_pauses (tech_job_id, reason, evidence_note, paused_by) values ($1, 'third_party', 'GHL outage', $2)`, [requested, people.sameer]);
    await asUser(db, AUTH.amanda, async () => {
      const upd = await db.query(`update tech_jobs set status = 'done', blocked_on = 'nothing' where id = $1 returning id`, [requested]);
      expect(upd.rows.length).toBe(0);
      const resume = await db.query<{ n: number }>(`select resume_tech_job($1) as n`, [requested]);
      expect(resume.rows[0].n).toBe(0);
    });
    await db.query(`update sla_pauses set resumed_at = now() where tech_job_id = $1`, [requested]);
    await asUser(db, AUTH.amanda, async () => {
      await expect(
        db.query(`insert into sla_pauses (tech_job_id, reason, evidence_note, paused_by) values ($1, 'client_access', 'made up', $2)`, [requested, people.amanda]),
      ).rejects.toThrow(/row-level security/);
    });
    const job = await db.query<{ status: string; blocked_on: string | null }>(`select status, blocked_on from tech_jobs where id = $1`, [requested]);
    expect(job.rows[0]).toEqual({ status: "todo", blocked_on: null });
  });

  it("the job's owner can work it: status, blocked on, pause with evidence, resume", async () => {
    await asUser(db, AUTH.sameer, async () => {
      const upd = await db.query(`update tech_jobs set status = 'stuck', blocked_on = 'Clinic to share calendar login' where id = $1 returning id`, [requested]);
      expect(upd.rows.length).toBe(1);
      await expect(
        db.query(`insert into sla_pauses (tech_job_id, reason, evidence_note, paused_by) values ($1, 'client_access', ' ', $2)`, [requested, people.sameer]),
      ).rejects.toThrow();
      const pause = await db.query(
        `insert into sla_pauses (tech_job_id, reason, evidence_note, paused_by) values ($1, 'client_access', 'Asked in Slack 10:02', $2) returning id`,
        [requested, people.sameer],
      );
      expect(pause.rows.length).toBe(1);
      const resume = await db.query<{ n: number }>(`select resume_tech_job($1) as n`, [requested]);
      expect(resume.rows[0].n).toBe(1);
      const open = await db.query(`select 1 from sla_pauses where tech_job_id = $1 and resumed_at is null`, [requested]);
      expect(open.rows.length).toBe(0);
    });
  });

  it("the app owner can also work any job", async () => {
    await asUser(db, AUTH.ryan, async () => {
      const upd = await db.query(`update tech_jobs set status = 'done' where id = $1 returning done_at`, [requested]);
      expect(upd.rows.length).toBe(1);
      expect((upd.rows[0] as { done_at: string | null }).done_at).not.toBeNull();
    });
  });
});
