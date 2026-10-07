import { describe, expect, it } from "vitest";
import { parsePeriod, resolvePeriod } from "@/lib/periods";
import { changeRatio, formatValue } from "@/lib/format";

describe("reporting periods compare like for like", () => {
  it("today vs yesterday", () => {
    expect(resolvePeriod("today", "2026-10-07")).toMatchObject({ from: "2026-10-07", to: "2026-10-07", prevFrom: "2026-10-06", prevTo: "2026-10-06" });
  });
  it("week to date vs the same days last week (Mon-Sun)", () => {
    // 7 Oct 2026 is a Wednesday.
    expect(resolvePeriod("week", "2026-10-07")).toMatchObject({ from: "2026-10-05", to: "2026-10-07", prevFrom: "2026-09-28", prevTo: "2026-09-30" });
    expect(resolvePeriod("week", "2026-10-05")).toMatchObject({ from: "2026-10-05", to: "2026-10-05", prevFrom: "2026-09-28", prevTo: "2026-09-28" });
  });
  it("month to date vs the same days last month, capped at that month's length", () => {
    expect(resolvePeriod("month", "2026-10-07")).toMatchObject({ from: "2026-10-01", to: "2026-10-07", prevFrom: "2026-09-01", prevTo: "2026-09-07" });
    expect(resolvePeriod("month", "2026-03-31")).toMatchObject({ from: "2026-03-01", to: "2026-03-31", prevFrom: "2026-02-01", prevTo: "2026-02-28" });
  });
  it("last month vs the month before, across a year end", () => {
    expect(resolvePeriod("last_month", "2026-10-07")).toMatchObject({ from: "2026-09-01", to: "2026-09-30", prevFrom: "2026-08-01", prevTo: "2026-08-31" });
    expect(resolvePeriod("last_month", "2027-01-15")).toMatchObject({ from: "2026-12-01", to: "2026-12-31", prevFrom: "2026-11-01", prevTo: "2026-11-30" });
  });
  it("defaults to this month", () => {
    expect(parsePeriod(undefined)).toBe("month");
    expect(parsePeriod("week")).toBe("week");
    expect(parsePeriod("nonsense")).toBe("month");
  });
});

describe("number display", () => {
  it("keeps null as null and formats the rest", () => {
    expect(formatValue(null, "money")).toBeNull();
    expect(formatValue(26833.34, "money")).toBe("$26,833");
    expect(formatValue(67.61, "money")).toBe("$67.61");
    expect(formatValue(0.4, "percent")).toBe("40.0%");
    expect(formatValue(1234.4, "count")).toBe("1,234");
  });
  it("computes change only when there is a previous value", () => {
    expect(changeRatio(120, 100)).toBeCloseTo(0.2);
    expect(changeRatio(80, 100)).toBeCloseTo(-0.2);
    expect(changeRatio(80, 0)).toBeNull();
    expect(changeRatio(null, 100)).toBeNull();
    expect(changeRatio(5, null)).toBeNull();
  });
});
