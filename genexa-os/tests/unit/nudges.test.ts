import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => { throw new Error("not used"); } }));
import { nudgeText } from "@/lib/jobs/nudges";

describe("outcome nudge wording", () => {
  it("lists new consults with first name and appointment time, and second reminders in one short line", () => {
    expect(nudgeText({ count: 2, list: "Don — Wed 23 Sep, 10:30am\nAlanna — Wed 23 Sep, 2:00pm" }, { count: 1, list: "Rich (Fri 25 Sep)" })).toBe(
      "2 consults need an outcome logged (showed, no-show or cancelled):\n• Don — Wed 23 Sep, 10:30am\n• Alanna — Wed 23 Sep, 2:00pm\n\nSecond reminder, still waiting: Rich (Fri 25 Sep)",
    );
    expect(nudgeText({ count: 1, list: "Don — Wed 23 Sep, 10:30am" }, { count: 0, list: null })).toBe("1 consult needs an outcome logged (showed, no-show or cancelled):\n• Don — Wed 23 Sep, 10:30am");
    expect(nudgeText({ count: 0, list: null }, { count: 2, list: "A (Mon 5 Oct), B (Mon 5 Oct)" })).toBe("Second reminder, still waiting: A (Mon 5 Oct), B (Mon 5 Oct)");
  });
});
