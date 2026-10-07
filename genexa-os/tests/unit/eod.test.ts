import { describe, expect, it } from "vitest";
import { describeEod, referencedIds, summariseEod } from "@/lib/eod/describe";
import { eodDbErrorCode, parseEodForm, EOD_ERRORS } from "@/lib/eod/schema";
import { localDate, shiftHours } from "@/lib/eod/time";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function form(fields: Record<string, string | string[]>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const one of Array.isArray(v) ? v : [v]) f.append(k, one);
  return f;
}

describe("CSR form", () => {
  it("stores a small flat object and drops the Other text unless Other is chosen", () => {
    const r = parseEodForm("csr", form({ hours_worked: "7.5", blocker: "dialer", blocker_other: "ignored", patient_flag: " Maria ", focus: "4" }));
    expect(r).toEqual({
      ok: true,
      value: { role: "csr", answers: { v: 1, hours_worked: 7.5, blocker: "dialer", blocker_other: null, patient_flag: "Maria", focus: 4 } },
    });
  });

  it("names what is wrong", () => {
    const base = { hours_worked: "8", blocker: "none", focus: "3" };
    expect(parseEodForm("csr", form({ ...base, hours_worked: "" }))).toEqual({ ok: false, error: "hours" });
    expect(parseEodForm("csr", form({ ...base, hours_worked: "30" }))).toEqual({ ok: false, error: "hours" });
    expect(parseEodForm("csr", form({ ...base, blocker: "" }))).toEqual({ ok: false, error: "blocker" });
    expect(parseEodForm("csr", form({ ...base, blocker: "other" }))).toEqual({ ok: false, error: "blocker_other" });
    expect(parseEodForm("csr", form({ ...base, focus: "6" }))).toEqual({ ok: false, error: "focus" });
    expect(parseEodForm("csr", form({ ...base, patient_flag: "x".repeat(201) }))).toEqual({ ok: false, error: "too_long" });
  });
});

describe("media buyer form", () => {
  it("keeps only test rows with a clinic and needs all three creative fields together", () => {
    const r = parseEodForm(
      "media_buyer",
      form({
        accounts_touched: [A, B], what_changed: "Raised budget", exceptions_cleared: [A],
        test_client: [A, "", B, "", ""], test_count: ["2", "1", "3", "1", "1"],
        creative_needed: "3 UGC hooks", creative_from: "Editor", creative_by: "2026-10-09", call_centre_note: "",
      }),
    );
    expect(r).toEqual({
      ok: true,
      value: {
        role: "media_buyer",
        answers: {
          v: 1, accounts_touched: [A, B], what_changed: "Raised budget", exceptions_cleared: [A],
          tests: [{ client_id: A, count: 2 }, { client_id: B, count: 3 }],
          creative_needed: "3 UGC hooks", creative_from: "Editor", creative_by: "2026-10-09", call_centre_note: null,
        },
      },
    });
  });

  it("accepts a day with nothing ticked, and names what is wrong otherwise", () => {
    expect(parseEodForm("media_buyer", form({})).ok).toBe(true);
    expect(parseEodForm("media_buyer", form({ accounts_touched: A }))).toEqual({ ok: false, error: "what_changed" });
    expect(parseEodForm("media_buyer", form({ test_client: A, test_count: "" }))).toEqual({ ok: false, error: "tests" });
    expect(parseEodForm("media_buyer", form({ test_client: A, test_count: "0" }))).toEqual({ ok: false, error: "tests" });
    expect(parseEodForm("media_buyer", form({ creative_needed: "Hooks" }))).toEqual({ ok: false, error: "creative" });
    expect(parseEodForm("media_buyer", form({ accounts_touched: "not-an-id", what_changed: "x" }))).toEqual({ ok: false, error: "invalid" });
  });
});

describe("tech form", () => {
  it("needs the first thing tomorrow", () => {
    expect(parseEodForm("tech", form({ jobs_shipped: [A] }))).toEqual({ ok: false, error: "tomorrow" });
    expect(parseEodForm("tech", form({ jobs_shipped: [A, A], tomorrow_first: "Rockwall calendar" }))).toEqual({
      ok: true,
      value: { role: "tech", answers: { v: 1, jobs_shipped: [A], blocked_on: null, broke_after_live: null, tomorrow_first: "Rockwall calendar" } },
    });
  });
});

describe("reading an EOD back", () => {
  const names = new Map([[A, "Clinic A"], [B, "Clinic B"]]);

  it("builds a one-line summary per role", () => {
    expect(summariseEod("csr", { v: 1, hours_worked: 8, blocker: "no_pickups", blocker_other: null, patient_flag: "Maria", focus: 4 })).toBe(
      "8h · blocker: no pickups · focus 4/5 · patient flagged",
    );
    expect(
      summariseEod("media_buyer", {
        v: 1, accounts_touched: [A], what_changed: "x", exceptions_cleared: [], tests: [{ client_id: A, count: 2 }, { client_id: B, count: 1 }],
        creative_needed: null, creative_from: null, creative_by: null, call_centre_note: null,
      }),
    ).toBe("1 account touched · 0 exceptions cleared · 3 tests launched");
    expect(summariseEod("tech", { v: 1, jobs_shipped: [A, B], blocked_on: null, broke_after_live: null, tomorrow_first: "Fix form" })).toBe(
      "2 jobs shipped · tomorrow: Fix form",
    );
  });

  it("does not guess at answers in another shape", () => {
    expect(summariseEod("csr", { focus: 4 })).toMatch(/older format/);
    expect(describeEod("csr", { bookings: 7 }, names)).toEqual([{ label: "Answers", value: expect.stringMatching(/older format/) }]);
    expect(referencedIds("csr", { bookings: 7 })).toEqual({ clients: [], exceptions: [], jobs: [] });
  });

  it("resolves ids to names", () => {
    const answers = {
      v: 1, accounts_touched: [A], what_changed: "Raised budget", exceptions_cleared: [], tests: [{ client_id: B, count: 2 }],
      creative_needed: null, creative_from: null, creative_by: null, call_centre_note: null,
    };
    const lines = describeEod("media_buyer", answers, names);
    expect(lines.find((l) => l.label === "Accounts touched")?.value).toBe("Clinic A");
    expect(lines.find((l) => l.label === "Tests launched")?.value).toBe("Clinic B × 2");
    expect(referencedIds("media_buyer", answers).clients).toEqual([A, B]);
  });
});

describe("helpers", () => {
  it("measures a shift, including overnight", () => {
    expect(shiftHours("09:00:00", "17:30:00")).toBe(8.5);
    expect(shiftHours("21:00", "05:00")).toBe(8);
    expect(shiftHours(null, "05:00")).toBeNull();
  });

  it("cuts the day in the person's timezone", () => {
    const at = new Date("2026-10-07T02:30:00Z");
    expect(localDate("America/New_York", at)).toBe("2026-10-06");
    expect(localDate("Asia/Manila", at)).toBe("2026-10-07");
  });

  it("turns database refusals into plain English", () => {
    expect(EOD_ERRORS[eodDbErrorCode("EOD_CLOSED: an EOD can only be filed or edited on its own day")]).toMatch(/day has ended/);
    expect(EOD_ERRORS[eodDbErrorCode("EOD_OWN: you can only file your own EOD")]).toMatch(/your own/);
    expect(eodDbErrorCode("connection reset")).toBe("save");
  });
});
