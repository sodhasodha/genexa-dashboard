import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => { throw new Error("not used"); } }));
import { confirmedCalendarAdds, fieldText, ghlVerdict, isCancelled, locationLabel, PATIENT_INFO_FIELD_KEY, patientName, readPatientInformation } from "@/lib/integrations/ghl/confirmations";
import { ghlContactUrl, matchesStatus, parseDeskFilters, telLink, timeLeft } from "@/lib/queries/confirmations";

const ev = (o: Record<string, unknown> = {}) => ({ id: "e1", calendarId: "CAL_U", contactId: "c1", startTime: "2026-10-28T15:00:00-04:00", appointmentStatus: "confirmed", ...o });
const main = new Set(["CAL_MAIN"]);

describe("desk sync: what GHL says about a tracked appointment", () => {
  it("on the main calendar = confirmed, by its own id or by the same patient after it left the Unconfirmed calendar", () => {
    expect(ghlVerdict({ status: "unconfirmed", ghl_contact_id: "c1" }, ev({ calendarId: "CAL_MAIN" }) as never, main, new Set(), false)).toMatchObject({ status: "confirmed", on_main: true });
    expect(ghlVerdict({ status: "unconfirmed", ghl_contact_id: "c1" }, null, main, new Set(["c1"]), false)).toMatchObject({ status: "confirmed", on_main: true });
  });
  it("still on the Unconfirmed calendar = keep the desk's status, take the (maybe new) time", () => {
    expect(ghlVerdict({ status: "unconfirmed", ghl_contact_id: "c1" }, ev({ startTime: "2026-10-29T10:00:00-04:00" }) as never, main, new Set(["c1"]), true))
      .toEqual({ scheduled_for: "2026-10-29T14:00:00.000Z", ghl_status: "confirmed" });
  });
  it("cancelled or gone in GHL = cancelled", () => {
    expect(ghlVerdict({ status: "unconfirmed", ghl_contact_id: "c1" }, ev({ appointmentStatus: "cancelled" }) as never, main, new Set(), false)).toMatchObject({ status: "cancelled" });
    expect(ghlVerdict({ status: "unconfirmed", ghl_contact_id: "c1" }, null, main, new Set(), false)).toMatchObject({ status: "cancelled", ghl_status: "gone" });
    expect(isCancelled({ deleted: true })).toBe(true);
  });
  it("names calendars' locations and patients", () => {
    expect(locationLabel("B. UNCONFIRMED Appointment Calendar - Frisco, TX")).toBe("Frisco, TX");
    expect(locationLabel("A. UNCONFIRMED Appointment Calendar")).toBeNull();
    expect(patientName({ firstName: "Jane", lastName: "Smith" }, "x")).toBe("Jane Smith");
    expect(patientName(null, "Jane S - consult")).toBe("Jane S - consult");
  });
});

describe("desk formatting and filters", () => {
  it("time left, tel links, status filters", () => {
    expect([timeLeft(45), timeLeft(320), timeLeft(1600)]).toEqual(["45m", "5h 20m", "1d 2h"]);
    expect(telLink("(555) 010-0123")).toBe("tel:+15550100123");
    expect(telLink("+44 7700 900123")).toBe("tel:+447700900123");
    expect(telLink("12")).toBeNull();
    expect(matchesStatus({ status: "unconfirmed" }, "needs_action")).toBe(true);
    expect(matchesStatus({ status: "unreachable" }, "needs_action")).toBe(true);
    expect(matchesStatus({ status: "confirmed" }, "needs_action")).toBe(false);
    expect(matchesStatus({ status: "cancelled" }, "needs_action")).toBe(false);
    expect(parseDeskFilters({ clinic: "11111111-1111-4111-8111-111111111111,bad", status: "confirmed" })).toEqual({ clinics: ["11111111-1111-4111-8111-111111111111"], status: "confirmed" });
    expect(parseDeskFilters({ status: "nope" }).status).toBe("needs_action");
  });
});

describe("desk sync: appointments booked on the Confirmed calendar", () => {
  const from = Date.parse("2026-10-28T00:00:00Z");
  const main = (o: Record<string, unknown>) => ev({ calendarId: "CAL_MAIN", ...o }) as never;
  it("adds upcoming ones; skips cancelled, already started, already tracked, and patients the desk has from the Unconfirmed calendar", () => {
    const events = [
      main({ id: "new", contactId: "c-new" }),
      main({ id: "gone", contactId: "c-x", appointmentStatus: "cancelled" }),
      main({ id: "past", contactId: "c-y", startTime: "2026-10-27T20:00:00Z" }),
      main({ id: "tracked", contactId: "c-z" }),
      main({ id: "moved", contactId: "c-moved" }),
      main({ id: "no-contact", contactId: null }),
    ];
    expect(confirmedCalendarAdds(events, new Set(["tracked"]), new Set(["c-moved"]), from).map((e: { id: string }) => e.id)).toEqual(["new", "no-contact"]);
  });
});

describe("the open patient: GHL contact link and Patient Information", () => {
  it("links to the contact in GHL only when both ids are known", () => {
    expect(ghlContactUrl("LOC1", "C1")).toBe("https://app.gohighlevel.com/v2/location/LOC1/contacts/detail/C1");
    expect(ghlContactUrl(null, "C1")).toBeNull();
    expect(ghlContactUrl("LOC1", null)).toBeNull();
  });

  it("field values as text: trimmed, lists joined, blank = nothing", () => {
    expect(fieldText("  Knee pain, 3 years  ")).toBe("Knee pain, 3 years");
    expect(fieldText(["Knee", " Back "])).toBe("Knee, Back");
    expect(fieldText("   ")).toBeNull();
    expect(fieldText(null)).toBeNull();
  });

  it("reads the Patient Information field by its key, looking the field id up once per location", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(new URL(url).pathname);
      const body = url.includes("/customFields")
        ? { customFields: [{ id: "F_OTHER", fieldKey: "contact.reason" }, { id: "F_PI", fieldKey: PATIENT_INFO_FIELD_KEY }] }
        : url.includes("/contacts/C404") ? null
        : { contact: { customFields: [{ id: "F_OTHER", value: "x" }, { id: "F_PI", value: "Right knee, 2 years, tried PRP" }] } };
      return new Response(body ? JSON.stringify(body) : "", { status: body ? 200 : 404 });
    }) as unknown as typeof fetch;
    expect(await readPatientInformation({ locationId: "LOC_T1", contactId: "C1", apiKey: "k", fetchImpl })).toBe("Right knee, 2 years, tried PRP");
    expect(await readPatientInformation({ locationId: "LOC_T1", contactId: "C404", apiKey: "k", fetchImpl })).toBeNull();
    expect(calls.filter((c) => c.endsWith("/customFields"))).toHaveLength(1);
  });

  it("a clinic without the field, or a contact who left it blank, shows nothing", async () => {
    const fetchImpl = (async (url: string) => new Response(JSON.stringify(url.includes("/customFields") ? { customFields: [] } : { contact: { customFields: [] } }), { status: 200 })) as unknown as typeof fetch;
    expect(await readPatientInformation({ locationId: "LOC_T2", contactId: "C1", apiKey: "k", fetchImpl })).toBeNull();
  });
});
