import { describe, expect, it } from "vitest";
import { GhlEventsResponse, calendarKind, mapAppointments } from "@/lib/integrations/ghl/mapper";
import { contactKey } from "@/lib/contactKey";
import fixture from "../../fixtures/ghl/calendar_events_redacted.json";

const events = GhlEventsResponse.parse(fixture).events;

describe("GHL appointments (real response shape, patient details replaced)", () => {
  it("picks the consult calendars and ignores the rest", () => {
    expect(calendarKind("A. UNCONFIRMED Appointment Calendar")).toBe("unconfirmed");
    expect(calendarKind("A. Confirmed Appointment Calendar")).toBe("confirmed");
    expect(calendarKind("Intro Phone Call Calendar")).toBeNull();
  });

  it("maps an event to a consult row holding a first name and a hash, nothing else personal", () => {
    const rows = mapAppointments(events.map((event) => ({ event, kind: "unconfirmed" as const })));
    expect(rows.length).toBe(events.length);
    const r = rows[0];
    expect(r.scheduled_for).toMatch(/^2026-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/);
    expect(r.contact_first_name).toBe("Maria");
    expect(r.contact_key).toMatch(/^p:[0-9a-f]{32}$/);
    expect(JSON.stringify(rows)).not.toMatch(/Redacted|example\.org|\+1555/);
  });

  it("keeps one row per consult: the confirmed live copy beats the unconfirmed one, a cancelled copy loses", () => {
    const a = events[0];
    const rows = mapAppointments([
      { event: { ...a, id: "unconf" }, kind: "unconfirmed" },
      { event: { ...a, id: "conf" }, kind: "confirmed" },
    ]);
    expect(rows.map((r) => [r.ghl_appointment_id, r.calendar_kind, r.cancelled])).toEqual([["conf", "confirmed", false]]);
    const cancelled = mapAppointments([
      { event: { ...a, id: "conf", appointmentStatus: "cancelled" }, kind: "confirmed" },
      { event: { ...a, id: "unconf" }, kind: "unconfirmed" },
    ]);
    expect(cancelled.map((r) => [r.ghl_appointment_id, r.cancelled])).toEqual([["unconf", false]]);
    expect(mapAppointments([{ event: { ...a, appointmentStatus: "cancelled" }, kind: "confirmed" }])[0].cancelled).toBe(true);
  });
});

describe("contactKey", () => {
  it("is the same for the same phone however it is written, and falls back to email", () => {
    expect(contactKey({ phone: "+1 (555) 000-1234" })).toBe(contactKey({ phone: "5550001234" }));
    expect(contactKey({ phone: "5550001234" })).not.toBe(contactKey({ phone: "5550001235" }));
    expect(contactKey({ email: " A@B.com " })).toBe(contactKey({ email: "a@b.com" }));
    expect(contactKey({ phone: "123" })).toBeNull();
    expect(contactKey(null)).toBeNull();
  });
});
