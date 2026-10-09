// Cortana sync: account + ad level metrics per clinic with a cortana_business_id.
// Writes ad_metrics_daily, ad_metrics_ad_daily, ad_metrics_ad_window and
// integration_sync_status. Nothing else.
import type { SupabaseClient } from "@supabase/supabase-js";
import { accountDayRange, addDays, etRange, etToday } from "@/lib/time";
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
  /** How many days back to (re)load, counting today. 2 = today and yesterday. */
  days: number;
  /** Load exactly these dates instead (YYYY-MM-DD, ad-account days). */
  dates?: string[];
  /** Leave integration_sync_status and job_runs alone (a spot re-check, not a sync). */
  quiet?: boolean;
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
  if (!opts.quiet) await db.from("integration_sync_status").update({ last_attempt_at: startedAt }).eq("source", "cortana");

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
        // "Today" in ET can be one day ahead of a western account's own day: that row is simply $0 until the day starts.
        const dates = opts.dates ?? Array.from({ length: days }, (_, i) => addDays(today, -(days - 1 - i)));
        for (const date of dates) {
          // Delivery (spend, impressions, clicks, budget) is filed per ad-account day; site tracking
          // and conversions are real timestamps, so they keep the ET day. Two reads per day.
          const range = accountDayRange(date, date);
          const delivery = accountTotals(await cortana.attribution(client.cortana_business_id, range, "campaign"), scope);
          const day = await cortana.attributionWithTracking(client.cortana_business_id, etRange(date, date), "campaign");
          const tracked = accountTotals(day.rows, scope);
          const account = { ...delivery, cortana_leads: tracked.cortana_leads, cortana_booked: tracked.cortana_booked, cortana_revenue: tracked.cortana_revenue };
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
            const ads = adTotals(await cortana.attribution(client.cortana_business_id, accountDayRange(from, today), "ad"), scope);
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
  if (opts.quiet) return { ok, clients: clientCount, rows, calls: cortana.calls(), errors };
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

/**
 * Before the $0-spend rule is trusted, the figures behind it are read again from
 * Cortana, which revises recent days: every clinic the rule is about to flag, and
 * every clinic with a $0-spend exception already open (so it closes the moment
 * spend appears). Yesterday and today in the account's own days. If spend shows
 * up, the stored zero is replaced and the rule no longer matches.
 */
export async function recheckZeroSpend(opts: { db: SupabaseClient; cortana: CortanaClient }): Promise<{ checked: string[]; error: string | null }> {
  const { db, cortana } = opts;
  const [det, open] = await Promise.all([
    db.from("exception_detections").select("client_id").eq("type", "zero_spend"),
    db.from("exceptions").select("client_id").eq("type", "zero_spend").in("status", ["open", "snoozed"]),
  ]);
  if (det.error || open.error) return { checked: [], error: (det.error ?? open.error)?.message ?? null };
  const ids = [...new Set([...(det.data ?? []), ...(open.data ?? [])].map((r) => r.client_id as string).filter(Boolean))];
  const checked: string[] = [];
  for (const id of ids) {
    const { data: clock } = await db.rpc("ad_account_clock", { p_client: id });
    const local = (clock as { local_date: string }[] | null)?.[0]?.local_date;
    if (!local) continue;
    const r = await syncCortana({ db, cortana, days: 0, dates: [addDays(local, -1), local], windows: false, accountOnly: true, onlyClientIds: [id], quiet: true });
    if (r.errors.length > 0) return { checked, error: r.errors.map((e) => `${e.client}: ${e.error}`).join(" | ") };
    checked.push(id);
  }
  return { checked, error: null };
}
