import { describe, expect, it } from "vitest";
import { NAV, landingPath } from "@/lib/auth/nav";

describe("role-based landing", () => {
  it("sends each role to its page", () => {
    expect(landingPath({ id: "1", role: "owner" })).toBe("/overview");
    expect(landingPath({ id: "2", role: "media_buyer" })).toBe("/media-buying");
    expect(landingPath({ id: "3", role: "tech" })).toBe("/tech");
    expect(landingPath({ id: "abc", role: "csr" })).toBe("/call-centre?csr=abc");
  });

  it("has the nine sidebar pages in the brief's order", () => {
    expect(NAV.map((n) => n.label)).toEqual([
      "Overview", "Clients", "Launches", "Call Centre", "Media Buying", "Tech", "Tasks", "Pipeline", "Ideas",
    ]);
  });
});
