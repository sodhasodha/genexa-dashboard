import { describe, expect, it } from "vitest";
import { callMatchScore, callPerson } from "@/lib/integrations/fathom/person";

describe("callPerson", () => {
  it("takes the name from a sales call title", () => {
    expect(callPerson("Genexa Scaling x Gannon", ["Gannon"])).toBe("Gannon");
    expect(callPerson("Genexa Scaling x David Bell - Follow Up", [])).toBe("David Bell");
  });
  it("uses the invitee's name when the title is not a sales call title", () => {
    expect(callPerson("30 min with Ryan (Edlyn Krystel Gaupo)", ["Edlyn Krystel Gaupo"])).toBe("Edlyn Krystel Gaupo");
  });
  it("never treats an email address as a name", () => {
    expect(callPerson("team training", ["someone@example.com"])).toBe("team training");
    expect(callPerson(null, [])).toBeNull();
  });
});

describe("callMatchScore", () => {
  it("suggests on one shared word only when the call gives a single name", () => {
    expect(callMatchScore("Gannon / Dr Park", "Genexa Scaling x Gannon", ["Gannon"])).toBeGreaterThan(0);
    expect(callMatchScore("Carlos (Mexico clinic)", "Genexa Scaling x Carlos", ["Carlos"])).toBeGreaterThan(0);
  });
  it("does not suggest a different person who shares a first name", () => {
    expect(callMatchScore("David Waltzer", "Genexa Scaling x David Bell", ["David Bell"])).toBe(0);
    expect(callMatchScore("Sara Mosleh", "Genexa Scaling x Sara", ["Sara Ameli"])).toBe(0);
  });
  it("suggests when two name words match", () => {
    expect(callMatchScore("Dr Farid Rooh", "Genexa Scaling x Farid Rooh", ["Dr. Rooh"])).toBe(2);
  });
});
