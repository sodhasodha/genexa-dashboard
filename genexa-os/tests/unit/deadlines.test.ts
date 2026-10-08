import { describe, expect, it } from "vitest";
import { countdown, formatDeadline, instantToLocal, localToInstant, offsetMinutes, safeZone, zoneAbbr } from "@/lib/deadlines";
import { composeAll, type Pending } from "@/lib/reminders/compose";

const iso = (local: string, tz?: string) => localToInstant(local, tz)?.toISOString() ?? null;

describe("UK wall-clock time to an instant", () => {
  it("summer (BST) is one hour ahead of UTC, winter (GMT) is UTC", () => {
    expect(iso("2026-07-15T15:00")).toBe("2026-07-15T14:00:00.000Z");
    expect(iso("2026-10-14T15:00")).toBe("2026-10-14T14:00:00.000Z");
    expect(iso("2026-12-01T09:30")).toBe("2026-12-01T09:30:00.000Z");
    expect(iso("2027-01-20T00:00")).toBe("2027-01-20T00:00:00.000Z");
  });

  it("the day the clocks go back (25 Oct 2026): before, inside the repeated hour, and after", () => {
    expect(iso("2026-10-25T00:30")).toBe("2026-10-24T23:30:00.000Z"); // still BST
    expect(iso("2026-10-25T01:30")).toBe("2026-10-25T00:30:00.000Z"); // happens twice: the first (BST) one
    expect(iso("2026-10-25T02:00")).toBe("2026-10-25T02:00:00.000Z"); // GMT
    expect(iso("2026-10-25T17:00")).toBe("2026-10-25T17:00:00.000Z");
    expect(iso("2026-10-24T17:00")).toBe("2026-10-24T16:00:00.000Z"); // the day before is BST all day
  });

  it("the day the clocks go forward (28 Mar 2027): before, inside the missing hour, and after", () => {
    expect(iso("2027-03-28T00:59")).toBe("2027-03-28T00:59:00.000Z"); // GMT
    expect(iso("2027-03-28T01:30")).toBe("2027-03-28T01:30:00.000Z"); // does not exist: read as 02:30 BST
    expect(iso("2027-03-28T02:00")).toBe("2027-03-28T01:00:00.000Z"); // BST
    expect(iso("2027-03-28T17:00")).toBe("2027-03-28T16:00:00.000Z");
    expect(iso("2027-03-27T17:00")).toBe("2027-03-27T17:00:00.000Z"); // the day before is GMT all day
  });

  it("does not depend on the machine's own timezone, and refuses anything that is not a date and time", () => {
    expect(iso("2026-10-14T15:00", "America/New_York")).toBe("2026-10-14T19:00:00.000Z");
    expect(iso("2026-10-14T15:00", "Asia/Karachi")).toBe("2026-10-14T10:00:00.000Z");
    for (const bad of ["", "2026-10-14", "2026-02-30T10:00", "2026-13-01T10:00", "2026-10-14T24:00", "2026-10-14T10:60", "14/10/2026 15:00", "2026-10-14T15:00:00Z"]) {
      expect(localToInstant(bad), bad).toBeNull();
    }
  });

  it("round-trips through the value of a datetime-local box", () => {
    for (const local of ["2026-07-15T15:00", "2026-10-25T00:30", "2026-10-25T02:00", "2026-12-01T09:30", "2027-03-28T02:00"]) {
      expect(instantToLocal(localToInstant(local)), local).toBe(local);
    }
    expect(instantToLocal("2026-10-14T14:00:00Z")).toBe("2026-10-14T15:00");
    expect(instantToLocal("2026-10-14T14:00:00Z", "America/New_York")).toBe("2026-10-14T10:00");
    expect(instantToLocal(null)).toBe("");
    expect(instantToLocal("nonsense")).toBe("");
  });

  it("knows the offset on either side of a change", () => {
    expect(offsetMinutes(new Date("2026-10-25T00:59:00Z"), "Europe/London")).toBe(60);
    expect(offsetMinutes(new Date("2026-10-25T01:00:00Z"), "Europe/London")).toBe(0);
    expect(offsetMinutes(new Date("2026-07-01T12:00:00Z"), "America/New_York")).toBe(-240);
  });
});

describe("showing a deadline in the reader's timezone", () => {
  it("names the zone: BST / GMT for the UK, EDT / EST for New York, an offset where there is no name", () => {
    expect(formatDeadline("2026-10-14T14:00:00Z", "Europe/London")).toBe("Wed 14 Oct, 15:00 BST");
    expect(formatDeadline("2026-12-01T09:30:00Z", "Europe/London")).toBe("Tue 1 Dec, 09:30 GMT");
    expect(formatDeadline("2026-10-14T14:00:00Z", "America/New_York")).toBe("Wed 14 Oct, 10:00 EDT");
    expect(formatDeadline("2026-12-01T09:30:00Z", "America/New_York")).toBe("Tue 1 Dec, 04:30 EST");
    expect(formatDeadline("2026-10-14T14:00:00Z", "Asia/Kolkata")).toBe("Wed 14 Oct, 19:30 IST");
    expect(formatDeadline("2026-10-14T14:00:00Z", "Asia/Karachi")).toMatch(/^Wed 14 Oct, 19:00 (PKT|GMT\+5)$/);
    // The same instant can be another day for the reader.
    expect(formatDeadline("2026-10-14T22:00:00Z", "Asia/Manila")).toMatch(/^Thu 15 Oct, 06:00 /);
  });

  it("falls back to UK time when the timezone is missing or unknown", () => {
    expect(safeZone(null)).toBe("Europe/London");
    expect(safeZone("Mars/Olympus")).toBe("Europe/London");
    expect(formatDeadline("2026-10-14T14:00:00Z", null)).toBe("Wed 14 Oct, 15:00 BST");
    expect(formatDeadline("2026-10-14T14:00:00Z", "Mars/Olympus")).toBe("Wed 14 Oct, 15:00 BST");
    expect(formatDeadline(null, "Europe/London")).toBeNull();
    expect(zoneAbbr(new Date("2026-07-01T12:00:00Z"), "Europe/London")).toBe("BST");
  });
});

describe("countdown", () => {
  it("counts down in minutes, hours, then days, rounded down", () => {
    expect(countdown(25)).toBe("due in 25m");
    expect(countdown(59)).toBe("due in 59m");
    expect(countdown(60)).toBe("due in 1h");
    expect(countdown(180)).toBe("due in 3h");
    expect(countdown(239)).toBe("due in 3h");
    expect(countdown(1439)).toBe("due in 23h");
    expect(countdown(1440)).toBe("due in 1d");
    expect(countdown(4 * 1440 + 30)).toBe("due in 4d");
  });

  it("turns to overdue the minute the deadline passes", () => {
    expect(countdown(1)).toBe("due in 1m");
    expect(countdown(0)).toBe("due now");
    expect(countdown(-1)).toBe("1m overdue");
    expect(countdown(-125)).toBe("2h overdue");
    expect(countdown(-3 * 1440 - 5)).toBe("3d overdue");
  });

  it("has nothing to say without a deadline", () => {
    expect(countdown(null)).toBeNull();
    expect(countdown(undefined)).toBeNull();
    expect(countdown(Number.NaN)).toBeNull();
  });
});

describe("deadline reminders as Slack messages", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const pending = (over: Partial<Pending>): Pending => ({
    id: "n1", rule_key: "task_due_2h", staff_id: "s1", staff_name: "Sameer", slack_user_id: "U1", email: null, channel: null,
    record_type: "tasks", record_id: id, window_key: "due:1", template: "Due in 2h", payload: {}, ...over,
  });
  const timed = { title: "Fix the calendar", due: "2026-10-14", due_at: "2026-10-14T14:00:00Z", tz: "Asia/Kolkata", client: "Pivotal" };

  it("due in 2h: the deadline in the owner's timezone, with Done / Snooze 1h", () => {
    const [g] = composeAll([pending({ payload: timed })], "https://ops.test");
    expect(g.message.text.startsWith("Due in 2h")).toBe(true);
    expect(g.message.text).toContain("Fix the calendar");
    expect(g.message.text).toContain("due Wed 14 Oct, 19:30 IST");
    expect(g.message.blocks.find((b) => b.type === "actions")).toMatchObject({ block_id: `act:tasks:${id}`, elements: [{ action_id: "done" }, { action_id: "snooze_1h" }] });
  });

  it("overdue at the deadline says when it was due; a date-only task still says how many days", () => {
    const [a] = composeAll([pending({ rule_key: "task_overdue", template: "Overdue", window_key: "at:1", payload: timed })], "https://ops.test");
    expect(a.message.text.startsWith("Overdue")).toBe(true);
    expect(a.message.text).toContain("was due Wed 14 Oct, 19:30 IST");
    expect(a.message.blocks.some((b) => b.type === "actions" && b.block_id === `act:tasks:${id}`)).toBe(true);
    const [b] = composeAll([pending({ rule_key: "task_overdue", template: "Overdue", window_key: "2026-10-16", payload: { title: "Old", due: "2026-10-14", days_overdue: 2 } })], "https://ops.test");
    expect(b.message.text).toContain("2 days overdue");
  });

  it("the owner's DM a day later names the person and the deadline in UK time, with no buttons to press by mistake", () => {
    const [g] = composeAll([pending({
      rule_key: "task_overdue_24h", staff_id: "ryan", template: "Task still open a day after its deadline", window_key: "at:1",
      payload: { ...timed, tz: "Europe/London", owner: "Sameer", hours_overdue: 24 },
    })], "https://ops.test");
    expect(g.message.text.startsWith("Task still open a day after its deadline")).toBe(true);
    expect(g.message.text).toContain("Sameer");
    expect(g.message.text).toContain("was due Wed 14 Oct, 15:00 BST");
    expect(g.message.text).toContain(`https://ops.test/tasks?task=${id}`);
    expect(g.message.blocks.some((b) => b.type === "actions")).toBe(false);
  });

  it("a new task with a time says the time, not just the day", () => {
    const [g] = composeAll([pending({ rule_key: "task_assigned", template: "New task", window_key: "", payload: { ...timed, assigned_by: "Ryan" } })], "https://ops.test");
    expect(g.message.text).toContain("from Ryan");
    expect(g.message.text).toContain("due Wed 14 Oct, 19:30 IST");
  });
});
