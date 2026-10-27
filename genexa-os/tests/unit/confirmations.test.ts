import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => { throw new Error("not used"); } }));
import { ghlVerdict, isCancelled, locationLabel, patientName } from "@/lib/integrations/ghl/confirmations";
import { matchesStatus, parseDeskFilters, telLink, timeLeft } from "@/lib/queries/confirmations";

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
