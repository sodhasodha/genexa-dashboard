import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { AUTH, asUser, freshDb, seedStaff, type TestPeople } from "./db";

let db: PGlite;
let people: TestPeople;

const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];

beforeAll(async () => {
  db = await freshDb();
  people = await seedStaff(db);
});

describe("task_list", () => {
  it("counts days overdue in ET for open tasks only, and never for done or undated ones", async () => {
    const c = await one<{ id: string }>(`insert into clients (name) values ('Task Clinic') returning id`);
    await db.query(
      `insert into tasks (owner_id, title, due, client_id, source) values
         ($1, 'Late by three', app_today() - 3, $2, 'ryan'),
         ($1, 'Due today', app_today(), null, 'ryan'),
         ($1, 'Due tomorrow', app_today() + 1, null, 'ryan'),
         ($1, 'No date', null, null, 'ryan')`,
      [people.sameer, c.id],
    );
    // Sameer's dated tasks get a 17:00 deadline (0047). Pin today's to the last minute of the ET day,
    // so the overdue count below does not depend on the hour the suite runs at.
    await db.query(`update tasks set due_at = ((app_today() + 1)::timestamp at time zone 'America/New_York') - interval '1 minute' where title = 'Due today'`);
    await db.query(`insert into tasks (owner_id, title, due, status, source) values ($1, 'Late but done', app_today() - 9, 'done', 'ryan')`, [people.sameer]);
    const rows = (
      await db.query<{ title: string; days_overdue: number | null; client_name: string | null; task_group: string }>(
        `select title, days_overdue, client_name, task_group from task_list where owner_id = $1 order by title`,
        [people.sameer],
      )
    ).rows;
    const by = Object.fromEntries(rows.map((r) => [r.title, r]));
    expect(by["Late by three"].days_overdue).toBe(3);
    expect(by["Late by three"].client_name).toBe("Task Clinic");
    expect(by["Due today"].days_overdue).toBeNull();
    expect(by["Due tomorrow"].days_overdue).toBeNull();
    expect(by["No date"].days_overdue).toBeNull();
    expect(by["Late but done"].days_overdue).toBeNull();
    expect(by["Late but done"].task_group).toBe("done");
  });

  it("carries the parent's title for a subtask and hides soft-deleted tasks", async () => {
    const parent = await one<{ id: string }>(`insert into tasks (owner_id, title, source) values ($1, 'Parent job', 'ryan') returning id`, [people.amanda]);
    await db.query(`insert into tasks (owner_id, title, parent_task_id, source) values ($1, 'Child job', $2, 'ryan')`, [people.amanda, parent.id]);
    const gone = await one<{ id: string }>(`insert into tasks (owner_id, title, source) values ($1, 'Remove me', 'ryan') returning id`, [people.amanda]);
    await db.query(`update tasks set deleted_at = now() where id = $1`, [gone.id]);

    const rows = (await db.query<{ title: string; parent_title: string | null }>(`select title, parent_title from task_list where owner_id = $1 order by title`, [people.amanda])).rows;
    expect(rows).toEqual([
      { title: "Child job", parent_title: "Parent job" },
      { title: "Parent job", parent_title: null },
    ]);
    const d = await one<{ title: string }>(`select title from deleted_tasks where owner_id = $1`, [people.amanda]);
    expect(d.title).toBe("Remove me");
  });

  it("ranks done tasks newest first per owner, so the page can show the latest 30", async () => {
    for (let i = 1; i <= 32; i++) {
      await db.query(
        `insert into tasks (owner_id, title, status, done_at, source) values ($1, $2, 'done', now() - make_interval(days => $3), 'ryan')`,
        [people.marjorie, `Done ${i}`, i],
      );
    }
    await db.query(`insert into tasks (owner_id, title, source) values ($1, 'Still open', 'ryan')`, [people.marjorie]);
    const shown = (
      await db.query<{ title: string; done_rank: number | null }>(
        `select title, done_rank::int as done_rank from task_list where owner_id = $1 and (done_rank is null or done_rank <= 30) order by done_rank nulls first`,
        [people.marjorie],
      )
    ).rows;
    expect(shown.length).toBe(31);
    expect(shown[0]).toEqual({ title: "Still open", done_rank: null });
    expect(shown[1]).toEqual({ title: "Done 1", done_rank: 1 });
    expect(shown[30]).toEqual({ title: "Done 30", done_rank: 30 });
  });

  it("task_owners counts open, overdue and done per person, and leaves out people who left", async () => {
    const m = await one<{ open_tasks: number; overdue_tasks: number; done_tasks: number }>(
      `select open_tasks::int, overdue_tasks::int, done_tasks::int from task_owners where owner_id = $1`,
      [people.marjorie],
    );
    expect(m).toEqual({ open_tasks: 1, overdue_tasks: 0, done_tasks: 32 });
    const s = await one<{ open_tasks: number; overdue_tasks: number; done_tasks: number }>(
      `select open_tasks::int, overdue_tasks::int, done_tasks::int from task_owners where owner_id = $1`,
      [people.sameer],
    );
    expect(s).toEqual({ open_tasks: 4, overdue_tasks: 1, done_tasks: 1 });
    const r = await one<{ open_tasks: number }>(`select open_tasks::int from task_owners where owner_id = $1`, [people.ryan]);
    expect(r.open_tasks).toBe(0);

    const left = await one<{ id: string }>(`insert into staff (name, role, status) values ('Gone Person', 'csr', 'left') returning id`);
    const n = await one<{ n: number }>(`select count(*)::int as n from task_owners where owner_id = $1`, [left.id]);
    expect(n.n).toBe(0);
  });
});

describe("task rules through a staff login", () => {
  it("staff can add to their own or a colleague's list, never to Ryan's", async () => {
    await asUser(db, AUTH.amanda, async () => {
      await db.query(`insert into tasks (owner_id, title, source) values ($1, 'My own task', 'staff')`, [people.amanda]);
      // Sameer's tasks need a date and time deadline (0047): a person adding one without it is refused.
      await expect(db.query(`insert into tasks (owner_id, title, source) values ($1, 'For Sameer', 'staff')`, [people.sameer])).rejects.toThrow(/TASK_DEADLINE_REQUIRED/);
      await db.query(`insert into tasks (owner_id, title, source, due_at) values ($1, 'For Sameer', 'staff', now() + interval '3 days')`, [people.sameer]);
      await expect(db.query(`insert into tasks (owner_id, title, source) values ($1, 'For Ryan', 'staff')`, [people.ryan])).rejects.toThrow(/TASK_OWNER_LIST/);
      await expect(
        db.query(`insert into tasks (owner_id, title, category, source) values ($1, 'Tech thing', 'tech', 'staff')`, [people.aditya]),
      ).rejects.toThrow(/TASK_CATEGORY/);
    });
    await asUser(db, AUTH.ryan, async () => {
      await db.query(`insert into tasks (owner_id, title, source) values ($1, 'Ryan adds his own', 'ryan')`, [people.ryan]);
    });
  });

  it("staff can change status and group on their own task, but not edit, delete or touch someone else's", async () => {
    const mine = await one<{ id: string }>(`select id from tasks where title = 'My own task'`);
    const theirs = await one<{ id: string }>(`select id from tasks where title = 'For Sameer'`);
    await asUser(db, AUTH.amanda, async () => {
      const moved = await db.query(`update tasks set task_group = 'today' where id = $1 returning id`, [mine.id]);
      expect(moved.rows.length).toBe(1);
      const done = await db.query<{ task_group: string }>(`update tasks set status = 'done' where id = $1 returning task_group`, [mine.id]);
      expect(done.rows[0].task_group).toBe("done");
      await expect(db.query(`update tasks set title = 'Renamed' where id = $1`, [mine.id])).rejects.toThrow(/TASK_STATUS_ONLY/);
      await expect(db.query(`update tasks set deleted_at = now() where id = $1`, [mine.id])).rejects.toThrow(/TASK_STATUS_ONLY/);
      const other = await db.query(`update tasks set status = 'done' where id = $1 returning id`, [theirs.id]);
      expect(other.rows.length).toBe(0);
    });
    await asUser(db, AUTH.ryan, async () => {
      const r = await db.query(`update tasks set title = 'Renamed by Ryan', deleted_at = now() where id = $1 returning id`, [theirs.id]);
      expect(r.rows.length).toBe(1);
    });
  });
});

describe("prospect_follow_ups", () => {
  it("lists only late follow-ups still being worked, with days overdue, most overdue first", async () => {
    await db.query(
      `insert into prospects (name, stage, follow_up_date, promised) values
         ('Late chase', 'chase', app_today() - 2, 'Send case studies'),
         ('Very late contract', 'contract_out', app_today() - 10, 'Resend contract'),
         ('Due today', 'chase', app_today(), null),
         ('Future', 'chase', app_today() + 5, null),
         ('No date', 'chase', null, null),
         ('Late but paid', 'paid', app_today() - 30, null),
         ('Late but dead', 'dead', app_today() - 30, null)`,
    );
    await db.query(`insert into prospect_contacts (prospect_id, contact) select id, 'late@clinic.test' from prospects where name = 'Late chase'`);
    await db.query(`insert into prospects (name, stage, follow_up_date, deleted_at) values ('Late but deleted', 'chase', app_today() - 4, now())`);
    const rows = (await db.query<{ name: string; days_overdue: number; promised: string | null }>(
      `select name, days_overdue, promised from prospect_follow_ups order by days_overdue desc`,
    )).rows;
    expect(rows).toEqual([
      { name: "Very late contract", days_overdue: 10, promised: "Resend contract" },
      { name: "Late chase", days_overdue: 2, promised: "Send case studies" },
    ]);
    const cols = (await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'prospect_follow_ups'`,
    )).rows.map((r) => r.column_name);
    expect(cols).not.toContain("contact");
  });

  it("is readable by staff through RLS", async () => {
    await asUser(db, AUTH.sameer, async () => {
      const n = await one<{ n: number }>(`select count(*)::int as n from prospect_follow_ups`);
      expect(n.n).toBe(2);
    });
  });
});

describe("ideas and prospects: who may write", () => {
  it("a non-owner staff member can add an idea but cannot edit a prospect", async () => {
    await asUser(db, AUTH.amanda, async () => {
      await db.query(`insert into ideas (text, source) values ('Text reminders the night before consults', 'Amanda')`);
      const edit = await db.query(`update prospects set stage = 'paid', follow_up_date = null returning id`);
      expect(edit.rows.length).toBe(0);
      await expect(db.query(`insert into prospects (name) values ('Sneaky prospect')`)).rejects.toThrow(/row-level security/);
    });
    const idea = await one<{ text: string; source: string | null }>(`select text, source from idea_list`);
    expect(idea).toEqual({ text: "Text reminders the night before consults", source: "Amanda" });
    const stages = await one<{ n: number }>(`select count(*)::int as n from prospects where stage = 'paid' and name <> 'Late but paid'`);
    expect(stages.n).toBe(0);
    const audit = await one<{ actor: string }>(`select actor from audit_log where table_name = 'ideas' order by at desc limit 1`);
    expect(audit.actor).toBe("Amanda Harder");
  });

  it("staff cannot edit or soft-delete an idea, or add one that is already deleted; the owner can", async () => {
    await asUser(db, AUTH.amanda, async () => {
      expect((await db.query(`update ideas set deleted_at = now() returning id`)).rows.length).toBe(0);
      expect((await db.query(`update ideas set text = 'changed' returning id`)).rows.length).toBe(0);
      await expect(db.query(`insert into ideas (text, deleted_at) values ('Hidden', now())`)).rejects.toThrow(/row-level security/);
    });
    await asUser(db, AUTH.ryan, async () => {
      await db.query(`insert into ideas (text) values ('Owner idea')`);
      const r = await db.query(`update ideas set deleted_at = now() where text = 'Owner idea' returning id`);
      expect(r.rows.length).toBe(1);
      const p = await db.query(`update prospects set stage = 'contract_out' where name = 'Late chase' returning id`);
      expect(p.rows.length).toBe(1);
    });
    const n = await one<{ n: number }>(`select count(*)::int as n from idea_list`);
    expect(n.n).toBe(1);
  });

  it("someone with no staff record cannot add an idea", async () => {
    await asUser(db, "00000000-0000-0000-0000-0000000000ff", async () => {
      await expect(db.query(`insert into ideas (text) values ('Outsider')`)).rejects.toThrow(/row-level security/);
    });
  });
});
