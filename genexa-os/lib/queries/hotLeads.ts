import "server-only";
import { createClient } from "@/lib/supabase/server";
import { WINDOWS } from "@/lib/hotLeads/config";
import { leadTier, REASON_LABEL, type HotReason } from "@/lib/hotLeads/rules";
import { ghlContactUrl } from "@/lib/queries/confirmations";

export type HotLeadRow = {
  id: string; clinic: string; patient_name: string; reason: HotReason; label: string;
  /** 0 wants to reschedule, 1 texted in the last 2h, 2 callback, 3 missed call (not detectable, unused), 4 the rest. */
  tier: number; sort_at: string; ghl_url: string | null;
  /** Someone opened it in the last 15 minutes: greyed out for everyone. */
  claimed: { by: string; at: string } | null;
};

/** A clinic whose sync has not seen a lead for this long is failing: its leads are hidden rather than risk calling someone who has since booked. */
const STALE_MS = 20 * 60_000;

type ListRow = {
  id: string; clinic: string; ghl_location_id: string | null; ghl_contact_id: string; patient_name: string | null; reason: HotReason;
  signal_at: string; last_reply_at: string | null; last_seen_at: string; opened_at: string | null; opened_by: string | null;
};

/** Hot leads, best first: tier, then newest within the tier. */
export async function getHotLeads(): Promise<HotLeadRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("hot_lead_list").select("*");
  if (error) throw new Error(`hot_lead_list: ${error.message}`);
  const now = Date.now();
  return ((data ?? []) as ListRow[])
    .filter((r) => now - Date.parse(r.last_seen_at) <= STALE_MS)
    .map((r) => {
      const tier = leadTier(r, now);
      return {
        id: r.id, clinic: r.clinic, patient_name: r.patient_name?.trim() || "No name in GHL", reason: r.reason, label: REASON_LABEL[r.reason], tier,
        sort_at: tier === 1 && r.last_reply_at ? r.last_reply_at : r.signal_at,
        ghl_url: ghlContactUrl(r.ghl_location_id, r.ghl_contact_id),
        claimed: r.opened_at && r.opened_by && now - Date.parse(r.opened_at) < WINDOWS.claimMinutes * 60_000 ? { by: r.opened_by, at: r.opened_at } : null,
      };
    })
    .sort((a, b) => a.tier - b.tier || Date.parse(b.sort_at) - Date.parse(a.sort_at));
}

/** Leads nobody has opened in the last 15 minutes. */
export const waiting = (rows: HotLeadRow[]) => rows.filter((r) => !r.claimed).length;
