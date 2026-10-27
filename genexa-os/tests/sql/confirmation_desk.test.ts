import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { AUTH, asUser, freshDb, seedStaff, type TestPeople } from "./db";

let db: PGlite;
let people: TestPeople;
let clinic: string;
let n = 0;
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const appt = async (hoursAhead: number, name = `Patient ${++n}`) =>
  (await one<{ id: string }>(
    `insert into confirmation_appointments (client_id, ghl_appointment_id, ghl_contact_id, unconfirmed_calendar_id, patient_name, phone, scheduled_for, clinic_timezone)
     values ($1, $2, $2, 'CAL_U', $3, '+15550100123', now() + make_interval(mins => $4::int), 'America/New_York') returning id`,
    [clinic, `ghl_${n}_${Math.random()}`, name, Math.round(hoursAhead * 60)])).id;
const log = (id: string, outcome: string) => db.query<{ r: { attempt: number; status: string } }>(`select confirmation_log_call($1, $2) as r`, [id, outcome]);
const desk = (id: string) => one<{ status: string; attempts: number; last_outcome: string | null; last_by: string | null; urgency: string }>(`select status, attempts, last_outcome, last_by, urgency from confirmation_desk where id = $1`, [id]);

beforeAll(async () => {
  db = await freshDb();
  people = await seedStaff(db);
  clinic = (await one<{ id: string }>(`insert into clients (name, stage) values ('Desk Clinic', 'live') returning id`)).id;
});

describe("the window", () => {
  it("shows appointments from 34 hours ahead down to 3 hours ahead, soonest first", async () => {
    const far = await appt(35), justIn = await appt(33.9), mid = await appt(20), soon = await appt(5), late = await appt(2.9);
    const ids = (await db.query<{ id: string }>(`select id from confirmation_desk where client_id = $1 order by scheduled_for`, [clinic])).rows.map((r) => r.id);
    expect(ids).toEqual([soon, mid, justIn]);
    expect(ids).not.toContain(far);
    expect(ids).not.toContain(late);
  });

  it("colours by time left: red under 12h, amber 12-24h, green once confirmed", async () => {
    const red = await appt(6), amber = await appt(18), plain = await appt(30), conf = await appt(8);
    await asUser(db, AUTH.amanda, async () => { await log(conf, "confirmed"); });
    expect([(await desk(red)).urgency, (await desk(amber)).urgency, (await desk(plain)).urgency, (await desk(conf)).urgency]).toEqual(["red", "amber", "none", "green"]);
  });
});

describe("logging calls", () => {
  it("numbers attempts, records who and what, and confirming or rescheduling closes the appointment", async () => {
    const a = await appt(10);
    await asUser(db, AUTH.amanda, async () => {
      expect((await log(a, "no_answer")).rows[0].r).toEqual({ attempt: 1, status: "unconfirmed" });
      expect((await log(a, "voicemail")).rows[0].r).toEqual({ attempt: 2, status: "unconfirmed" });
    });
    await asUser(db, AUTH.marjorie, async () => {
      expect((await log(a, "confirmed")).rows[0].r).toEqual({ attempt: 3, status: "confirmed" });
      await expect(log(a, "no_answer")).rejects.toThrow(/DESK_CLOSED/);
    });
    expect(await desk(a)).toMatchObject({ status: "confirmed", attempts: 3, last_outcome: "confirmed", last_by: "Marjorie Grace Villarino" });
    const b = await appt(10);
    await asUser(db, AUTH.amanda, async () => { await log(b, "rescheduled"); });
    expect((await desk(b)).status).toBe("rescheduled");
  });

  it("allows 10 attempts at most, and the 10th unanswered one locks it to Unreachable", async () => {
    const a = await appt(15);
    await asUser(db, AUTH.amanda, async () => {
      for (let i = 1; i <= 9; i++) await log(a, i % 2 ? "no_answer" : "voicemail");
      expect((await desk(a)).status).toBe("unconfirmed");
      expect((await log(a, "no_answer")).rows[0].r).toEqual({ attempt: 10, status: "unreachable" });
      await expect(log(a, "confirmed")).rejects.toThrow(/DESK_CLOSED|DESK_LIMIT/);
    });
    expect(await desk(a)).toMatchObject({ status: "unreachable", attempts: 10 });
    await expect(db.query(`insert into confirmation_calls (appointment_id, attempt_no, outcome, staff_id) values ($1, 11, 'no_answer', $2)`, [a, people.amanda])).rejects.toThrow();
  });

  it("only CSRs and the owner can log; a CSR cannot write the tables directly; nothing can be deleted", async () => {
    const a = await appt(9);
    await asUser(db, AUTH.sameer, async () => { await expect(log(a, "no_answer")).rejects.toThrow(/DESK_REFUSED/); });
    await asUser(db, AUTH.ryan, async () => { expect((await log(a, "no_answer")).rows[0].r.attempt).toBe(1); });
    await asUser(db, AUTH.amanda, async () => {
      await expect(db.query(`insert into confirmation_calls (appointment_id, attempt_no, outcome, staff_id) values ($1, 2, 'confirmed', $2)`, [a, people.amanda])).rejects.toThrow();
      expect((await db.query(`update confirmation_appointments set status = 'confirmed' where id = $1 returning id`, [a])).rows.length).toBe(0);
    });
    await expect(db.query(`delete from confirmation_calls`)).rejects.toThrow();
    await expect(db.query(`delete from confirmation_appointments`)).rejects.toThrow();
  });

  it("refuses a call inside 3 hours of the appointment", async () => {
    const a = await appt(2.5);
    await asUser(db, AUTH.amanda, async () => { await expect(log(a, "no_answer")).rejects.toThrow(/DESK_CLOSED/); });
  });
});

describe("expiry and access", () => {
  it("anything still unconfirmed or unreachable at 3 hours is Expired - unconfirmed; confirmed ones are left alone", async () => {
    const open = await appt(2.5), conf = await appt(2.8);
    await db.query(`update confirmation_appointments set status = 'confirmed' where id = $1`, [conf]);
    const r = await one<{ n: number }>(`select confirmations_expire() as n`);
    expect(r.n).toBeGreaterThanOrEqual(1);
    expect((await one<{ status: string; status_source: string }>(`select status, status_source from confirmation_appointments where id = $1`, [open]))).toEqual({ status: "expired", status_source: "system" });
    expect((await one<{ status: string }>(`select status from confirmation_appointments where id = $1`, [conf])).status).toBe("confirmed");
  });

  it("a CSR reads the desk and nothing else; the media buyer and tech cannot read the desk", async () => {
    await asUser(db, AUTH.amanda, async () => {
      expect(Number((await one<{ n: string }>(`select count(*) as n from confirmation_desk`)).n)).toBeGreaterThan(0);
      expect((await db.query(`select 1 from clients`)).rows.length).toBe(0);
      expect((await db.query(`select 1 from tasks`)).rows.length).toBe(0);
      expect((await db.query(`select name from staff`)).rows).toEqual([{ name: "Amanda Harder" }]);
      // The call-centre numbers are for the rest of the team, not for the CSRs themselves.
      expect((await db.query(`select * from confirmation_stats(app_today() - 1, app_today())`)).rows).toEqual([]);
    });
    await asUser(db, AUTH.aditya, async () => {
      expect((await db.query(`select 1 from confirmation_desk`)).rows.length).toBe(0);
      expect((await db.query(`select name from confirmation_stats(app_today() - 1, app_today())`)).rows.length).toBeGreaterThan(0);
    });
  });
});

describe("call centre numbers", () => {
  it("counts each CSR's calls, outcomes and patients, for the team and the owner", async () => {
    const rows = (await db.query<{ name: string; calls: string; appointments: string; confirmed: string; no_answer: string; unreachable: string }>(
      `select name, calls, appointments, confirmed, no_answer, unreachable from confirmation_stats(app_today() - 1, app_today()) order by name`)).rows;
    const amanda = rows.find((r) => r.name === "Amanda Harder")!;
    expect(Number(amanda.calls)).toBeGreaterThanOrEqual(12);
    expect(Number(amanda.unreachable)).toBe(1);
    const marj = rows.find((r) => r.name === "Marjorie Grace Villarino")!;
    expect([Number(marj.calls), Number(marj.confirmed)]).toEqual([1, 1]);
    const t = await one<{ appointments: string; expired: string; unreachable: string }>(`select * from confirmation_desk_totals(app_today() - 2, app_today() + 2)`);
    expect(Number(t.appointments)).toBeGreaterThan(0);
  });
});
