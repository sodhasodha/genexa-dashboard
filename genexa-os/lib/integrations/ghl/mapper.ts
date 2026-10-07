// Typed mapper for GHL calendar events. Pure functions. Field names from real
// responses (fixtures/ghl). Only what the outcome flow needs is kept: no
// surname, phone, email, notes or intake answers ever leave this file.
import { z } from "zod";
import { contactKey } from "@/lib/contactKey";

export const GhlCalendar = z.object({ id: z.string(), name: z.string() }).loose();
export const GhlCalendarsResponse = z.object({ calendars: z.array(GhlCalendar) }).loose();

export const GhlEvent = z
  .object({
    id: z.string(),
    calendarId: z.string(),
    contactId: z.string().nullable().optional(),
    startTime: z.string(),
    dateAdded: z.string().nullable().optional(),
    appointmentStatus: z.string().nullable().optional(),
    deleted: z.boolean().nullable().optional(),
    title: z.string().nullable().optional(),
    appointmentMeta: z
      .object({
        defaultFormDetails: z
          .object({ firstName: z.string().nullable().optional(), email: z.string().nullable().optional(), phone: z.string().nullable().optional() })
          .loose()
          .nullable()
          .optional(),
      })
      .loose()
      .nullable()
      .optional(),
  })
  .loose();
export type GhlEvent = z.infer<typeof GhlEvent>;
export const GhlEventsResponse = z.object({ events: z.array(GhlEvent) }).loose();

export type CalendarKind = "unconfirmed" | "confirmed";

/** Which of a clinic's calendars hold consults. Anything else (intro calls etc.) is ignored. */
export function calendarKind(name: string): CalendarKind | null {
  if (/unconfirmed/i.test(name)) return "unconfirmed";
  if (/confirmed/i.test(name)) return "confirmed";
  return null;
}

export type AppointmentRow = {
  ghl_appointment_id: string;
  ghl_contact_id: string;
  scheduled_for: string;
  booked_at: string | null;
  calendar_kind: CalendarKind;
  ghl_status: string | null;
  contact_first_name: string | null;
  contact_key: string | null;
  cancelled: boolean;
};

const isCancelled = (e: GhlEvent) => e.deleted === true || /cancel|invalid/i.test(e.appointmentStatus ?? "");

/**
 * One row per consult. The same consult usually exists twice in GHL, once on the
 * unconfirmed calendar and once on the confirmed one: the confirmed, live copy wins.
 */
export function mapAppointments(events: { event: GhlEvent; kind: CalendarKind }[]): AppointmentRow[] {
  const best = new Map<string, { event: GhlEvent; kind: CalendarKind }>();
  const rank = (x: { event: GhlEvent; kind: CalendarKind }) => (isCancelled(x.event) ? 0 : 2) + (x.kind === "confirmed" ? 1 : 0);
  for (const x of events) {
    if (!x.event.contactId) continue;
    const start = new Date(x.event.startTime);
    if (Number.isNaN(start.getTime())) continue;
    const key = `${x.event.contactId}|${start.toISOString()}`;
    const current = best.get(key);
    if (!current || rank(x) > rank(current)) best.set(key, x);
  }
  return [...best.values()].map(({ event, kind }) => {
    const form = event.appointmentMeta?.defaultFormDetails;
    const first = form?.firstName?.trim() || event.title?.trim().split(/\s+/)[0] || null;
    return {
      ghl_appointment_id: event.id,
      ghl_contact_id: event.contactId as string,
      scheduled_for: new Date(event.startTime).toISOString(),
      booked_at: event.dateAdded ? new Date(event.dateAdded).toISOString() : null,
      calendar_kind: kind,
      ghl_status: event.appointmentStatus ?? null,
      contact_first_name: first,
      contact_key: contactKey({ phone: form?.phone, email: form?.email }),
      cancelled: isCancelled(event),
    };
  });
}
