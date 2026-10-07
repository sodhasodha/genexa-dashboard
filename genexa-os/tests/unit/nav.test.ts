import { describe, expect, it } from "vitest";
import { NAV_GROUPS, landingPath } from "@/lib/auth/nav";

describe("role-based landing", () => {
  it("sends each role to its page", () => {
    expect(landingPath({ id: "1", role: "owner" })).toBe("/overview");
    expect(landingPath({ id: "2", role: "media_buyer" })).toBe("/media-buying");
    expect(landingPath({ id: "3", role: "tech" })).toBe("/tech");
    expect(landingPath({ id: "abc", role: "csr" })).toBe("/call-centre?csr=abc");
  });

  it("groups the sidebar into Pacing, Team, Clients, Work and System", () => {
    expect(NAV_GROUPS.map((g) => g.title)).toEqual(["Pacing", "Team", "Clients", "Work", "System"]);
    expect(NAV_GROUPS.map((g) => g.items.map((i) => i.label))).toEqual([
      ["Overview", "Today", "Week", "Month"],
      ["Call Centre", "Media Buying", "Tech", "Team", "Payroll"],
      ["Clients", "Launches", "Pipeline"],
      ["Tasks", "Ideas"],
      ["Integrations", "Data review"],
    ]);
  });

});
