import { describe, expect, it } from "vitest";
import { diffEvents, safeToRemove, type EventLike } from "@/lib/integrations/cortana/verify";

const ev = (id: string, o: Partial<EventLike> = {}): EventLike => ({ cortana_entry_id: id, event: "lead", value: null, occurred_at: "2026-10-01T15:00:00.000Z", ...o });

describe("checking our events against Cortana", () => {
  it("finds what is missing, what changed and what Cortana no longer has", () => {
    const theirs = [ev("a"), ev("b", { event: "purchase", value: 5000 }), ev("c"), ev("d", { occurred_at: "2026-10-02T15:00:00Z" })];
    const ours = [ev("a"), ev("b", { event: "purchase", value: 4000 }), ev("d", { occurred_at: "2026-10-01T15:00:00.000Z" }), ev("x", { event: "purchase", value: 9000 })];
    expect(diffEvents(theirs, ours)).toEqual({ missing: ["c"], changed: ["b", "d"], gone: ["x"] });
  });

  it("the same instant written two ways, or a null value against 0, is not a change", () => {
    expect(diffEvents([ev("a", { occurred_at: "2026-10-01T15:00:00Z", value: 0 })], [ev("a", { occurred_at: "2026-10-01T11:00:00-04:00", value: null })])).toEqual({ missing: [], changed: [], gone: [] });
  });

  it("never treats an empty or much smaller answer as a clean-up", () => {
    expect(safeToRemove(0, 200, 200)).toBe(false); // Cortana returned nothing
    expect(safeToRemove(100, 200, 100)).toBe(false); // half of what we hold is "gone": a bad read
    expect(safeToRemove(198, 200, 2)).toBe(true);
    expect(safeToRemove(40, 43, 4)).toBe(true); // small clinic: up to 5
    expect(safeToRemove(0, 0, 0)).toBe(true);
  });
});
