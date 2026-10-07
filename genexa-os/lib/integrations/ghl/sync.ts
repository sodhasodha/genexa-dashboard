// GHL appointments sync. Reads each clinic's consult calendars (unconfirmed +
// confirmed) for the last 21 days and the next 14, and writes `appointments`.
// Nothing about calls is read: the call centre is moving to Hot Prospector.
import type { SupabaseClient } from "@supabase/supabase-js";
import { GhlCalendarsResponse, GhlEventsResponse, calendarKind, contactIdentity, mapAppointments, type CalendarKind, type GhlEvent } from "./mapper";

const BASE = "https://services.leadconnectorhq.com";
export type GhlKeys = Record<string, { location_id: string; api_key: string }>;
export type GhlSyncResult = { ok: boolean; clinics: number; appointments: number; outcomes_applied: number; skipped: string[]; errors: { client: string; error: string }[] };

export async function syncGhlAppointments(opts: { db: SupabaseClient; keys: GhlKeys; fetchImpl?: typeof fetch; log?: (l: string) => void }): Promise<GhlSyncResult> {
  const { db, log = () => {} } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const startedAt = new Date().toISOString();
  await db.from("integration_sync_status").update({ last_attempt_at: startedAt }).eq("source", "ghl");
  const result: GhlSyncResult = { ok: false, clinics: 0, appointments: 0, outcomes_applied: 0, skipped: [], errors: [] };
  const keyByLocation = new Map(Object.values(opts.keys).map((k) => [k.location_id, k.api_key]));
  const get = async (apiKey: string, path: string): Promise<unknown> => {
    const res = await doFetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${apiKey}`, Version: "2021-04-15", Accept: "application/json" }, cache: "no-store" });
    if (!res.ok) throw new Error(`GHL ${res.status} on ${path.split("?")[0]}`);
    return res.json();
  };
  try {
    const { data: clients, error } = await db.from("clients").select("id, name, ghl_location_id").not("ghl_location_id", "is", null).neq("stage", "churned").is("deleted_at", null).order("name");
    if (error) throw new Error(`clients: ${error.message}`);
    const from = Date.now() - 21 * 86_400_000;
    const to = Date.now() + 14 * 86_400_000;
    for (const client of clients ?? []) {
      const apiKey = keyByLocation.get(client.ghl_location_id as string);
      if (!apiKey) {
        result.skipped.push(`${client.name}: no GHL key for its location`);
        continue;
      }
      try {
        // The clinic's own timezone, as set on its GHL sub-account (used for 10:00-local messages and date parsing).
        const location = (await get(apiKey, `/locations/${client.ghl_location_id}`).catch(() => null)) as { location?: { timezone?: string } } | null;
        const timezone = location?.location?.timezone;
        if (timezone) await db.from("clients").update({ timezone }).eq("id", client.id).neq("timezone", timezone);
        const calendars = GhlCalendarsResponse.parse(await get(apiKey, `/calendars/?locationId=${client.ghl_location_id}`)).calendars;
        const consultCalendars = calendars.map((c) => ({ id: c.id, kind: calendarKind(c.name) })).filter((c): c is { id: string; kind: CalendarKind } => c.kind !== null);
        if (consultCalendars.length === 0) {
          result.skipped.push(`${client.name}: no calendar named "…Unconfirmed…" or "…Confirmed…"`);
          continue;
        }
        const events: { event: GhlEvent; kind: CalendarKind }[] = [];
        for (const cal of consultCalendars) {
          const page = GhlEventsResponse.parse(await get(apiKey, `/calendars/events?locationId=${client.ghl_location_id}&calendarId=${cal.id}&startTime=${from}&endTime=${to}`));
          for (const event of page.events) events.push({ event, kind: cal.kind });
        }
        const rows = mapAppointments(events);
        // A booking made by hand in GHL has no form, so no phone on it. Without one it can never be matched to
        // the outcome the clinic logs, so the key comes from the contact record: once, then it is remembered.
        const missing = rows.filter((r) => !r.contact_key);
        if (missing.length > 0) {
          const { data: known } = await db.from("appointments").select("ghl_contact_id, contact_key").eq("client_id", client.id).not("contact_key", "is", null)
            .in("ghl_contact_id", [...new Set(missing.map((r) => r.ghl_contact_id))]);
          const keyOf = new Map((known ?? []).map((k) => [k.ghl_contact_id as string, k.contact_key as string]));
          let lookups = 0;
          for (const row of missing) {
            if (!keyOf.has(row.ghl_contact_id) && lookups < 60) {
              lookups++;
              const identity = await get(apiKey, `/contacts/${row.ghl_contact_id}`).then(contactIdentity).catch(() => null);
              if (identity?.contact_key) keyOf.set(row.ghl_contact_id, identity.contact_key);
              if (identity?.first_name && !row.contact_first_name) row.contact_first_name = identity.first_name;
            }
            row.contact_key = keyOf.get(row.ghl_contact_id) ?? null;
          }
        }
        const synced_at = new Date().toISOString();
        if (rows.length > 0) {
          // attendance is deliberately not written here: outcomes come from Cortana, and must not be reset.
          const { error: upsertError } = await db.from("appointments").upsert(
            rows.map(({ cancelled: _cancelled, ...r }) => { void _cancelled; return { ...r, client_id: client.id, synced_at }; }),
            { onConflict: "client_id,ghl_appointment_id" },
          );
          if (upsertError) throw new Error(`appointments: ${upsertError.message}`);
          // A copy of a consult that lost to another copy (the unconfirmed twin of a confirmed booking, or a
          // booking since moved) must stop counting as a consult waiting for an outcome.
          const keep = rows.map((r) => r.ghl_appointment_id);
          const { error: staleError } = await db.from("appointments")
            .update({ attendance: "rescheduled_before_consult", attendance_logged_at: synced_at })
            .eq("client_id", client.id).eq("attendance", "scheduled").not("ghl_appointment_id", "is", null)
            .gte("scheduled_for", new Date(from).toISOString()).lte("scheduled_for", new Date(to).toISOString())
            .not("ghl_appointment_id", "in", `(${keep.map((k) => `"${k}"`).join(",")})`);
          if (staleError) throw new Error(`appointments: ${staleError.message}`);
          const cancelledIds = rows.filter((r) => r.cancelled).map((r) => r.ghl_appointment_id);
          if (cancelledIds.length > 0) {
            const { error: cancelError } = await db.from("appointments").update({ attendance: "cancelled", attendance_logged_at: synced_at })
              .eq("client_id", client.id).in("ghl_appointment_id", cancelledIds).eq("attendance", "scheduled");
            if (cancelError) throw new Error(`appointments: ${cancelError.message}`);
          }
        }
        result.clinics++;
        result.appointments += rows.length;
        log(`ok   ${client.name}: ${rows.length} consults`);
      } catch (err) {
        result.errors.push({ client: client.name as string, error: (err as Error).message });
        log(`FAIL ${client.name}: ${(err as Error).message}`);
      }
    }
    const applied = await db.rpc("appointments_apply_outcomes");
    if (applied.error) throw new Error(`appointments_apply_outcomes: ${applied.error.message}`);
    result.outcomes_applied = Number(applied.data ?? 0);
    result.ok = result.errors.length === 0 && result.clinics > 0;
  } catch (err) {
    result.errors.push({ client: "(all)", error: (err as Error).message });
  }
  const finishedAt = new Date().toISOString();
  const errorText = result.errors.map((e) => `${e.client}: ${e.error}`).join(" | ").slice(0, 1000) || null;
  await db.from("integration_sync_status").update({ status: result.ok ? "ok" : "error", rows_processed: result.appointments, error: result.ok ? null : errorText, ...(result.ok ? { last_success_at: finishedAt } : {}) }).eq("source", "ghl");
  await db.from("job_runs").insert({ job: "ghl-appointments", started_at: startedAt, finished_at: finishedAt, ok: result.ok, rows_processed: result.appointments, error: result.ok ? null : errorText });
  return result;
}
