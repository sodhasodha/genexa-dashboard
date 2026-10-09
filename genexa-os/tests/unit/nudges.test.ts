import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => { throw new Error("not used"); } }));
import { nudgeText } from "@/lib/jobs/nudges";

describe("outcome nudge wording", () => {
  it("is one short line with the clinic, the count and the link, and no patient names", () => {
    expect(nudgeText("Vitale Health Clinic", 7, "https://example.test/outcomes")).toBe(
      "Hi Vitale Health Clinic 👋 You have 7 patient outcomes waiting to be updated. Please log them here: https://example.test/outcomes. Thanks!",
    );
    expect(nudgeText("Regen RX", 1, "https://example.test/o")).toContain("You have 1 patient outcome waiting");
  });

  it("adds the clinic's own dashboard login when one is stored", () => {
    expect(nudgeText("Regen RX", 4, "https://client.genexascaling.com", { username: "regenrx", password: "Example-Pass1" })).toBe(
      "Hi Regen RX 👋 You have 4 patient outcomes waiting to be updated. Please log them here: https://client.genexascaling.com\nUsername: regenrx\nPassword: Example-Pass1\nThanks!",
    );
  });
});
