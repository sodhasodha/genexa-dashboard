import { describe, expect, it } from "vitest";
import { decideForms, formKind, mapSubmissions, matchClinicName, type FormKind } from "@/lib/integrations/ghl/forms";
import fixture from "../../fixtures/ghl/survey_submissions_redacted.json";

const kinds = new Map<string, FormKind>([["SURVEY_ONBOARDING", "onboarding"], ["SURVEY_NEW_CLIENT", "new_client"]]);
const clients = [
  { id: "vitale", name: "Vitale Health Clinic" }, { id: "airs", name: "Airs Clinic" }, { id: "cle", name: "cleveland icp" },
  { id: "reviv", name: "Reviv Florida" }, { id: "regenrx", name: "Regen RX" }, { id: "regenestem", name: "Regenestem" },
];

describe("GHL forms", () => {
  it("knows the two surveys by name and ignores the rest", () => {
    expect([formKind("New Client Form"), formKind("Onboarding Form"), formKind("Kick Off Form")]).toEqual(["new_client", "onboarding", null]);
  });

  it("keeps only the clinic name, contact name, time and email from a submission", () => {
    const subs = mapSubmissions(fixture, kinds);
    expect(subs.map((s) => [s.kind, s.organization, s.contact, s.at])).toEqual([
      ["onboarding", "Vitale health", "Jane Redacted", "2026-09-16T15:04:05.000Z"],
      ["new_client", "Vitale Health Clinic", "Jane Redacted", "2026-09-16T10:00:00.000Z"],
    ]);
    expect(JSON.stringify(subs)).not.toMatch(/5555550100|0\.0\.0\.0|REDACTED/);
  });

  it("matches a clinic name written differently, and refuses when it is not clear", () => {
    expect(matchClinicName("Airsclinic", clients)).toBe("airs");
    expect(matchClinicName("icp cleveland", clients)).toBe("cle");
    expect(matchClinicName("Vitale health", clients)).toBe("vitale");
    expect(matchClinicName("REVĪV Florida", clients)).toBe("reviv");
    expect(matchClinicName("Regen", clients)).toBeNull(); // Regen RX or Regenestem? neither is "regen" alone, so no guess
    expect(matchClinicName("Some New Clinic", clients)).toBeNull();
    expect(matchClinicName("", clients)).toBeNull();
  });

  it("puts an Onboarding Form on the client of the New Client Form the same contact filled", () => {
    const subs = mapSubmissions(fixture, kinds);
    const renamed = subs.map((s) => (s.kind === "onboarding" ? { ...s, organization: "Totally Different Trading Name LLC" } : s));
    const d = decideForms(renamed, clients);
    expect(d.map((x) => [x.submission.kind, x.clientId, x.reason])).toEqual([
      ["new_client", "vitale", "clinic name"],
      ["onboarding", "vitale", "same GHL contact as the New Client Form"],
    ]);
    const alone = decideForms(renamed.filter((s) => s.kind === "onboarding"), clients);
    expect(alone[0].clientId).toBeNull();
  });
});
