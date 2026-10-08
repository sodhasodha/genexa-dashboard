import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { AUTH, asUser, freshDb, seedStaff, type TestPeople } from "./db";
import { runReminders, type Rpc, type SendResult } from "@/lib/reminders/engine";
import { handleInteraction } from "@/lib/reminders/interaction";
import type { Block } from "@/lib/reminders/compose";

// Closing a prospect follow-up without doing it: "Not following up", "Follow up later", undo,
// who may do it, and what it does to reminders. In-process Postgres, a fake Slack, a set clock.
let db: PGlite;
let people: TestPeople;
let sent: { target: string; text: string; blocks: Block[] }[];

const APP = "https://ops.test";
const rpc: Rpc = async <T>(fn: string, args: Record<string, unknown> = {}) => {
  const keys = Object.keys(args);
  const r = await db.query<{ r: T }>(`select ${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]));
  return r.rows[0].r;
};
const send = async (target: string, text: string, blocks: Block[] = []): Promise<SendResult> => {
  sent.push({ target, text, blocks });
  return { ok: true, ts: `${sent.length}.000`, channel: `D_${target}` };
};
const run = (now: string) => runReminders({ rpc, send, appUrl: APP, now: new Date(now) });
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const LONDON_TODAY = `(now() at time zone 'Europe/London')::date`;
/** An instant: London day (today + offset) at HH:MM London. */
const london = async (dayOffset: number, time: string) =>
  (await one<{ t: Date }>(`select ((${LONDON_TODAY} + $1::int + $2::time) at time zone 'Europe/London') as t`, [dayOffset, time])).t.toISOString();
const plus = (iso: string, minutes: number) => new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
const followUpDms = () => sent.filter((m) => m.target === "U_ryan" && m.text.startsWith("Prospect follow-up"));
const digests = () => sent.filter((m) => m.target === "U_ryan" && m.text.startsWith("Morning digest"));

type Result = { result: string; name?: string; stage?: string; reason?: string; date?: string; actor?: string; follow_up_date?: string | null };
type ProspectRow = { stage: string; follow_up_date: string | null };
/** A prospect; `due` is a SQL date expression. */
const prospect = async (name: string, due: string | null = "app_today() - 2", stage = "chase") =>
  (await one<{ id: string }>(`insert into prospects (name, promised, follow_up_date, stage) values ($1, 'Send the deck', ${due ?? "null"}, $2) returning id`, [name, stage])).id;
const state = (id: string) => one<ProspectRow>(`select stage, follow_up_date::text from prospects where id = $1`, [id]);
const day = async (expr: string) => (await one<{ d: string }>(`select (${expr})::text as d`)).d;
const call = (sql: string, params: unknown[] = []) => one<{ r: Result }>(`select ${sql} as r`, params).then((x) => x.r);
const decisions = (id: string) =>
  db.query<{ kind: string; reason: string | null; reason_text: string | null; previous_stage: string; previous: string | null; next: string | null; source: string; undone: boolean; by: string }>(
    `select d.kind, d.reason, d.reason_text, d.previous_stage, d.previous_follow_up_date::text as previous, d.new_follow_up_date::text as next,
            d.source, d.undone_at is not null as undone, s.name as by
     from prospect_follow_up_decisions d join staff s on s.id = d.decided_by where d.prospect_id = $1 order by d.decided_at, d.created_at`, [id]).then((r) => r.rows);

beforeAll(async () => {
  db = await freshDb();
});

beforeEach(async () => {
  await db.exec(`
    truncate staff, clients, notifications, audit_log, prospects, exceptions cascade;
    update integration_sync_status set last_success_at = null, last_attempt_at = null, error = null, status = 'stale';
    select set_config('app.actor', '', false);`);
  people = await seedStaff(db);
  sent = [];
  await db.query(`update staff set slack_user_id = 'U_' || split_part(email, '@', 1)`);
  await db.query(`update reminder_rules set enabled = false where key = 'weekly_scorecard'`);
  await db.query(`update app_settings set value = null where key = 'go_live_date'`);
});

describe("Not following up", () => {
  it("moves the prospect to Dead, clears the date, stores the reason and names the owner in the audit trail", async () => {
    const id = await prospect("Cold Clinic", "app_today() - 2", "contract_out");
    const was = await day("app_today() - 2");
    const r = await asUser(db, AUTH.ryan, () => call(`prospect_not_following_up($1, 'gone_cold')`, [id]));
    expect(r).toMatchObject({ result: "not_following_up", name: "Cold Clinic", reason: "gone_cold" });
    expect(await state(id)).toEqual({ stage: "dead", follow_up_date: null });
    expect(await decisions(id)).toEqual([
      { kind: "not_following_up", reason: "gone_cold", reason_text: null, previous_stage: "contract_out", previous: was, next: null, source: "app", undone: false, by: "Ryan" },
    ]);
    const audit = await one<{ actor: string; old_value: string; new_value: string }>(
      `select actor, old_value, new_value from audit_log where table_name = 'prospects' and row_id = $1 and field = 'stage'`, [id]);
    expect(audit).toEqual({ actor: "Ryan", old_value: "contract_out", new_value: "dead" });
    // Nothing about it still needs action.
    expect((await db.query(`select 1 from prospect_follow_ups where id = $1`, [id])).rows).toEqual([]);
  });

  it("needs a reason, and Other needs its text", async () => {
    const id = await prospect("Picky Clinic");
    await asUser(db, AUTH.ryan, async () => {
      expect((await call(`prospect_not_following_up($1, null)`, [id])).result).toBe("invalid_reason");
      expect((await call(`prospect_not_following_up($1, 'bored')`, [id])).result).toBe("invalid_reason");
      expect((await call(`prospect_not_following_up($1, 'other')`, [id])).result).toBe("reason_text_required");
      expect((await call(`prospect_not_following_up($1, 'other', '   ')`, [id])).result).toBe("reason_text_required");
    });
    expect((await state(id)).stage).toBe("chase");
    expect(await decisions(id)).toEqual([]);

    const r = await asUser(db, AUTH.ryan, () => call(`prospect_not_following_up($1, 'other', ' Sold the practice ')`, [id]));
    expect(r.result).toBe("not_following_up");
    expect((await decisions(id))[0]).toMatchObject({ reason: "other", reason_text: "Sold the practice" });
    // The table itself refuses "other" with no text, however the row is written.
    await expect(db.query(
      `insert into prospect_follow_up_decisions (prospect_id, kind, reason, previous_stage, decided_by) values ($1, 'not_following_up', 'other', 'chase', $2)`,
      [id, people.ryan])).rejects.toThrow(/check constraint/);
  });

  it("does nothing to a prospect that is already paid or dead, or that does not exist", async () => {
    const paid = await prospect("Paid Clinic", "app_today() - 5", "paid");
    const dead = await prospect("Dead Clinic", null, "dead");
    await asUser(db, AUTH.ryan, async () => {
      expect(await call(`prospect_not_following_up($1, 'not_a_fit')`, [paid])).toMatchObject({ result: "not_open", stage: "paid" });
      expect(await call(`prospect_follow_up_later($1, app_today() + 3)`, [dead])).toMatchObject({ result: "not_open", stage: "dead" });
      expect((await call(`prospect_not_following_up('00000000-0000-4000-8000-000000000000', 'not_a_fit')`)).result).toBe("not_found");
    });
    expect((await state(paid)).stage).toBe("paid");
    expect(await decisions(paid)).toEqual([]);
  });
});

describe("Follow up later", () => {
  it("sets a new date after today (ET) and leaves the stage alone", async () => {
    const id = await prospect("Later Clinic", "app_today() - 4", "contract_out");
    await asUser(db, AUTH.ryan, async () => {
      expect((await call(`prospect_follow_up_later($1, app_today())`, [id])).result).toBe("date_not_future");
      expect((await call(`prospect_follow_up_later($1, app_today() - 1)`, [id])).result).toBe("date_not_future");
      expect((await call(`prospect_follow_up_later($1, null)`, [id])).result).toBe("date_not_future");
    });
    expect(await state(id)).toEqual({ stage: "contract_out", follow_up_date: await day("app_today() - 4") });

    const next = await day("app_today() + 1");
    const r = await asUser(db, AUTH.ryan, () => call(`prospect_follow_up_later($1, app_today() + 1)`, [id]));
    expect(r).toMatchObject({ result: "follow_up_later", name: "Later Clinic", date: next });
    expect(await state(id)).toEqual({ stage: "contract_out", follow_up_date: next });
    expect(await decisions(id)).toEqual([
      { kind: "follow_up_later", reason: null, reason_text: null, previous_stage: "contract_out", previous: await day("app_today() - 4"), next, source: "app", undone: false, by: "Ryan" },
    ]);
    expect((await db.query(`select 1 from prospect_follow_ups where id = $1`, [id])).rows).toEqual([]);
  });
});

describe("Undo", () => {
  it("puts the stage and the follow-up date back, one decision at a time", async () => {
    const id = await prospect("Undo Clinic", "app_today() - 3", "contract_out");
    const original = await day("app_today() - 3");
    const moved = await day("app_today() + 5");
    await asUser(db, AUTH.ryan, async () => {
      await call(`prospect_follow_up_later($1, app_today() + 5)`, [id]);
      await call(`prospect_not_following_up($1, 'went_elsewhere')`, [id]);
    });
    expect(await state(id)).toEqual({ stage: "dead", follow_up_date: null });
    // Only the latest decision offers an undo.
    const undoable = async () =>
      (await db.query<{ kind: string }>(`select kind from prospect_follow_up_decision_log where prospect_id = $1 and is_undoable`, [id])).rows.map((r) => r.kind);
    expect(await undoable()).toEqual(["not_following_up"]);

    const first = await asUser(db, AUTH.ryan, () => call(`prospect_follow_up_undo($1)`, [id]));
    expect(first).toMatchObject({ result: "undone", stage: "contract_out", follow_up_date: moved });
    expect(await state(id)).toEqual({ stage: "contract_out", follow_up_date: moved });
    expect(await undoable()).toEqual(["follow_up_later"]);

    const second = await asUser(db, AUTH.ryan, () => call(`prospect_follow_up_undo($1)`, [id]));
    expect(second).toMatchObject({ result: "undone", stage: "contract_out", follow_up_date: original });
    expect(await state(id)).toEqual({ stage: "contract_out", follow_up_date: original });
    // Late again, so it needs action again.
    expect((await one<{ days_overdue: number }>(`select days_overdue from prospect_follow_ups where id = $1`, [id])).days_overdue).toBe(3);

    expect((await decisions(id)).map((d) => d.undone)).toEqual([true, true]);
    const log = await one<{ undone_by_name: string }>(`select undone_by_name from prospect_follow_up_decision_log where prospect_id = $1 limit 1`, [id]);
    expect(log.undone_by_name).toBe("Ryan");
    expect((await asUser(db, AUTH.ryan, () => call(`prospect_follow_up_undo($1)`, [id]))).result).toBe("nothing_to_undo");
    // Decisions are kept: nothing is ever deleted.
    await expect(db.query(`delete from prospect_follow_up_decisions where prospect_id = $1`, [id])).rejects.toThrow(/Hard deletes are not allowed/);
  });

  it("never overwrites a change made by hand after the decision", async () => {
    const id = await prospect("Revived Clinic");
    await asUser(db, AUTH.ryan, async () => {
      await call(`prospect_not_following_up($1, 'gone_cold')`, [id]);
      // Ryan moves it back himself and sets a new date.
      await db.query(`update prospects set stage = 'contract_out', follow_up_date = app_today() + 9 where id = $1`, [id]);
      expect((await call(`prospect_follow_up_undo($1)`, [id])).result).toBe("nothing_to_undo");
    });
    expect(await state(id)).toEqual({ stage: "contract_out", follow_up_date: await day("app_today() + 9") });
  });
});

describe("who may decide", () => {
  it("staff are refused by the functions and by row level security, but can read the history", async () => {
    const id = await prospect("Guarded Clinic");
    await asUser(db, AUTH.ryan, () => call(`prospect_follow_up_later($1, app_today() + 2)`, [id]));
    const before = await state(id);
    await asUser(db, AUTH.aditya, async () => {
      expect((await call(`prospect_not_following_up($1, 'not_a_fit')`, [id])).result).toBe("refused");
      expect((await call(`prospect_follow_up_later($1, app_today() + 7)`, [id])).result).toBe("refused");
      expect((await call(`prospect_follow_up_undo($1)`, [id])).result).toBe("refused");
      // Naming the owner as the actor does not help a logged-in member of staff.
      expect((await call(`prospect_not_following_up($1, 'not_a_fit', null, $2)`, [id, people.ryan])).result).toBe("refused");
      await expect(db.query(
        `insert into prospect_follow_up_decisions (prospect_id, kind, reason, previous_stage, decided_by) values ($1, 'not_following_up', 'not_a_fit', 'chase', $2)`,
        [id, people.aditya])).rejects.toThrow(/row-level security/);
      expect((await db.query(`update prospect_follow_up_decisions set undone_at = now(), undone_by = $1 returning id`, [people.aditya])).rows).toEqual([]);
      await expect(db.query(`select slack_prospect_action('U_ryan', 'not_following_up', $1, 'not_a_fit')`, [id])).rejects.toThrow(/permission denied/);
      expect((await db.query(`select 1 from prospect_follow_up_decision_log where prospect_id = $1`, [id])).rows.length).toBe(1);
    });
    expect(await state(id)).toEqual(before);
    expect((await decisions(id)).length).toBe(1);
  });

  it("the server must name an actor, and the actor must be the app owner", async () => {
    const id = await prospect("Server Clinic");
    expect((await call(`prospect_not_following_up($1, 'not_a_fit')`, [id])).result).toBe("refused");
    expect((await call(`prospect_not_following_up($1, 'not_a_fit', null, $2)`, [id, people.sameer])).result).toBe("refused");
    expect((await state(id)).stage).toBe("chase");
    expect((await call(`prospect_not_following_up($1, 'not_a_fit', null, $2)`, [id, people.ryan])).result).toBe("not_following_up");
    const audit = await one<{ actor: string }>(`select actor from audit_log where table_name = 'prospects' and row_id = $1 and field = 'stage'`, [id]);
    expect(audit.actor).toBe("Ryan");
    expect((await call(`prospect_follow_up_undo($1, $2)`, [id, people.ryan])).result).toBe("undone");
  });
});

describe("from Slack", () => {
  const blockId = (id: string) => `act:prospects:${id}`;
  const choose = (who: string, id: string, reason: string, blocks: Block[] = []) =>
    handleInteraction({ type: "block_actions", user: { id: who }, actions: [{ action_id: "prospect_not_following_up", block_id: blockId(id), selected_option: { value: reason } }], message: { text: "x", blocks } }, { rpc });
  const pick = (who: string, id: string, date: string, blocks: Block[] = []) =>
    handleInteraction({ type: "block_actions", user: { id: who }, actions: [{ action_id: "prospect_follow_up_later", block_id: blockId(id), selected_date: date }], message: { text: "x", blocks } }, { rpc });

  it("the reminder carries both controls and no contact details; choosing a reason closes the follow-up", async () => {
    const id = await prospect("Slack Clinic", `${LONDON_TODAY} - 2`);
    await db.query(`insert into prospect_contacts (prospect_id, contact) values ($1, 'dr@slack.test 555-0199')`, [id]);
    await run(await london(0, "07:10"));
    const dm = followUpDms();
    expect(dm.length).toBe(1);
    expect(dm[0].text).toContain("Slack Clinic");
    expect(dm[0].text).toContain("promised: Send the deck");
    expect(JSON.stringify(sent)).not.toContain("555-0199");
    expect(JSON.stringify(sent)).not.toContain("dr@slack.test");
    const controls = dm[0].blocks.filter((b) => b.type === "actions");
    expect(controls.map((b) => b.block_id)).toEqual([blockId(id)]);
    expect((controls[0].elements as { type: string; action_id: string }[]).map((e) => [e.type, e.action_id])).toEqual([
      ["static_select", "prospect_not_following_up"], ["datepicker", "prospect_follow_up_later"]]);

    const reply = await choose("U_ryan", id, "other", dm[0].blocks);
    expect(reply.replace_original).toBe(true);
    expect(reply.text).toContain("Not following up (Other)");
    expect(reply.text).toContain("by Ryan");
    expect(reply.text).toContain("Slack Clinic");
    expect(reply.blocks?.some((b) => b.type === "actions")).toBe(false);
    expect(await state(id)).toEqual({ stage: "dead", follow_up_date: null });
    expect((await decisions(id))[0]).toMatchObject({ kind: "not_following_up", reason: "other", reason_text: "Chosen in Slack", source: "slack", by: "Ryan" });
    const audit = await one<{ actor: string }>(`select actor from audit_log where table_name = 'prospects' and row_id = $1 and field = 'stage'`, [id]);
    expect(audit.actor).toBe("Ryan");
    const acked = await one<{ acknowledged_at: Date | null }>(`select acknowledged_at from notifications where rule_key = 'prospect_follow_up' and record_id = $1`, [id]);
    expect(acked.acknowledged_at).not.toBeNull();

    // Pressing it again on an old copy of the message changes nothing more.
    const again = await choose("U_ryan", id, "gone_cold", dm[0].blocks);
    expect(again.text).toContain("already closed");
    expect((await decisions(id)).length).toBe(1);
  });

  it("the date picker moves the follow-up; today or earlier is refused", async () => {
    const id = await prospect("Picker Clinic", `${LONDON_TODAY} - 1`);
    const early = await pick("U_ryan", id, await day("app_today()"));
    expect(early).toMatchObject({ replace_original: false, response_type: "ephemeral", text: "Pick a date after today. Nothing was changed." });
    expect((await decisions(id)).length).toBe(0);

    const date = await day("app_today() + 6");
    const reply = await pick("U_ryan", id, date, [{ type: "section", block_id: `item:prospects:${id}` }, { type: "actions", block_id: blockId(id) }]);
    expect(reply.replace_original).toBe(true);
    expect(reply.text).toContain("Follow up moved to");
    expect(reply.blocks?.map((b) => b.type)).toEqual(["section", "context"]);
    expect(await state(id)).toEqual({ stage: "chase", follow_up_date: date });
    expect((await decisions(id))[0]).toMatchObject({ kind: "follow_up_later", next: date, source: "slack" });
  });

  it("refuses anyone but the app owner, and an unlinked Slack account", async () => {
    const id = await prospect("Owner Only Clinic");
    const staff = await choose("U_sameer", id, "not_a_fit");
    expect(staff).toMatchObject({ replace_original: false, response_type: "ephemeral" });
    expect(staff.text).toBe("Only the owner can close a prospect follow-up. Nothing was changed.");
    expect((await pick("U_amanda", id, await day("app_today() + 3"))).text).toBe("Only the owner can close a prospect follow-up. Nothing was changed.");
    expect((await choose("U_stranger", id, "not_a_fit")).text).toContain("not linked");
    expect((await state(id)).stage).toBe("chase");
    expect(await decisions(id)).toEqual([]);
  });
});

describe("reminders", () => {
  const candidates = async (now: string) =>
    (await db.query<{ record_id: string }>(`select record_id from reminder_candidates($1::timestamptz) where rule_key = 'prospect_follow_up'`, [now])).rows.map((r) => r.record_id);
  const digestProspects = async (now: string) =>
    ((await one<{ p: { id: string }[] }>(`select reminder_morning_digest($1::timestamptz) -> 'prospects' as p`, [now])).p ?? []).map((x) => x.id);

  it("a prospect marked not following up gets no more reminders and leaves the digest", async () => {
    const id = await prospect("Stopped Clinic", `${LONDON_TODAY} - 2`);
    await run(await london(0, "07:10"));
    expect(followUpDms().length).toBe(1);
    expect(digests()[0].text).toContain("Stopped Clinic");

    await asUser(db, AUTH.ryan, () => call(`prospect_not_following_up($1, 'gone_cold')`, [id]));
    const tomorrow = await london(1, "07:10");
    expect(await candidates(tomorrow)).toEqual([]);
    expect(await digestProspects(tomorrow)).toEqual([]);
    await run(tomorrow);
    await run(await london(2, "07:10"));
    expect(followUpDms().length).toBe(1);
    expect(digests().slice(1).every((m) => !m.text.includes("Stopped Clinic"))).toBe(true);
  });

  it("a reminder already queued but not yet sent is closed, and the waiting digest drops the prospect", async () => {
    const gone = await prospect("Queued Clinic", `${LONDON_TODAY} - 2`);
    const kept = await prospect("Still Chasing Clinic", `${LONDON_TODAY} - 1`);
    // Ryan has a shift entered, so the 07:00 London messages wait for it.
    await db.query(`update staff set shift_start = '09:00', shift_end = '17:00', working_days = '{1,2,3,4,5,6,7}' where id = $1`, [people.ryan]);
    const morning = await london(0, "07:10");
    await run(morning);
    expect(sent).toEqual([]);
    const queued = await db.query<{ record_id: string }>(`select record_id from notifications where rule_key = 'prospect_follow_up' and sent_at is null`);
    expect(queued.rows.map((r) => r.record_id).sort()).toEqual([gone, kept].sort());

    await asUser(db, AUTH.ryan, () => call(`prospect_not_following_up($1, 'not_a_fit')`, [gone]));
    const closed = await one<{ slack_ts: string; channel: string; sent: boolean }>(
      `select slack_ts, channel, sent_at is not null as sent from notifications where rule_key = 'prospect_follow_up' and record_id = $1`, [gone]);
    expect(closed).toEqual({ slack_ts: "skipped:resolved", channel: "skipped:resolved", sent: true });

    // Mid-morning ET: Ryan's shift is on, the held messages go out.
    await run(plus(morning, 8 * 60));
    expect(followUpDms().length).toBe(1);
    expect(followUpDms()[0].text).toContain("Still Chasing Clinic");
    expect(followUpDms()[0].text).not.toContain("Queued Clinic");
    expect(digests().length).toBe(1);
    expect(digests()[0].text).toContain("Still Chasing Clinic");
    expect(digests()[0].text).not.toContain("Queued Clinic");
  });

  it("a later date pauses the reminders until that morning, then they start again", async () => {
    const id = await prospect("Paused Clinic", `${LONDON_TODAY} - 3`);
    await run(await london(0, "07:10"));
    expect(followUpDms().length).toBe(1);

    // Three London days on: always after today in ET.
    const r = await asUser(db, AUTH.ryan, () => call(`prospect_follow_up_later($1, ${LONDON_TODAY} + 3)`, [id]));
    expect(r.result).toBe("follow_up_later");
    for (const offset of [1, 2]) {
      const now = await london(offset, "07:10");
      expect(await candidates(now)).toEqual([]);
      expect(await digestProspects(now)).toEqual([]);
      await run(now);
    }
    expect(followUpDms().length).toBe(1);

    const due = await london(3, "07:10");
    expect(await candidates(due)).toEqual([id]);
    await run(due);
    expect(followUpDms().length).toBe(2);
    expect(followUpDms()[1].text).toContain("Paused Clinic> · today");
    // Still open the day after: it is overdue again and says so.
    await run(await london(4, "07:10"));
    expect(followUpDms().length).toBe(3);
    expect(followUpDms()[2].text).toContain("1 day overdue");
    expect(await digestProspects(await london(4, "07:10"))).toEqual([id]);
  });

  it("undoing brings the reminder back", async () => {
    const id = await prospect("Second Thoughts Clinic", `${LONDON_TODAY} - 2`);
    await asUser(db, AUTH.ryan, () => call(`prospect_not_following_up($1, 'gone_cold')`, [id]));
    expect(await candidates(await london(0, "07:10"))).toEqual([]);
    await asUser(db, AUTH.ryan, () => call(`prospect_follow_up_undo($1)`, [id]));
    expect(await candidates(await london(0, "07:10"))).toEqual([id]);
    await run(await london(0, "07:10"));
    expect(followUpDms().length).toBe(1);
  });
});
