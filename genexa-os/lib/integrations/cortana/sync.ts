// Cortana sync: account + ad level metrics per clinic with a cortana_business_id.
// Writes ad_metrics_daily, ad_metrics_ad_daily, ad_metrics_ad_window and
// integration_sync_status. Nothing else.
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays, etRange, etToday } from "@/lib/time";
import type { CortanaClient } from "./client";
import { accountTotals, adHadActivity, adLevelAvailable, adTotals, mapEvent, type CampaignScope } from "./mapper";

/** "All-time" window start. Genexa's first clinic ads are later than this. */
const ALL_TIME_FROM = "2025-01-01";

export type CortanaSyncResult = {
  ok: boolean;
  clients: number;
  rows: number;
  calls: number;
  errors: { client: string; error: string }[];
};

type ClientRow = { id: string; name: string; cortana_business_id: string };

export async function syncCortana(opts: {
  db: SupabaseClient;
  cortana: CortanaClient;
  /** How many ET days back to (re)load, counting today. 2 = today and yesterday. */
  days: number;
  /** Refresh the 7d / all-time per-ad windows as well. */
  windows?: boolean;
  /** Skip per-ad rows: account totals and site tracking only (half the calls; used for long backfills). */
  accountOnly?: boolean;
  onlyClientIds?: string[];
  log?: (line: string) => void;
}): Promise<CortanaSyncResult> {
  const { db, cortana, days, log = () => {} } = opts;
  const startedAt = new Date().toISOString();
  const today = etToday();
  await db.from("integration_sync_status").update({ last_attempt_at: startedAt }).eq("source", "cortana");

  const errors: CortanaSyncResult["errors"] = [];
  let rows = 0;
  let clientCount = 0;
  try {
    let q = db.from("clients").select("id, name, cortana_business_id").not("cortana_business_id", "is", null).neq("stage", "churned").is("deleted_at", null);
    if (opts.onlyClientIds?.length) q = q.in("id", opts.onlyClientIds);
    const { data: clients, error: clientsError } = await q.order("name");
    if (clientsError) throw new Error(`clients: ${clientsError.message}`);
    const { data: scopes, error: scopeError } = await db.from("client_campaign_scope").select("client_id, campaign_name_contains, ad_account_ids");
    if (scopeError) throw new Error(`client_campaign_scope: ${scopeError.message}`);
    const scopeOf = (clientId: string): CampaignScope | null => {
      const s = scopes?.find((x) => x.client_id === clientId);
      return s ? { campaign_name_contains: s.campaign_name_contains, ad_account_ids: s.ad_account_ids ?? [] } : null;
    };

    for (const client of (clients ?? []) as ClientRow[]) {
      clientCount++;
      const scope = scopeOf(client.id);
      const withAds = adLevelAvailable(scope) && !opts.accountOnly;
      try {
        const synced_at = new Date().toISOString();
        for (let back = days - 1; back >= 0; back--) {
          const date = addDays(today, -back);
          const range = etRange(date, date);
          const day = await cortana.attributionWithTracking(client.cortana_business_id, range, "campaign");
          const account = accountTotals(day.rows, scope);
          const { error } = await db.from("ad_metrics_daily").upsert(
            { client_id: client.id, date, ...account, page_views: day.page_views, unique_visitors: day.unique_visitors, synced_at },
            { onConflict: "client_id,date" },
          );
          if (error) throw new Error(`ad_metrics_daily: ${error.message}`);
          rows++;
          if (withAds && account.campaigns_in_scope > 0) {
            const ads = adTotals(await cortana.attribution(client.cortana_business_id, range, "ad"), scope).filter(adHadActivity);
            if (ads.length > 0) {
              const { error: adError } = await db.from("ad_metrics_ad_daily").upsert(
                ads.map((a) => ({
                  client_id: client.id, date, ad_id: a.ad_id, ad_name: a.ad_name, ad_status: a.ad_status, spend: a.spend,
                  impressions: a.impressions, clicks: a.clicks, reach: a.reach, ctr: a.ctr, frequency: a.frequency,
                  leads: a.leads, booked: a.booked, synced_at,
                })),
                { onConflict: "client_id,ad_id,date" },
              );
              if (adError) throw new Error(`ad_metrics_ad_daily: ${adError.message}`);
              rows += ads.length;
            }
          }
        }
        if (opts.windows !== false && withAds) {
          for (const [period, from] of [["7d", addDays(today, -6)], ["all", ALL_TIME_FROM]] as const) {
            const ads = adTotals(await cortana.attribution(client.cortana_business_id, etRange(from, today), "ad"), scope);
            if (ads.length === 0) continue;
            const { error } = await db.from("ad_metrics_ad_window").upsert(
              ads.map((a) => ({
                client_id: client.id, period, window_start: from, window_end: today, ad_id: a.ad_id, ad_name: a.ad_name,
                ad_status: a.ad_status, spend: a.spend, impressions: a.impressions, clicks: a.clicks, reach: a.reach, ctr: a.ctr,
                frequency: a.frequency, leads: a.leads, booked: a.booked, synced_at,
              })),
              { onConflict: "client_id,ad_id,period" },
            );
            if (error) throw new Error(`ad_metrics_ad_window: ${error.message}`);
            rows += ads.length;
          }
        }
        log(`ok   ${client.name}`);
      } catch (err) {
        errors.push({ client: client.name, error: (err as Error).message });
        log(`FAIL ${client.name}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    errors.push({ client: "(all)", error: (err as Error).message });
  }

  // Success is only recorded when every clinic synced. A partial run leaves
  // last_success_at alone, so the source goes stale rather than half-right.
  const ok = errors.length === 0 && clientCount > 0;
  const finishedAt = new Date().toISOString();
  await db
    .from("integration_sync_status")
    .update({
      status: ok ? "ok" : "error",
      rows_processed: rows,
      error: ok ? null : errors.map((e) => `${e.client}: ${e.error}`).join(" | ").slice(0, 1000) || "No clinics have a Cortana business id",
      ...(ok ? { last_success_at: finishedAt } : {}),
    })
    .eq("source", "cortana");
  await db.from("job_runs").insert({ job: "cortana-sync", started_at: startedAt, finished_at: finishedAt, ok, rows_processed: rows, error: ok ? null : errors.map((e) => `${e.client}: ${e.error}`).join(" | ").slice(0, 1000) });
  return { ok, clients: clientCount, rows, calls: cortana.calls(), errors };
}

/**
 * Cortana conversion events since `from` (ET date) for every connected clinic:
 * leads, bookings, confirmations, shows, no-shows, cancellations and purchases,
 * from every source. Writes cortana_events only. Re-reading a window is safe:
 * rows are keyed on Cortana's entry id.
 */
export async function syncCortanaEvents(opts: {
  db: SupabaseClient;
  cortana: CortanaClient;
  from: string;
  log?: (line: string) => void;
}): Promise<CortanaSyncResult> {
  const { db, cortana, log = () => {} } = opts;
  const startedAt = new Date().toISOString();
  const errors: CortanaSyncResult["errors"] = [];
  let rows = 0;
  let clientCount = 0;
  try {
    const { data: clients, error } = await db.from("clients").select("id, name, cortana_business_id").not("cortana_business_id", "is", null).neq("stage", "churned").is("deleted_at", null).order("name");
    if (error) throw new Error(`clients: ${error.message}`);
    const { data: staff, error: staffError } = await db.from("staff").select("name, email");
    if (staffError) throw new Error(`staff: ${staffError.message}`);
    const fromIso = etRange(opts.from, opts.from).start;
    for (const client of (clients ?? []) as ClientRow[]) {
      clientCount++;
      try {
        const entries = await cortana.entries(client.cortana_business_id, fromIso);
        const synced_at = new Date().toISOString();
        const events = entries.map((e) => mapEvent(e, staff ?? [])).filter((e) => e !== null);
        for (let i = 0; i < events.length; i += 500) {
          const { error: upsertError } = await db
            .from("cortana_events")
            .upsert(events.slice(i, i + 500).map((e) => ({ ...e, client_id: client.id, synced_at })), { onConflict: "client_id,cortana_entry_id" });
          if (upsertError) throw new Error(`cortana_events: ${upsertError.message}`);
        }
        rows += events.length;
        log(`ok   ${client.name}: ${events.length} events`);
      } catch (err) {
        errors.push({ client: client.name, error: (err as Error).message });
        log(`FAIL ${client.name}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    errors.push({ client: "(all)", error: (err as Error).message });
  }
  const ok = errors.length === 0 && clientCount > 0;
  await db.from("job_runs").insert({ job: "cortana-events", started_at: startedAt, finished_at: new Date().toISOString(), ok, rows_processed: rows, error: ok ? null : errors.map((e) => `${e.client}: ${e.error}`).join(" | ").slice(0, 1000) });
  // The freshness dot follows the ad sync; a failed event sync marks the source as errored so it shows.
  if (!ok) await db.from("integration_sync_status").update({ status: "error", error: `events: ${errors.map((e) => `${e.client}: ${e.error}`).join(" | ").slice(0, 900)}` }).eq("source", "cortana");
  return { ok, clients: clientCount, rows, calls: cortana.calls(), errors };
}
