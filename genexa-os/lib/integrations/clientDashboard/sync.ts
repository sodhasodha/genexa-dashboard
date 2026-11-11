// The client dashboard -> Genexa OS, every 10 minutes. Read only: one call to the dashboard's
// /api/agent/export, which returns each active clinic's patients exactly as the clinic sees them.
// Outcomes, revenue and what a clinic owes then come from here (see 0077_client_dashboard.sql).
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

const Patient = z.object({
  contact_id: z.string().min(1),
  opportunity_id: z.string().nullable(),
  first_name: z.string().nullable(),
  stage: z.enum(["appointments_booked", "showed", "no_show", "closed_won", "not_closed", "repeat_purchase"]),
  consult_at: z.string().nullable(),
  appointment_cancelled: z.boolean(),
  sort_at: z.string().nullable(),
  revenue: z.number(),
  purchase_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});
const Clinic = z.object({
  id: z.uuid(),
  name: z.string(),
  ghl_location_id: z.string().nullable(),
  timezone: z.string(),
  rev_share_pct: z.number().nullable(),
  tracking_from: z.string().nullable(),
  error: z.string().nullable(),
  summary: z.object({ patients: z.number(), outstanding: z.number(), outcomes_overdue: z.number(), closes_missing_revenue: z.number() }).nullable(),
  patients: z.array(Patient),
});
export const ExportResponse = z.object({ at: z.string(), clinics: z.array(Clinic) });

export type DashboardSyncResult = {
  ok: boolean; clinics: number; patients: number; outstanding: number; gone: number;
  /** Dashboard clinics with no Genexa OS client on the same GHL sub-account. */
  unmatched: string[]; errors: string[];
};

export async function syncClientDashboard(opts: { db: SupabaseClient; url: string; token: string; fetchImpl?: typeof fetch }): Promise<DashboardSyncResult> {
  const { db } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const started = new Date().toISOString();
  const out: DashboardSyncResult = { ok: false, clinics: 0, patients: 0, outstanding: 0, gone: 0, unmatched: [], errors: [] };
  await db.from("integration_sync_status").update({ last_attempt_at: started }).eq("source", "client_dashboard");
  const finish = async () => {
    out.ok = out.errors.length === 0;
    await db.from("integration_sync_status").update({
      status: out.ok ? "ok" : "error", rows_processed: out.patients, error: out.ok ? null : out.errors.join("; ").slice(0, 2000),
      ...(out.ok ? { last_success_at: new Date().toISOString() } : {}),
    }).eq("source", "client_dashboard");
    return out;
  };

  let body: z.infer<typeof ExportResponse>;
  try {
    const res = await doFetch(`${opts.url.replace(/\/$/, "")}/api/agent/export`, {
      method: "POST", headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" }, body: "{}", cache: "no-store",
    });
    if (!res.ok) throw new Error(`client dashboard ${res.status}`);
    body = ExportResponse.parse(await res.json());
  } catch (err) {
    out.errors.push((err as Error).message);
    return finish();
  }

  const { data: clients, error } = await db.from("clients").select("id, ghl_location_id").is("deleted_at", null).not("ghl_location_id", "is", null);
  if (error) { out.errors.push(`clients: ${error.message}`); return finish(); }
  const clientByLocation = new Map((clients ?? []).map((c) => [c.ghl_location_id as string, c.id as string]));

  for (const clinic of body.clinics) {
    const clientId = clinic.ghl_location_id ? clientByLocation.get(clinic.ghl_location_id) ?? null : null;
    if (!clientId) out.unmatched.push(clinic.name);
    const ok = clinic.error === null && clinic.summary !== null;
    const { error: clinicError } = await db.from("dashboard_clinics").upsert({
      dashboard_clinic_id: clinic.id, client_id: clientId, name: clinic.name, ghl_location_id: clinic.ghl_location_id, timezone: clinic.timezone,
      rev_share_pct: clinic.rev_share_pct, tracking_from: clinic.tracking_from, last_error: clinic.error,
      ...(ok ? { patients: clinic.summary!.patients, outstanding: clinic.summary!.outstanding, outcomes_overdue: clinic.summary!.outcomes_overdue, closes_missing_revenue: clinic.summary!.closes_missing_revenue, last_success_at: body.at } : {}),
    }, { onConflict: "dashboard_clinic_id" });
    if (clinicError) { out.errors.push(`${clinic.name}: ${clinicError.message}`); continue; }
    // A clinic the dashboard could not read keeps what it had; nothing is marked gone.
    if (!ok) { out.errors.push(`${clinic.name}: ${clinic.error ?? "no summary"}`); continue; }
    if (!clientId) continue;

    const seen = new Date().toISOString();
    if (clinic.patients.length) {
      const { error: e } = await db.from("dashboard_patients").upsert(clinic.patients.map((p) => ({
        client_id: clientId, dashboard_clinic_id: clinic.id, contact_id: p.contact_id, opportunity_id: p.opportunity_id, first_name: p.first_name,
        stage: p.stage, consult_at: p.consult_at, appointment_cancelled: p.appointment_cancelled, sort_at: p.sort_at, revenue: p.revenue,
        purchase_date: p.purchase_date, last_seen_at: seen, gone_at: null,
      })), { onConflict: "client_id,contact_id" });
      if (e) { out.errors.push(`${clinic.name}: dashboard_patients: ${e.message}`); continue; }
    }
    const { error: goneError, count } = await db.from("dashboard_patients").update({ gone_at: seen }, { count: "exact" })
      .eq("client_id", clientId).is("gone_at", null).lt("last_seen_at", seen);
    if (goneError) { out.errors.push(`${clinic.name}: ${goneError.message}`); continue; }
    out.gone += count ?? 0;
    out.clinics++;
    out.patients += clinic.patients.length;
    out.outstanding += clinic.summary!.outstanding;
  }
  return finish();
}
