// Fathom sync: meetings since a date -> fathom_calls; a call with a client also
// becomes a touch (which moves the client's last contact); a call with a known
// prospect fills in that prospect's call date and recording link.
import type { SupabaseClient } from "@supabase/supabase-js";
import { FathomMeetingsResponse, mapMeeting, type CallRow, type FathomContext } from "./mapper";

const BASE = "https://api.fathom.ai/external/v1";
export type FathomSyncResult = { ok: boolean; calls: number; client: number; prospect: number; internal: number; unmatched: number; touches_added: number; error: string | null };

export async function syncFathom(opts: { db: SupabaseClient; apiKey: string; since: string; fetchImpl?: typeof fetch }): Promise<FathomSyncResult> {
  const { db } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const startedAt = new Date().toISOString();
  await db.from("integration_sync_status").update({ last_attempt_at: startedAt }).eq("source", "fathom");
  const result: FathomSyncResult = { ok: false, calls: 0, client: 0, prospect: 0, internal: 0, unmatched: 0, touches_added: 0, error: null };
  try {
    const [clients, payments, members, prospects, staff] = await Promise.all([
      db.from("clients").select("id, name, contact_name, kickoff_url, whop_customer_ids").is("deleted_at", null),
      db.from("payments").select("client_id, customer_email").not("client_id", "is", null).not("customer_email", "is", null),
      db.from("whop_memberships").select("client_id, email").not("client_id", "is", null).not("email", "is", null),
      db.from("prospects").select("id, name, call_date, fathom_url").is("deleted_at", null),
      db.from("staff").select("id, email"),
    ]);
    for (const r of [clients, payments, members, prospects, staff]) if (r.error) throw new Error(r.error.message);
    const emailsOf = (id: string) => [...new Set([...(payments.data ?? []).filter((p) => p.client_id === id).map((p) => (p.customer_email as string).toLowerCase()), ...(members.data ?? []).filter((m) => m.client_id === id).map((m) => (m.email as string).toLowerCase())])];
    const ctx: FathomContext = {
      clients: (clients.data ?? []).map((c) => ({ ...(c as { id: string; name: string; contact_name: string | null; kickoff_url: string | null; whop_customer_ids: string[] }), emails: emailsOf(c.id as string) })),
      prospects: (prospects.data ?? []).map((p) => ({ id: p.id as string, name: p.name as string })),
      staffEmails: (staff.data ?? []).map((s) => s.email).filter((e): e is string => !!e),
    };

    const rows: CallRow[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 100; page++) {
      const qs = new URLSearchParams({ created_after: `${opts.since}T00:00:00Z` });
      if (cursor) qs.set("cursor", cursor);
      const res = await doFetch(`${BASE}/meetings?${qs}`, { headers: { "X-Api-Key": opts.apiKey }, cache: "no-store" });
      if (!res.ok) throw new Error(`Fathom ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
      const parsed = FathomMeetingsResponse.safeParse(await res.json());
      if (!parsed.success) throw new Error(`Fathom meetings did not match the expected shape: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
      for (const m of parsed.data.items) rows.push(mapMeeting(m, ctx));
      cursor = parsed.data.next_cursor ?? null;
      if (!cursor) break;
    }

    const synced_at = new Date().toISOString();
    // Calls a person has sorted out in Data review keep that answer.
    const { data: resolved, error: resolvedError } = await db.from("fathom_calls").select("recording_id").not("resolved_by", "is", null);
    if (resolvedError) throw new Error(`fathom_calls: ${resolvedError.message}`);
    const keep = new Set((resolved ?? []).map((r) => r.recording_id as string));
    const fresh = rows.filter((r) => !keep.has(r.recording_id));
    rows.length = 0;
    rows.push(...fresh);
    if (rows.length > 0) {
      const { error } = await db.from("fathom_calls").upsert(rows.map(({ recorded_by_email: _e, ...r }) => { void _e; return { ...r, synced_at }; }), { onConflict: "recording_id" });
      if (error) throw new Error(`fathom_calls: ${error.message}`);
    }
    const staffByEmail = new Map((staff.data ?? []).filter((s) => s.email).map((s) => [(s.email as string).toLowerCase(), s.id as string]));
    for (const r of rows) {
      result[r.kind]++;
      if (r.kind === "client" && r.client_id) {
        const ref = `fathom:${r.recording_id}`;
        const { data: has } = await db.from("touches").select("id").eq("external_ref", ref).maybeSingle();
        if (!has) {
          const { error } = await db.from("touches").insert({
            client_id: r.client_id, at: r.started_at, kind: "call", external_ref: ref,
            by_id: (r.recorded_by_email && staffByEmail.get(r.recorded_by_email)) || null,
            note: `${r.title ?? "Call"} (Fathom) ${r.share_url ?? r.url ?? ""}`.trim(),
          });
          if (error) throw new Error(`touches: ${error.message}`);
          result.touches_added++;
        }
      }
      if (r.kind === "prospect" && r.prospect_id) {
        const p = (prospects.data ?? []).find((x) => x.id === r.prospect_id);
        const patch: Record<string, string> = {};
        if (p && !p.fathom_url && (r.share_url ?? r.url)) patch.fathom_url = (r.share_url ?? r.url) as string;
        if (p && !p.call_date) patch.call_date = r.started_at.slice(0, 10);
        if (Object.keys(patch).length > 0) await db.from("prospects").update(patch).eq("id", r.prospect_id);
      }
    }
    result.calls = rows.length;
    result.ok = true;
  } catch (err) {
    result.error = (err as Error).message;
  }
  const finishedAt = new Date().toISOString();
  await db.from("integration_sync_status").update({ status: result.ok ? "ok" : "error", rows_processed: result.calls, error: result.error, ...(result.ok ? { last_success_at: finishedAt } : {}) }).eq("source", "fathom");
  await db.from("job_runs").insert({ job: "fathom-sync", started_at: startedAt, finished_at: finishedAt, ok: result.ok, rows_processed: result.calls, error: result.error });
  return result;
}
