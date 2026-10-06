import { describe, expect, it } from "vitest";
import { formatAge } from "@/lib/format";

describe("formatAge", () => {
  it("formats minutes as a short age and passes null through", () => {
    expect(formatAge(null)).toBeNull();
    expect(formatAge(0.4)).toBe("just now");
    expect(formatAge(12)).toBe("12m ago");
    expect(formatAge(125)).toBe("2h ago");
    expect(formatAge(60 * 24 * 3)).toBe("3d ago");
  });
});
