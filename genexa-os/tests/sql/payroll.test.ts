import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { payRunMessage, runPayRunJob, type PayRunStore, type SendResult } from "@/lib/payroll/job";
import { AUTH, asUser, freshDb, seedStaff, type TestPeople } from "./db";

let db: PGlite;
let people: TestPeople;
let freddie: string;

// Fixed weeks in the past, so nothing depends on today's date.
const W1 = "2026-09-07"; // Mon 7 – Sun 13 Sep: mid-month
const W2 = "2026-09-14"; // Mon 14 – Sun 20 Sep
const W_MONTH_END = "2026-09-28"; // Mon 28 Sep – Sun 4 Oct: contains 30 Sep

type Line = {
  id: string; pay_type: string | null; rostered_hours: number; worked_hours: number; late_count: number; no_show_count: number;
  rate: number | null; gross: number | null; adjustment: number; total: number; status: string; flags: string[]; note: string | null; paid_at: string | null;
};
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const build = async (week: string) => (await db.query<{ id: string }>(`select build_pay_run($1::date) as id`, [week])).rows[0].id;
const line = async (week: string, staff: string): Promise<Line> => {
  const r = (await db.query<Record<string, unknown>>(
    `select l.* from pay_run_lines l join pay_runs r on r.id = l.pay_run_id where r.week_start = $1::date and l.staff_id = $2`, [week, staff])).rows[0];
  return {
    ...(r as unknown as Line),
    rostered_hours: Number(r.rostered_hours), worked_hours: Number(r.worked_hours), rate: num(r.rate), gross: num(r.gross),
    adjustment: Number(r.adjustment), total: Number(r.total),
  };
};
const et = (date: string, time: string | null) => (time ? `${date} ${time} America/New_York` : null);
/** An attendance day. Times are ET wall clock; the shift defaults to 09:00–17:00. */
const day = (staff: string, date: string, o: { in?: string; out?: string; shift?: [string, string] | null; status?: string; ot?: boolean }) =>
  db.query(
    `insert into attendance (staff_id, date, shift_start, shift_end, clock_in, clock_out, status, overtime_approved)
     values ($1, $2::date, $3::timestamptz, $4::timestamptz, $5::timestamptz, $6::timestamptz, $7, $8)`,
    [staff, date,
      o.shift === null ? null : et(date, (o.shift ?? ["09:00", "17:00"])[0]),
      o.shift === null ? null : et(date, (o.shift ?? ["09:00", "17:00"])[1]),
      et(date, o.in ?? null), et(date, o.out ?? null), o.status ?? null, o.ot ?? false],
  );

beforeAll(async () => {
  db = await freshDb();
  people = await seedStaff(db);
  freddie = (await db.query<{ id: string }>(`insert into staff (name, email, role) values ('Freddie Lance', 'freddie@example.test', 'freelance') returning id`)).rows[0].id;
  await db.query(`update staff set slack_user_id = 'U_OWNER' where id = $1`, [people.ryan]);
  // Amanda: hourly at $6. Marjorie: hourly, no rate entered. Aditya: fixed $2,000 a month.
  // Sameer: no pay row at all. Freddie: freelance.
  await db.query(
    `insert into staff_pay (staff_id, pay_type, hourly_rate, monthly_amount) values
       ($1, 'hourly', 6, null), ($2, 'hourly', null, null), ($3, 'fixed_monthly', null, 2000), ($4, 'freelance', null, null)`,
    [people.amanda, people.marjorie, people.aditya, freddie],
  );
});

describe("hourly pay", () => {
  it("is capped at the rostered shift, and a late clock-in pays from the clock-in", async () => {
    await day(people.amanda, "2026-09-07", { in: "08:50", out: "17:30", status: "on_time" }); // 480 of 520 minutes
    await day(people.amanda, "2026-09-08", { in: "09:20", out: "17:00", status: "late" }); // 460 minutes
    await build(W1);
    const l = await line(W1, people.amanda);
    expect(l).toMatchObject({ pay_type: "hourly", rostered_hours: 16, worked_hours: 15.67, late_count: 1, no_show_count: 0, rate: 6, status: "draft" });
    expect(l.gross).toBe(94); // 940 minutes at $6 an hour
    expect(l.total).toBe(94);
    expect(l.flags).toEqual(["overtime not approved"]);
  });

  it("pays the full clock-in to clock-out once overtime is approved", async () => {
    await db.query(`update attendance set overtime_approved = true where staff_id = $1 and date = '2026-09-07'`, [people.amanda]);
    await build(W1);
    const l = await line(W1, people.amanda);
    expect(l.worked_hours).toBe(16.33); // 520 + 460 minutes
    expect(l.gross).toBe(98);
    expect(l.flags).toEqual([]);
  });

  it("counts nothing for a day with no clock-out, an unrostered day or a no-show, and flags each", async () => {
    await day(people.amanda, "2026-09-09", { in: "09:00" });
    await day(people.amanda, "2026-09-10", { in: "10:00", out: "12:00", shift: null });
    await day(people.amanda, "2026-09-11", { status: "no_show" });
    await build(W1);
    const l = await line(W1, people.amanda);
    expect(l.gross).toBe(98);
    expect(l.no_show_count).toBe(1);
    expect(l.rostered_hours).toBe(32);
    expect(l.flags).toEqual(["no clock-out", "no-show", "worked without a rostered shift"]);
  });

  it("rounds money to cents", async () => {
    await db.query(`update staff_pay set hourly_rate = 5.55 where staff_id = $1`, [people.amanda]);
    await build(W1);
    expect((await line(W1, people.amanda)).gross).toBe(90.65); // 980 / 60 × 5.55 = 90.65
    await db.query(`update staff_pay set hourly_rate = 6 where staff_id = $1`, [people.amanda]);
    await build(W1);
  });

  it("puts a shift in the week it starts in, cut in ET", async () => {
    // Sunday 13 Sep 22:00 ET to Monday 02:00 ET belongs to the week of 7 Sep.
    await db.query(
      `insert into attendance (staff_id, date, shift_start, shift_end, clock_in, clock_out, status)
       values ($1, '2026-09-13', '2026-09-13 22:00 America/New_York', '2026-09-14 02:00 America/New_York',
               '2026-09-13 22:00 America/New_York', '2026-09-14 02:00 America/New_York', 'on_time')`, [people.amanda]);
    await build(W1);
    await build(W2);
    expect((await line(W1, people.amanda)).gross).toBe(122); // 98 + 4h × $6
    expect((await line(W2, people.amanda)).gross).toBe(0);
  });
});

describe("people who cannot be paid yet", () => {
  it("have a null gross and a flag, never a silent $0", async () => {
    const noRate = await line(W1, people.marjorie);
    expect(noRate).toMatchObject({ pay_type: "hourly", rate: null, gross: null, total: 0, flags: ["no rate"] });
    const noType = await line(W1, people.sameer);
    expect(noType).toMatchObject({ pay_type: null, gross: null, flags: ["no pay type"] });
  });

  it("are listed in payroll_setup_gaps; the owner is not on the payroll", async () => {
    const gaps = (await db.query<{ name: string; problem: string }>(`select name, problem from payroll_setup_gaps order by name`)).rows;
    expect(gaps).toEqual([
      { name: "Marjorie Grace Villarino", problem: "no rate" },
      { name: "Sameer", problem: "no pay type" },
    ]);
    const ownerLines = await db.query(`select 1 from pay_run_lines where staff_id = $1`, [people.ryan]);
    expect(ownerLines.rows.length).toBe(0);
  });
});

describe("fixed monthly pay", () => {
  it("is not due mid-month: the monthly amount is shown and the total is 0", async () => {
    expect(await line(W1, people.aditya)).toMatchObject({ pay_type: "fixed_monthly", rate: 2000, gross: 0, total: 0, note: "not due this week", flags: [] });
  });
  it("is due in full on the run whose week contains the last day of the month", async () => {
    await build(W_MONTH_END);
    expect(await line(W_MONTH_END, people.aditya)).toMatchObject({ rate: 2000, gross: 2000, total: 2000, note: null });
    await build("2026-08-31"); // Monday 31 Aug is the last day of August
    expect((await line("2026-08-31", people.aditya)).gross).toBe(2000);
    await build("2026-09-21"); // 21–27 Sep: not yet
    expect((await line("2026-09-21", people.aditya)).gross).toBe(0);
  });
});

describe("freelance pay", () => {
  it("is the sum of the week's jobs that are not on a run yet", async () => {
    await db.query(
      `insert into freelance_jobs (staff_id, date, description, amount) values
         ($1, '2026-09-14', 'Landing page', 150), ($1, '2026-09-20', 'Video edit', 75.50), ($1, '2026-09-22', 'Next week job', 40)`, [freddie]);
    const run = await build(W2);
    expect(await line(W2, freddie)).toMatchObject({ pay_type: "freelance", gross: 225.5, total: 225.5, flags: [] });
    const jobs = (await db.query<{ description: string; pay_run_id: string | null }>(`select description, pay_run_id from freelance_jobs order by date`)).rows;
    expect(jobs.map((j) => j.pay_run_id)).toEqual([run, run, null]);
    // Rebuilding does not count a job twice; a job already on this run cannot go on another.
    await build(W2);
    expect((await line(W2, freddie)).gross).toBe(225.5);
    await build("2026-09-21");
    expect((await line("2026-09-21", freddie)).gross).toBe(40);
  });
  it("drops a removed job from a draft line", async () => {
    await db.query(`update freelance_jobs set deleted_at = now() where description = 'Video edit'`);
    await build(W2);
    expect((await line(W2, freddie)).gross).toBe(150);
    await expect(db.query(`delete from freelance_jobs`)).rejects.toThrow();
  });
});

describe("adjustments", () => {
  it("need a reason, change the total and survive a rebuild", async () => {
    const l = await line(W1, people.amanda);
    await expect(db.query(`update pay_run_lines set adjustment = -20 where id = $1`, [l.id])).rejects.toThrow(/check/);
    await db.query(`update pay_run_lines set adjustment = -20, adjustment_reason = 'Advance repaid' where id = $1`, [l.id]);
    expect((await line(W1, people.amanda)).total).toBe(102); // 122 − 20
    await build(W1);
    expect(await line(W1, people.amanda)).toMatchObject({ gross: 122, adjustment: -20, total: 102 });
  });
});

describe("approving and paying a run", () => {
  it("approve all skips people with no rate or no pay type, then approves the run", async () => {
    const run = await build(W1);
    const n = (await db.query<{ n: number }>(`select approve_pay_run($1) as n`, [run])).rows[0].n;
    expect(n).toBe(3); // Amanda, Aditya, Freddie
    expect((await line(W1, people.amanda)).status).toBe("approved");
    expect((await line(W1, people.aditya)).status).toBe("approved");
    expect((await line(W1, people.marjorie)).status).toBe("draft");
    expect((await line(W1, people.sameer)).status).toBe("draft");
    const r = (await db.query<{ status: string; approved_at: string | null }>(`select status, approved_at from pay_runs where id = $1`, [run])).rows[0];
    expect(r.status).toBe("approved");
    expect(r.approved_at).not.toBeNull();
    // A line with no computable pay cannot be approved one at a time either.
    const noRate = await line(W1, people.marjorie);
    await expect(db.query(`update pay_run_lines set status = 'approved' where id = $1`, [noRate.id])).rejects.toThrow(/check/);
  });

  it("a rebuild recomputes draft lines only", async () => {
    await db.query(`update staff_pay set hourly_rate = 10 where staff_id in ($1, $2)`, [people.amanda, people.marjorie]);
    await day(people.marjorie, "2026-09-07", { in: "09:00", out: "13:00", status: "on_time" });
    await build(W1);
    expect(await line(W1, people.amanda)).toMatchObject({ rate: 6, gross: 122, total: 102, status: "approved" });
    expect(await line(W1, people.marjorie)).toMatchObject({ rate: 10, gross: 40, total: 40, status: "draft", flags: [] });
  });

  it("mark paid records the date on the run and its approved lines, and leaves drafts alone", async () => {
    const draftRun = await build("2026-08-24");
    await expect(db.query(`select mark_pay_run_paid($1)`, [draftRun])).rejects.toThrow(/PAY_RUN_NOT_APPROVED/);

    const run = await build(W1);
    await db.query(`select mark_pay_run_paid($1, '2026-09-15 12:00+00')`, [run]);
    const amanda = await line(W1, people.amanda);
    expect(amanda.status).toBe("paid");
    expect(amanda.paid_at).not.toBeNull();
    expect(await line(W1, people.marjorie)).toMatchObject({ status: "draft", paid_at: null });
    const r = (await db.query<{ status: string; paid_at: string | null }>(`select status, paid_at from pay_runs where id = $1`, [run])).rows[0];
    expect(r.status).toBe("paid");
    expect(r.paid_at).not.toBeNull();
    await build(W1);
    expect((await line(W1, people.amanda)).gross).toBe(122);
    await expect(db.query(`delete from pay_run_lines where id = $1`, [amanda.id])).rejects.toThrow();
  });
});

describe("feeds for the Overview", () => {
  it("payroll_cost sums approved and paid lines on approved or paid runs by week end; null when there are none", async () => {
    const cost = async (from: string, to: string) =>
      num((await db.query<{ c: string | null }>(`select payroll_cost($1::date, $2::date) as c`, [from, to])).rows[0].c);
    // W1 (ends 13 Sep, paid): Amanda 102 + Aditya 0 + Freddie 0. Marjorie's draft 40 is not a cost yet.
    expect(await cost("2026-09-07", "2026-09-13")).toBe(102);
    expect(await cost("2026-09-14", "2026-09-20")).toBeNull(); // W2 is still a draft
    await db.query(`select approve_pay_run(id) from pay_runs where week_start = $1::date`, [W2]);
    expect(await cost("2026-09-14", "2026-09-20")).toBe(150); // Freddie's remaining job
    expect(await cost("2026-09-01", "2026-09-30")).toBe(252);
    expect(await cost("2025-01-01", "2025-01-31")).toBeNull();
  });

  it("team_cost_pct is payroll over classified paid Whop cash; null when either side is missing", async () => {
    const pct = async (from: string, to: string) =>
      num((await db.query<{ p: string | null }>(`select team_cost_pct($1::date, $2::date) as p`, [from, to])).rows[0].p);
    expect(await pct("2026-09-01", "2026-09-30")).toBeNull(); // no cash
    await db.query(
      `insert into payments (whop_payment_id, amount, paid_at, product_title, status) values
         ('pay_1', 1000, '2026-09-10 15:00+00', 'Genexa 90 day', 'paid'),
         ('pay_2', 5000, '2026-09-11 15:00+00', null, 'paid'),
         ('pay_3', 5000, '2026-09-12 15:00+00', 'Genexa 90 day', 'open'),
         ('pay_4', 5000, '2026-11-01 15:00+00', 'Genexa 90 day', 'paid')`);
    expect(await pct("2026-09-01", "2026-09-30")).toBe(25.2); // 252 ÷ 1,000
    expect(await pct("2026-11-01", "2026-11-30")).toBeNull(); // cash, no payroll
  });
});

describe("owner only", () => {
  const TABLES = ["staff_pay", "pay_runs", "pay_run_lines", "freelance_jobs", "payroll_days", "payroll_setup_gaps", "pay_run_totals"];
  const counts = async () => {
    const out: Record<string, number> = {};
    for (const t of TABLES) out[t] = Number((await db.query<{ n: string }>(`select count(*) as n from ${t}`)).rows[0].n);
    return out;
  };

  it("a non-owner reads zero rows from every payroll table and view, and cannot write or build", async () => {
    for (const who of [AUTH.amanda, AUTH.aditya, AUTH.sameer]) {
      await asUser(db, who, async () => {
        expect(await counts()).toEqual(Object.fromEntries(TABLES.map((t) => [t, 0])));
        expect((await db.query<{ c: string | null }>(`select payroll_cost('2026-01-01', '2026-12-31') as c`)).rows[0].c).toBeNull();
        expect((await db.query<{ p: string | null }>(`select team_cost_pct('2026-01-01', '2026-12-31') as p`)).rows[0].p).toBeNull();
        await expect(db.query(`select build_pay_run('2026-07-06')`)).rejects.toThrow(/row-level security/);
        await expect(db.query(`insert into freelance_jobs (staff_id, date, description, amount) values ($1, '2026-09-14', 'x', 1)`, [freddie])).rejects.toThrow(/row-level security/);
        await db.query(`update pay_run_lines set adjustment = 999, adjustment_reason = 'mine'`);
        expect(Number((await db.query<{ n: string }>(`select approve_pay_run(id) as n from pay_runs`)).rows.length)).toBe(0);
      });
    }
    expect(Number((await db.query<{ n: string }>(`select count(*) as n from pay_run_lines where adjustment = 999`)).rows[0].n)).toBe(0);
    expect((await db.query(`select 1 from pay_runs where week_start = '2026-07-06'`)).rows.length).toBe(0);
  });

  it("the owner reads all of it and can build a run", async () => {
    await asUser(db, AUTH.ryan, async () => {
      const c = await counts();
      for (const t of TABLES) expect(c[t], t).toBeGreaterThan(0);
      expect(num((await db.query<{ c: string }>(`select payroll_cost('2026-09-01', '2026-09-30') as c`)).rows[0].c)).toBe(252);
      await db.query(`select build_pay_run('2026-07-06')`);
    });
    expect((await db.query(`select 1 from pay_runs where week_start = '2026-07-06'`)).rows.length).toBe(1);
  });

  it("each payroll table has the owner policy and nothing else", async () => {
    const policies = (await db.query<{ tablename: string; policyname: string }>(
      `select tablename, policyname from pg_policies where tablename in ('staff_pay', 'pay_runs', 'pay_run_lines', 'freelance_jobs') order by 1, 2`)).rows;
    expect(policies).toEqual(["freelance_jobs", "pay_run_lines", "pay_runs", "staff_pay"].map((tablename) => ({ tablename, policyname: "owner_all" })));
  });
});

describe("pay-run job", () => {
  const sent: { to: string; text: string }[] = [];
  let failNext = false;
  const send = async (to: string, text: string): Promise<SendResult> => {
    if (failNext) return { ok: false, error: "channel_not_found" };
    sent.push({ to, text });
    return { ok: true, ts: "1700000000.0001", channel: "D_OWNER" };
  };
  /** The same four operations as the Supabase store, straight against the test database. */
  const store = (): PayRunStore => ({
    async build(weekStart) {
      const runId = await build(weekStart);
      const t = (await db.query<{ total: string; people: string; flag_count: number }>(`select total, people, flag_count from pay_run_totals where id = $1`, [runId])).rows[0];
      return { runId, total: Number(t.total), people: Number(t.people), flags: Number(t.flag_count) };
    },
    async owner() {
      const r = (await db.query<{ id: string; slack_user_id: string | null }>(`select id, slack_user_id from staff where id = app_role_holder('owner')`)).rows[0];
      return r ? { id: r.id, slackUserId: r.slack_user_id } : null;
    },
    async claim(runId, staffId) {
      try {
        const r = await db.query<{ id: string }>(
          `insert into notifications (rule_key, staff_id, record_type, record_id) values ('pay_run_ready', $1, 'pay_runs', $2) returning id`, [staffId, runId]);
        return { id: r.rows[0].id, sent: false };
      } catch (err) {
        if (!/duplicate key/.test((err as Error).message)) throw err;
        const r = await db.query<{ id: string; sent_at: string | null }>(
          `select id, sent_at from notifications where rule_key = 'pay_run_ready' and staff_id = $1 and record_id = $2`, [staffId, runId]);
        return { id: r.rows[0].id, sent: r.rows[0].sent_at !== null };
      }
    },
    async markSent(id, ts, channel) {
      await db.query(`update notifications set sent_at = now(), slack_ts = $2, channel = $3 where id = $1`, [id, ts, channel]);
    },
  });
  const run = (today: string) => runPayRunJob({ store: store(), send, today, appUrl: "https://ops.example.test" });

  it("builds the week ending on the coming Sunday and DMs the owner once", async () => {
    await day(people.amanda, "2026-08-10", { in: "09:00", out: "17:00", status: "on_time" }); // 8h × $10
    const first = await run("2026-08-12"); // a Wednesday
    expect(first.summary).toMatchObject({ week_start: "2026-08-10", total: 80, people: 1, flags: 1, notified: "sent" });
    expect(sent).toEqual([{ to: "U_OWNER", text: "Pay run ready: $80.00 across 1 person, 1 flag\nhttps://ops.example.test/payroll?week=2026-08-10" }]);
    const notes = (await db.query<{ record_type: string; record_id: string; sent_at: string | null; slack_ts: string }>(
      `select record_type, record_id, sent_at, slack_ts from notifications where rule_key = 'pay_run_ready'`)).rows;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ record_type: "pay_runs", record_id: first.summary.run_id, slack_ts: "1700000000.0001" });
    expect(notes[0].sent_at).not.toBeNull();
  });

  it("a second run in the same week rebuilds the draft but does not send again", async () => {
    const again = await run("2026-08-16"); // the Sunday itself: same week
    expect(again.summary).toMatchObject({ week_start: "2026-08-10", notified: "already_sent" });
    expect(sent).toHaveLength(1);
    expect((await db.query(`select 1 from notifications where rule_key = 'pay_run_ready'`)).rows.length).toBe(1);
  });

  it("a failed send is recorded unsent and goes out on the next run", async () => {
    failNext = true;
    expect((await run("2026-08-05")).summary.notified).toBe("failed:channel_not_found");
    failNext = false;
    expect((await run("2026-08-05")).summary.notified).toBe("sent");
    expect((await run("2026-08-05")).summary.notified).toBe("already_sent");
    expect(sent).toHaveLength(2);
  });

  it("words the message for any count", () => {
    expect(payRunMessage({ runId: "r", total: 3412.5, people: 6, flags: 0 }, "2026-10-05", "https://ops.genexascaling.com"))
      .toBe("Pay run ready: $3,412.50 across 6 people, 0 flags\nhttps://ops.genexascaling.com/payroll?week=2026-10-05");
  });
});

describe("migration 0026 on existing staff", () => {
  it("sets pay types by role and name, keeps CSR rates and creates missing pay rows", async () => {
    const dir = join(__dirname, "../../supabase/migrations");
    const old = new PGlite({ extensions: { pg_trgm } });
    await old.exec(readFileSync(join(__dirname, "supabase_shim.sql"), "utf8"));
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files.filter((f) => f < "0026")) await old.exec(readFileSync(join(dir, f), "utf8"));
    const p = await seedStaff(old);
    await old.query(`insert into staff (name, role) values ('Freddie Lance', 'freelance'), ('Sameer Khan', 'csr')`);
    await old.query(`insert into staff_pay (staff_id, hourly_rate) values ($1, 4.5)`, [p.amanda]);
    await old.exec(readFileSync(join(dir, "0026_payroll.sql"), "utf8"));
    const rows = (await old.query<{ name: string; pay_type: string | null; hourly_rate: string | null; monthly_amount: string | null }>(
      `select s.name, sp.pay_type, sp.hourly_rate, sp.monthly_amount from staff s left join staff_pay sp on sp.staff_id = s.id order by s.name`)).rows;
    expect(rows.map((r) => [r.name, r.pay_type, num(r.hourly_rate), num(r.monthly_amount)])).toEqual([
      ["Aditya", "fixed_monthly", null, 2000],
      ["Amanda Harder", "hourly", 4.5, null],
      ["Freddie Lance", "freelance", null, null],
      ["Marjorie Grace Villarino", "hourly", null, null],
      ["Ryan", null, null, null],
      ["Sameer", "fixed_monthly", null, 1000],
      ["Sameer Khan", "hourly", null, null], // a CSR who shares the first name stays hourly
    ]);
    await old.close();
  });
});
