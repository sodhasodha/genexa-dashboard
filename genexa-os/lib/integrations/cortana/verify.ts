// The daily check of our copy against Cortana, clinic by clinic, with corrections.
// Cortana is the record: where the two differ, ours is changed to match.
import type { SupabaseClient } from "@supabase/supabase-js";
import { accountDayRange, addDays, etRange, etToday } from "@/lib/time";
import type { CortanaClient } from "./client";
import { accountTotals, mapEvent, type CampaignScope } from "./mapper";
import { syncCortana } from "./sync";

/** History is kept from here; older events are not touched. */
export const VERIFY_EVENTS_FROM = "2026-08-01";
/** Ad spend is compared over this many finished account days. */
export const VERIFY_SPEND_DAYS = 30;

export type EventLike = { cortana_entry_id: string; event: string; value: number | null; occurred_at: string };

/** What differs between Cortana's events and ours (pure). */
export function diffEvents(theirs: EventLike[], ours: EventLike[]): { missing: string[]; changed: string[]; gone: string[] } {
  const mine = new Map(ours.map((e) => [e.cortana_entry_id, e]));
  const have = new Set(theirs.map((e) => e.cortana_entry_id));
  const same = (a: EventLike, b: EventLike) =>
    a.event === b.event && Number(a.value ?? 0) === Number(b.value ?? 0) && new Date(a.occurred_at).getTime() === new Date(b.occurred_at).getTime();
  return {
    missing: theirs.filter((e) => !mine.has(e.cortana_entry_id)).map((e) => e.cortana_entry_id),
    changed: theirs.filter((e) => mine.has(e.cortana_entry_id) && !same(e, mine.get(e.cortana_entry_id) as EventLike)).map((e) => e.cortana_entry_id),
    gone: ours.filter((e) => !have.has(e.cortana_entry_id)).map((e) => e.cortana_entry_id),
  };
}

/**
 * Is it safe to treat "not in Cortana's answer" as "removed in Cortana"? Not when
 * the answer is empty or far smaller than what we hold: that is a bad read, not a clean-up.
 */
export function safeToRemove(theirCount: number, ourCount: number, goneCount: number): boolean {
  if (goneCount === 0) return true;
  if (theirCount === 0) return false;
  return goneCount <= Math.max(5, Math.ceil(ourCount * 0.2));
}

export type VerifyResult = {
  ok: boolean;
  checked: { clinic: string; matched: boolean; added: number; changed: number; removed: number; spend_days_reread: number; error: string | null }[];
  /** Clinics left for the next run because the time budget ran out. */
  left: number;
};

export async function verifyCortana(opts: { db: SupabaseClient; cortana: CortanaClient; budgetMs?: number; onlyClientIds?: string[] }): Promise<VerifyResult> {
  const { db, cortana } = opts;
  const started = Date.now();
  const budget = opts.budgetMs ?? 230_000;
  const out: VerifyResult = { ok: true, checked: [], left: 0 };
  let q = db.from("clients").select("id, name, cortana_business_id").not("cortana_business_id", "is", null).neq("stage", "churned").is("deleted_at", null);
  if (opts.onlyClientIds?.length) q = q.in("id", opts.onlyClientIds);
  const [{ data: clients, error }, { data: scopes }, { data: staff }, { data: latest }] = await Promise.all([
    q,
    db.from("client_campaign_scope").select("client_id, campaign_name_contains, campaign_name_excludes, ad_account_ids"),
    db.from("staff").select("name, email"),
    db.from("cortana_check_latest").select("client_id, checked_at"),
  ]);
  if (error) throw new Error(`clients: ${error.message}`);
  const lastChecked = new Map((latest ?? []).map((l) => [l.client_id as string, l.checked_at as string]));
  // Longest-unchecked first, so every clinic gets its turn even when one run cannot do them all.
  const order = [...(clients ?? [])].sort((a, b) => (lastChecked.get(a.id) ?? "").localeCompare(lastChecked.get(b.id) ?? ""));
  const spendTo = addDays(etToday(), -1);
  const spendFrom = addDays(spendTo, -(VERIFY_SPEND_DAYS - 1));
  const eventsFromIso = etRange(VERIFY_EVENTS_FROM, VERIFY_EVENTS_FROM).start;

  for (const [i, client] of order.entries()) {
    if (Date.now() - started > budget) { out.left = order.length - i; break; }
    const row = { clinic: client.name as string, matched: true, added: 0, changed: 0, removed: 0, spend_days_reread: 0, error: null as string | null };
    let spendOurs: number | null = null, spendCortana: number | null = null, eventsCortana: number | null = null;
    try {
      // 1. Conversion events: everything since the start of history.
      const entries = (await cortana.entries(client.cortana_business_id as string, eventsFromIso)).map((e) => mapEvent(e, staff ?? [])).filter((e) => e !== null);
      eventsCortana = entries.length;
      const ours: EventLike[] = [];
      for (let from = 0; ; from += 1000) {
        const { data: page, error: pageError } = await db.from("cortana_events").select("cortana_entry_id, event, value, occurred_at")
          .eq("client_id", client.id).gte("occurred_at", eventsFromIso).order("cortana_entry_id").range(from, from + 999);
        if (pageError) throw new Error(`cortana_events: ${pageError.message}`);
        ours.push(...((page ?? []) as EventLike[]));
        if ((page ?? []).length < 1000) break;
      }
      const d = diffEvents(entries as EventLike[], ours);
      const fix = new Set([...d.missing, ...d.changed]);
      const rows = entries.filter((e) => fix.has(e.cortana_entry_id));
      const synced_at = new Date().toISOString();
      for (let k = 0; k < rows.length; k += 500) {
        const { error: upsertError } = await db.from("cortana_events")
          .upsert(rows.slice(k, k + 500).map((e) => ({ ...e, client_id: client.id, synced_at })), { onConflict: "client_id,cortana_entry_id" });
        if (upsertError) throw new Error(`cortana_events: ${upsertError.message}`);
      }
      row.added = d.missing.length;
      row.changed = d.changed.length;
      if (d.gone.length > 0) {
        if (!safeToRemove(entries.length, ours.length, d.gone.length)) {
          row.error = `Cortana returned ${entries.length} events where we hold ${ours.length}: nothing was removed`;
        } else {
          const { data: n, error: archiveError } = await db.rpc("cortana_events_archive", { p_client: client.id, p_entry_ids: d.gone });
          if (archiveError) throw new Error(`cortana_events_archive: ${archiveError.message}`);
          row.removed = Number(n ?? 0);
        }
      }

      // 2. Ad spend over the last finished account days: one read for the total, days re-read only if it differs.
      const s = scopes?.find((x) => x.client_id === client.id);
      const scope: CampaignScope | null = s ? { campaign_name_contains: s.campaign_name_contains, campaign_name_excludes: s.campaign_name_excludes, ad_account_ids: s.ad_account_ids ?? [] } : null;
      spendCortana = accountTotals(await cortana.attribution(client.cortana_business_id as string, accountDayRange(spendFrom, spendTo), "campaign"), scope).spend;
      const { data: days } = await db.from("ad_metrics_daily").select("spend").eq("client_id", client.id).gte("date", spendFrom).lte("date", spendTo);
      spendOurs = Math.round((days ?? []).reduce((a, x) => a + Number(x.spend), 0) * 100) / 100;
      // Each stored day is rounded to the cent, so the sum may be a few cents off the total.
      const tolerance = 0.005 * VERIFY_SPEND_DAYS + 0.01;
      if ((days ?? []).length < VERIFY_SPEND_DAYS || Math.abs(spendOurs - spendCortana) > tolerance) {
        const dates = Array.from({ length: VERIFY_SPEND_DAYS }, (_, k) => addDays(spendFrom, k));
        const r = await syncCortana({ db, cortana, days: 0, dates, onlyClientIds: [client.id as string], accountOnly: true, windows: false, quiet: true });
        if (r.errors.length > 0) throw new Error(r.errors[0].error);
        row.spend_days_reread = dates.length;
      }
      row.matched = row.added + row.changed + row.removed + row.spend_days_reread === 0 && !row.error;
    } catch (err) {
      row.error = (err as Error).message.slice(0, 500);
      row.matched = false;
    }
    if (row.error) out.ok = false;
    await db.from("cortana_checks").insert({
      client_id: client.id, events_from: VERIFY_EVENTS_FROM, spend_from: spendFrom, spend_to: spendTo, spend_ours: spendOurs, spend_cortana: spendCortana,
      spend_days_reread: row.spend_days_reread, events_cortana: eventsCortana, events_added: row.added, events_changed: row.changed, events_removed: row.removed,
      matched: row.matched, error: row.error,
    });
    out.checked.push(row);
  }
  return out;
}
