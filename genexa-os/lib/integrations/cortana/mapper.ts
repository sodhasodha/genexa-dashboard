// Typed mapper for Cortana's attribution endpoint. Pure functions, no I/O.
// Field names come from real responses in fixtures/cortana/.
import { z } from "zod";

const num = z.number().nullable().optional();
const Conversion = z.object({ uniqueCount: z.number().nullable().optional(), revenue: z.number().nullable().optional() }).loose();

export const AttributionRow = z
  .object({
    dimension: z.string().nullable(),
    // Meta ad account id. Null on rows that are not paid Meta delivery
    // ("No Attribution Provided", "Facebook (Organic)", "Bot Traffic", referrers).
    customerId: z.string().nullable().optional(),
    // Meta campaign id (groupBy=campaign) or ad id (groupBy=ad).
    platformEntityId: z.string().nullable().optional(),
    effectiveStatus: z.string().nullable().optional(),
    spent: num,
    impressions: num,
    clicks: num,
    reach: num,
    frequency: num,
    ctr: num,
    metaPlatformLeads: num,
    conversions: z.record(z.string(), Conversion).nullable().optional(),
  })
  .loose();
export type AttributionRow = z.infer<typeof AttributionRow>;

export const AttributionResponse = z
  .object({
    data: z
      .object({
        data: z.array(AttributionRow),
        globalTotals: z.object({ uniqueVisitors: z.number().nullable().optional() }).loose().nullable().optional(),
      })
      .loose(),
  })
  .loose();

/** Site tracking for the window, all sources: page views summed over rows, unique visitors as Cortana de-duplicates them. */
export function trackingTotals(response: z.infer<typeof AttributionResponse>): { page_views: number; unique_visitors: number | null } {
  const rows = response.data.data as (AttributionRow & { pageViews?: number | null })[];
  return {
    page_views: rows.reduce((a, r) => a + (typeof r.pageViews === "number" ? r.pageViews : 0), 0),
    unique_visitors: response.data.globalTotals?.uniqueVisitors ?? null,
  };
}

/** Cortana's event names, confirmed against 30 days of real data (see PLAN.md section 8). */
export const EVENT = { lead: "lead", booked: "unconfirmed_appointment_booked", purchase: "purchase" } as const;

export type CampaignScope = { campaign_name_contains: string | null; ad_account_ids: string[] };

export const isPaidMetaRow = (row: AttributionRow) => !!row.customerId && !!row.platformEntityId;

/** Is this campaign row one of ours? */
export function campaignInScope(row: AttributionRow, scope: CampaignScope | null): boolean {
  if (!isPaidMetaRow(row)) return false;
  if (!scope) return true;
  if (scope.ad_account_ids.length > 0 && !scope.ad_account_ids.includes(row.customerId as string)) return false;
  if (scope.campaign_name_contains && !(row.dimension ?? "").toLowerCase().includes(scope.campaign_name_contains.toLowerCase())) return false;
  return true;
}

/**
 * Ad rows carry no campaign id or name, so a campaign-name scope cannot be
 * applied to them. For those clinics ad-level data is not stored at all
 * rather than stored wrong.
 */
export const adLevelAvailable = (scope: CampaignScope | null) => !scope?.campaign_name_contains;

export function adInScope(row: AttributionRow, scope: CampaignScope | null): boolean {
  if (!isPaidMetaRow(row)) return false;
  if (scope && scope.ad_account_ids.length > 0 && !scope.ad_account_ids.includes(row.customerId as string)) return false;
  return true;
}

const cents = (n: number) => Math.round(n * 100) / 100;
const uniq = (row: AttributionRow, event: string) => row.conversions?.[event]?.uniqueCount ?? 0;

export type AccountTotals = {
  spend: number;
  impressions: number;
  clicks: number;
  reach: number;
  ctr: number | null;
  cpm: number | null;
  frequency: number | null;
  meta_leads: number;
  cortana_leads: number;
  cortana_booked: number;
  cortana_revenue: number;
  campaigns_in_scope: number;
};

/**
 * Account-level totals for a window = the sum of the in-scope campaign rows.
 * No in-scope rows is a real $0 from a successful call, not missing data.
 * CTR and CPM are recomputed from the sums. Frequency is impressions / summed
 * campaign reach: exact for one campaign, slightly low when one person saw two.
 */
export function accountTotals(rows: AttributionRow[], scope: CampaignScope | null): AccountTotals {
  const mine = rows.filter((r) => campaignInScope(r, scope));
  const sum = (f: (r: AttributionRow) => number | null | undefined) => mine.reduce((a, r) => a + (f(r) ?? 0), 0);
  const impressions = sum((r) => r.impressions);
  const clicks = sum((r) => r.clicks);
  const reach = sum((r) => r.reach);
  const spendExact = sum((r) => r.spent);
  return {
    spend: cents(spendExact),
    impressions,
    clicks,
    reach,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    cpm: impressions > 0 ? (spendExact / impressions) * 1000 : null,
    frequency: reach > 0 ? impressions / reach : null,
    meta_leads: sum((r) => r.metaPlatformLeads),
    cortana_leads: sum((r) => uniq(r, EVENT.lead)),
    cortana_booked: sum((r) => uniq(r, EVENT.booked)),
    cortana_revenue: cents(sum((r) => r.conversions?.[EVENT.purchase]?.revenue)),
    campaigns_in_scope: mine.length,
  };
}

export type AdTotals = {
  ad_id: string;
  ad_name: string | null;
  ad_status: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  reach: number;
  ctr: number | null;
  frequency: number | null;
  leads: number;
  booked: number;
};

/** One entry per ad that delivered or converted in the window. Frequency is Cortana's own figure for the ad. */
export function adTotals(rows: AttributionRow[], scope: CampaignScope | null): AdTotals[] {
  if (!adLevelAvailable(scope)) return [];
  return rows
    .filter((r) => adInScope(r, scope))
    .map((r) => {
      const impressions = r.impressions ?? 0;
      const clicks = r.clicks ?? 0;
      return {
        ad_id: r.platformEntityId as string,
        ad_name: r.dimension,
        ad_status: r.effectiveStatus ?? null,
        spend: cents(r.spent ?? 0),
        impressions,
        clicks,
        reach: r.reach ?? 0,
        ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
        frequency: r.frequency ?? null,
        leads: uniq(r, EVENT.lead),
        booked: uniq(r, EVENT.booked),
      };
    });
}

/** Ads worth a daily row: anything that spent, was seen, or produced a lead that day. */
export const adHadActivity = (a: AdTotals) => a.spend > 0 || a.impressions > 0 || a.leads > 0 || a.booked > 0;

// ---------------------------------------------------------------------------
// Conversion events (conversions/entries): one row per event with its contact.
// ---------------------------------------------------------------------------
export const ConversionEntry = z
  .object({
    id: z.string(),
    contactId: z.string().nullable().optional(),
    configName: z.string(),
    eventValue: z.number().nullable().optional(),
    occurredAt: z.string(),
    attributionSource: z.string().nullable().optional(),
    attributionCampaign: z.string().nullable().optional(),
    attributionCampaignId: z.string().nullable().optional(),
    attributionAd: z.string().nullable().optional(),
    attributionAdId: z.string().nullable().optional(),
    contact: z
      .object({
        id: z.string().nullable().optional(),
        name: z.string().nullable().optional(),
        firstName: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
      })
      .loose()
      .nullable()
      .optional(),
  })
  .loose();
export type ConversionEntry = z.infer<typeof ConversionEntry>;
export const ConversionEntriesResponse = z
  .object({ data: z.array(ConversionEntry), pagination: z.object({ hasMore: z.boolean().optional() }).loose().optional() })
  .loose();

/** The events the app counts. Anything else Cortana records is ignored. */
export const FUNNEL_EVENTS = [
  "lead", "unconfirmed_appointment_booked", "appointment_booked", "appointment_shown",
  "appointment_no_show", "appointment_cancelled", "purchase",
] as const;

/**
 * Same rule as the database's lead filter: "test" as a whole word, ZZ prefixes,
 * test domains, or a staff member's own name / email.
 */
export function isTestContact(contact: { name?: string | null; email?: string | null } | null | undefined, staff: { name: string; email: string | null }[]): boolean {
  const name = (contact?.name ?? "").trim().toLowerCase();
  const email = (contact?.email ?? "").trim().toLowerCase();
  const [local = "", domain = ""] = email.split("@");
  if (/\b(test|tests|testing|tester)\b/.test(name) || /^zz/.test(name)) return true;
  if (/(^|[._+-])(test|testing|tester)([._+-]|[0-9]*$)/.test(local) || /^zz/.test(local)) return true;
  if (["test.com", "example.com", "genexascaling.com"].includes(domain)) return true;
  return staff.some((s) => (name !== "" && s.name.toLowerCase() === name) || (email !== "" && s.email?.toLowerCase() === email));
}

export type EventRow = {
  cortana_entry_id: string;
  event: string;
  occurred_at: string;
  value: number | null;
  contact_id: string;
  contact_first_name: string | null;
  is_test: boolean;
  attribution_source: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  ad_id: string | null;
  ad_name: string | null;
};

/** A Cortana entry as a stored event, or null for event types the app does not count. Keeps the first name only. */
export function mapEvent(entry: ConversionEntry, staff: { name: string; email: string | null }[]): EventRow | null {
  if (!(FUNNEL_EVENTS as readonly string[]).includes(entry.configName)) return null;
  const first = entry.contact?.firstName?.trim() || entry.contact?.name?.trim().split(/\s+/)[0] || null;
  return {
    cortana_entry_id: entry.id,
    event: entry.configName,
    occurred_at: entry.occurredAt,
    value: entry.eventValue ?? null,
    // An event with no contact still counts once: it is its own contact.
    contact_id: entry.contactId ?? entry.contact?.id ?? `entry:${entry.id}`,
    contact_first_name: first,
    is_test: isTestContact(entry.contact, staff),
    attribution_source: entry.attributionSource ?? null,
    campaign_id: entry.attributionCampaignId ?? null,
    campaign_name: entry.attributionCampaign ?? null,
    ad_id: entry.attributionAdId ?? null,
    ad_name: entry.attributionAd ?? null,
  };
}
