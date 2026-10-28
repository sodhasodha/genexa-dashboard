// The confirmation desk's GHL sync, every 5 minutes. Read only: it reads each
// clinic's Unconfirmed and main (Confirmed) calendars and never changes GHL.
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { calendarKind, GhlCalendarsResponse } from "./mapper";

const BASE = "https://services.leadconnectorhq.com";
/** Appointments reach the desk 34 hours ahead; a little extra is read so nothing is missed between runs. */
export const DESK_AHEAD_HOURS = 36;

export const DeskEvent = z
  .object({
    id: z.string(),
    calendarId: z.string(),
    contactId: z.string().nullable().optional(),
    startTime: z.string(),
    appointmentStatus: z.string().nullable().optional(),
    deleted: z.boolean().nullable().optional(),
    title: z.string().nullable().optional(),
  })
  .loose();
export type DeskEvent = z.infer<typeof DeskEvent>;
const EventsResponse = z.object({ events: z.array(DeskEvent) }).loose();
const OneEvent = z.object({ appointment: DeskEvent }).loose();
const Contact = z.object({ contact: z.object({ firstName: z.string().nullable().optional(), lastName: z.string().nullable().optional(), phone: z.string().nullable().optional() }).loose() }).loose();

/** "B. UNCONFIRMED Appointment Calendar - Frisco, TX" -> "Frisco, TX"; no suffix -> null. */
export function locationLabel(calendarName: string): string | null {
  const m = / - (.+)$/.exec(calendarName.trim());
  return m ? m[1].trim() : null;
}

export const isCancelled = (e: { appointmentStatus?: string | null; deleted?: boolean | null }) =>
  e.deleted === true || /cancel|invalid|noshow|no_show/i.test(e.appointmentStatus ?? "");

/** "Jane Smith" from a contact; the event title when the contact has no name. */
export function patientName(contact: { firstName?: string | null; lastName?: string | null } | null, title: string | null | undefined): string | null {
  const n = [contact?.firstName, contact?.lastName].map((x) => x?.trim()).filter(Boolean).join(" ");
  return n || title?.trim() || null;
}

type Tracked = { id: string; ghl_appointment_id: string; ghl_contact_id: string | null; status: string; status_source: string | null; scheduled_for: string; patient_name: string | null; phone: string | null; booked_on: "unconfirmed" | "main" };
type Cal = { calendar_id: string; kind: "unconfirmed" | "main"; name: string; location_label: string | null };

/**
 * What GHL now says about an appointment the desk is tracking (pure).
 * - On the main calendar: confirmed (by GHL), whatever the desk thought.
 * - Cancelled or gone in GHL: cancelled.
 * - Otherwise its (possibly new) time; the desk's own status is kept.
 */
export function ghlVerdict(
  row: Pick<Tracked, "status" | "ghl_contact_id">,
  found: DeskEvent | null,
  mainCalendars: Set<string>,
  mainContacts: Set<string>,
  seenOnUnconfirmed: boolean,
): { status?: "confirmed" | "cancelled"; on_main?: boolean; scheduled_for?: string; ghl_status?: string | null } {
  if (found && mainCalendars.has(found.calendarId)) return { status: "confirmed", on_main: true, scheduled_for: new Date(found.startTime).toISOString(), ghl_status: found.appointmentStatus ?? null };
  if (!seenOnUnconfirmed && row.ghl_contact_id && mainContacts.has(row.ghl_contact_id)) return { status: "confirmed", on_main: true };
  if (!found || isCancelled(found)) return { status: "cancelled", ghl_status: found?.appointmentStatus ?? "gone" };
  return { scheduled_for: new Date(found.startTime).toISOString(), ghl_status: found.appointmentStatus ?? null };
}

/**
 * Appointments on the Confirmed (main) calendar to add to the desk as Confirmed (pure):
 * upcoming, not cancelled, not already tracked, and not a patient the desk already
 * has from the Unconfirmed calendar (moving one in GHL can give it a new id).
 */
export function confirmedCalendarAdds(
  main: DeskEvent[], trackedIds: Set<string>, knownContacts: Set<string>, from: number,
): DeskEvent[] {
  return main.filter((e) => !isCancelled(e) && new Date(e.startTime).getTime() > from && !trackedIds.has(e.id) && !(e.contactId && knownContacts.has(e.contactId)));
}

export type DeskSyncResult = { ok: boolean; clinics: number; on_desk: number; added: number; added_confirmed: number; confirmed_in_ghl: number; cancelled_in_ghl: number; expired: number; skipped: string[]; errors: string[] };

export async function syncConfirmationDesk(opts: {
  db: SupabaseClient; keys: Record<string, { location_id: string; api_key: string }>; fetchImpl?: typeof fetch; now?: Date;
}): Promise<DeskSyncResult> {
  const { db } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? new Date();
  const out: DeskSyncResult = { ok: false, clinics: 0, on_desk: 0, added: 0, added_confirmed: 0, confirmed_in_ghl: 0, cancelled_in_ghl: 0, expired: 0, skipped: [], errors: [] };
  const keyByLocation = new Map(Object.values(opts.keys).map((k) => [k.location_id, k.api_key]));
  const get = async (apiKey: string, path: string, version = "2021-04-15"): Promise<{ status: number; body: unknown }> => {
    const res = await doFetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${apiKey}`, Version: version, Accept: "application/json" }, cache: "no-store" });
    if (res.status === 404) return { status: 404, body: null };
    if (!res.ok) throw new Error(`GHL ${res.status} on ${path.split("?")[0]}`);
    return { status: res.status, body: await res.json() };
  };

  const { data: clients, error } = await db.from("clients").select("id, name, ghl_location_id, timezone").not("ghl_location_id", "is", null).neq("stage", "churned").is("deleted_at", null).order("name");
  if (error) throw new Error(`clients: ${error.message}`);
  const from = now.getTime();
  const to = from + DESK_AHEAD_HOURS * 3_600_000;

  for (const client of clients ?? []) {
    const apiKey = keyByLocation.get(client.ghl_location_id as string);
    if (!apiKey) { out.skipped.push(`${client.name}: no GHL key`); continue; }
    try {
      const tz = (client.timezone as string | null) || "America/New_York";
      const calendars: Cal[] = GhlCalendarsResponse.parse((await get(apiKey, `/calendars/?locationId=${client.ghl_location_id}`)).body).calendars
        .flatMap((c) => {
          const kind = calendarKind(c.name);
          return kind ? [{ calendar_id: c.id, kind: kind === "confirmed" ? "main" as const : "unconfirmed" as const, name: c.name, location_label: locationLabel(c.name) }] : [];
        });
      if (!calendars.some((c) => c.kind === "unconfirmed")) { out.skipped.push(`${client.name}: no Unconfirmed calendar`); continue; }
      const seen = new Date().toISOString();
      await db.from("clinic_calendars").upsert(calendars.map((c) => ({ client_id: client.id, ...c, seen_at: seen })), { onConflict: "client_id,calendar_id" });

      const events: { e: DeskEvent; cal: Cal }[] = [];
      for (const cal of calendars) {
        const r = await get(apiKey, `/calendars/events?locationId=${client.ghl_location_id}&calendarId=${cal.calendar_id}&startTime=${from}&endTime=${to}`);
        for (const e of EventsResponse.parse(r.body).events) events.push({ e, cal });
      }
      const mainIds = new Set(calendars.filter((c) => c.kind === "main").map((c) => c.calendar_id));
      const mainContacts = new Set(events.filter((x) => x.cal.kind === "main" && !isCancelled(x.e) && x.e.contactId).map((x) => x.e.contactId as string));
      // GHL's window is loose and returns some that already started: those never reach the desk.
      const unconfirmed = events.filter((x) => x.cal.kind === "unconfirmed" && !isCancelled(x.e) && new Date(x.e.startTime).getTime() > from);

      const { data: existing } = await db.from("confirmation_appointments")
        .select("id, ghl_appointment_id, ghl_contact_id, status, status_source, scheduled_for, patient_name, phone, booked_on")
        .eq("client_id", client.id).gt("scheduled_for", new Date(from - 3_600_000).toISOString());
      const tracked = new Map(((existing ?? []) as Tracked[]).map((t) => [t.ghl_appointment_id, t]));
      const known = new Map(((existing ?? []) as Tracked[]).filter((t) => t.ghl_contact_id).map((t) => [t.ghl_contact_id as string, t]));

      /** Name and phone: from the desk's own row, another row for the same patient, or GHL. */
      const person = async (e: DeskEvent, row: Tracked | undefined) => {
        let name = row?.patient_name ?? null;
        let phone = row?.phone ?? null;
        const reuse = e.contactId ? known.get(e.contactId) : undefined;
        if (!row && reuse) { name = reuse.patient_name; phone = reuse.phone; }
        if ((!name || !phone) && e.contactId) {
          const c = await get(apiKey, `/contacts/${e.contactId}`, "2021-07-28");
          const parsed = c.body ? Contact.safeParse(c.body) : null;
          const contact = parsed?.success ? parsed.data.contact : null;
          name = name ?? patientName(contact, e.title);
          phone = phone ?? contact?.phone?.trim() ?? null;
        }
        return { patient_name: name ?? e.title ?? null, phone };
      };

      // New and still-unconfirmed appointments.
      for (const { e, cal } of unconfirmed) {
        const row = tracked.get(e.id);
        const values = {
          client_id: client.id, ghl_appointment_id: e.id, ghl_contact_id: e.contactId ?? null, calendar_id: cal.calendar_id,
          location_label: cal.location_label, ...(await person(e, row)), scheduled_for: new Date(e.startTime).toISOString(),
          clinic_timezone: tz, ghl_status: e.appointmentStatus ?? null, last_seen_at: seen,
        };
        const { error: upsertError } = await db.from("confirmation_appointments").upsert(values, { onConflict: "client_id,ghl_appointment_id" });
        if (upsertError) throw new Error(`confirmation_appointments: ${upsertError.message}`);
        if (!row) out.added++;
      }

      // Booked straight onto the Confirmed calendar: on the desk as Confirmed, nobody to call.
      const knownContacts = new Set([...known.keys(), ...unconfirmed.flatMap((x) => (x.e.contactId ? [x.e.contactId] : []))]);
      const mainEvents = events.filter((x) => x.cal.kind === "main");
      for (const e of confirmedCalendarAdds(mainEvents.map((x) => x.e), new Set(tracked.keys()), knownContacts, from)) {
        const cal = mainEvents.find((x) => x.e.id === e.id)!.cal;
        const { error: insertError } = await db.from("confirmation_appointments").upsert({
          client_id: client.id, ghl_appointment_id: e.id, ghl_contact_id: e.contactId ?? null, calendar_id: cal.calendar_id,
          location_label: cal.location_label, ...(await person(e, undefined)), scheduled_for: new Date(e.startTime).toISOString(),
          clinic_timezone: tz, ghl_status: e.appointmentStatus ?? null, last_seen_at: seen,
          booked_on: "main", status: "confirmed", status_source: "ghl", status_at: seen, on_main_calendar: true,
        }, { onConflict: "client_id,ghl_appointment_id" });
        if (insertError) throw new Error(`confirmation_appointments: ${insertError.message}`);
        out.added_confirmed++;
      }

      // Tracked appointments that are no longer on the Unconfirmed calendar list: ask GHL what happened.
      const onList = new Set(unconfirmed.map((x) => x.e.id));
      for (const t of tracked.values()) {
        const open = t.status === "unconfirmed" || t.status === "unreachable" || (t.status === "confirmed" && (t.status_source === "csr" || t.booked_on === "main"));
        if (!open) continue;
        const onMainList = events.find((x) => x.e.id === t.ghl_appointment_id && x.cal.kind === "main")?.e ?? null;
        let found: DeskEvent | null = onMainList ?? (onList.has(t.ghl_appointment_id) ? unconfirmed.find((x) => x.e.id === t.ghl_appointment_id)!.e : null);
        if (!found) {
          const one = await get(apiKey, `/calendars/events/appointments/${t.ghl_appointment_id}`);
          const parsed = one.body ? OneEvent.safeParse(one.body) : null;
          found = parsed?.success ? parsed.data.appointment : null;
        }
        const v = ghlVerdict(t, found, mainIds, mainContacts, onList.has(t.ghl_appointment_id));
        const patch: Record<string, unknown> = {};
        if (v.scheduled_for) patch.scheduled_for = v.scheduled_for;
        if (v.ghl_status !== undefined) patch.ghl_status = v.ghl_status;
        if (v.on_main) patch.on_main_calendar = true;
        if (v.status === "confirmed" && t.status !== "confirmed") { Object.assign(patch, { status: "confirmed", status_source: "ghl", status_at: seen }); out.confirmed_in_ghl++; }
        if (v.status === "confirmed" && t.status === "confirmed") patch.status_source = "ghl";
        // A desk confirmation is kept when GHL loses the old appointment (it may have been moved);
        // one booked on the Confirmed calendar is only as good as that booking.
        if (v.status === "cancelled" && (t.status !== "confirmed" || t.booked_on === "main")) { Object.assign(patch, { status: "cancelled", status_source: "ghl", status_at: seen }); out.cancelled_in_ghl++; }
        if (Object.keys(patch).length) await db.from("confirmation_appointments").update(patch).eq("id", t.id);
      }
      out.clinics++;
    } catch (err) {
      out.errors.push(`${client.name}: ${(err as Error).message}`);
    }
  }
  const expired = await db.rpc("confirmations_expire", { p_now: now.toISOString() });
  out.expired = Number(expired.data ?? 0);
  const { count } = await db.from("confirmation_desk").select("id", { count: "exact", head: true });
  out.on_desk = count ?? 0;
  out.ok = out.errors.length === 0;
  return out;
}

/** The "Patient Information (Pain Area, Duration, Additional Details…)" custom field, found by its key in each clinic's GHL. */
export const PATIENT_INFO_FIELD_KEY = "contact.patient_information_pain_area_duration_additional_details";
const FieldsResponse = z.object({ customFields: z.array(z.object({ id: z.string(), fieldKey: z.string().nullable().optional() }).loose()) }).loose();
const ContactFields = z.object({ contact: z.object({ customFields: z.array(z.object({ id: z.string(), value: z.unknown() }).loose()).nullable().optional() }).loose() }).loose();

/** A custom field's value as text: lists joined, empty -> null (pure). */
export function fieldText(value: unknown): string | null {
  const text = Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean).join(", ") : value === null || value === undefined ? "" : String(value).trim();
  return text || null;
}

// Field ids do not change: looked up once per location while the server is warm.
const fieldIds = new Map<string, string | null>();

/**
 * The patient's "Patient Information" answer, read live from GHL when a CSR opens
 * the patient. Read only, and never stored in Genexa OS.
 */
export async function readPatientInformation(opts: { locationId: string; contactId: string; apiKey: string; fetchImpl?: typeof fetch }): Promise<string | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const get = async (path: string) => {
    const res = await doFetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${opts.apiKey}`, Version: "2021-07-28", Accept: "application/json" }, cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GHL ${res.status} on ${path.split("?")[0]}`);
    return res.json() as Promise<unknown>;
  };
  let fieldId = fieldIds.get(opts.locationId);
  if (fieldId === undefined) {
    const fields = FieldsResponse.parse(await get(`/locations/${encodeURIComponent(opts.locationId)}/customFields`)).customFields;
    fieldId = fields.find((f) => f.fieldKey === PATIENT_INFO_FIELD_KEY)?.id ?? null;
    fieldIds.set(opts.locationId, fieldId);
  }
  if (!fieldId) return null;
  const body = await get(`/contacts/${encodeURIComponent(opts.contactId)}`);
  if (!body) return null;
  return fieldText(ContactFields.parse(body).contact.customFields?.find((f) => f.id === fieldId)?.value);
}
