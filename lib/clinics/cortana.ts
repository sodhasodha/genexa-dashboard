import { unstable_cache } from 'next/cache'
import { BINDINGS } from '@/lib/clinics/bindings'
import { cortanaGet } from '@/lib/clinics/client'
import { CACHE_SECONDS, type ClinicConfig } from '@/lib/clinics/config'
import type { ClinicRaw, ClinicSource, DayPoint, Window } from '@/lib/clinics/types'

// Cortana REST adapter (server-side only).
//
// Per roster business:
//  1. attribution?groupBy=campaign for the window → one row per campaign with its Meta ad account id
//     (customerId), campaign id (platformEntityId), spend, impressions, link clicks, Meta leads and
//     unique counts per conversion event.
//  2. attribution for a 60-day lookback → daily series (sparkline, last lead / last spend)
//     and which events the clinic tracks at all. Cortana only returns dailySummary when a filter is
//     set, so this call filters to the funnel events.
//  Campaign rows from every business are pooled by campaign id, then handed to clinics by the explicit
//  binding in bindings.ts — a business's own row set is never trusted to be "its" campaigns.
//  Each call is cached 15 min (windows end on a 15-min boundary, so keys are stable); failures
//  aren't cached. The REST API ignores campaign filters and dailySummary spend is business-wide,
//  so daily spend is pro-rated by the clinic's share of that business's window spend.

const DAY = 86400000
const LOOKBACK_DAYS = 60
const SEP = '|||' // Cortana's multi-value separator

const EV = {
  lead: 'lead',
  booked: 'unconfirmed_appointment_booked',
  confirmed: 'appointment_booked',
  shown: 'appointment_shown',
  purchase: 'purchase',
} as const

const ROW_FIELDS = ['dimension', 'customerId', 'platformEntityId', 'effectiveStatus', 'spent', 'impressions', 'inlineLinkClicks', 'metaPlatformLeads', 'totalRevenue', 'conversions'] as const

async function fetchAttribution(businessId: string, qs: string) {
  const json = await cortanaGet(`businesses/${businessId}/attribution?${qs}`)
  // Keep only what the KPIs use so cache entries stay small.
  return {
    rows: ((json?.data?.data || []) as any[]).map((r) => Object.fromEntries(ROW_FIELDS.map((f) => [f, r[f] ?? null]))),
    daily: (json?.data?.dailySummary || []) as any[],
    totals: (json?.data?.globalTotals || {}) as { uniqueByEventType?: Record<string, number> },
  }
}
type Attribution = Awaited<ReturnType<typeof fetchAttribution>>
const cachedAttribution = unstable_cache(fetchAttribution, ['cortana-attribution-v2'], { revalidate: CACHE_SECONDS, tags: ['clinic-kpis'] })
const attribution = (businessId: string, params: Record<string, string>) => cachedAttribution(businessId, new URLSearchParams(params).toString())

const unique = (rows: any[], ev: string) => rows.reduce((s, r) => s + (r.conversions?.[ev]?.uniqueCount ?? r.conversions?.[ev]?.count ?? 0), 0)
const revenueOf = (rows: any[]) =>
  rows.reduce((s, r) => s + (r.conversions?.[EV.purchase]?.revenue ?? 0), 0) || rows.reduce((s, r) => s + (r.totalRevenue || 0), 0)
const dayCount = (d: any, ev: string) => d.conversions?.[ev]?.count ?? 0
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const num = (v: unknown) => Number(v) || 0

// A Meta campaign as Cortana reports it for a window, whichever business surfaced it.
export type Campaign = { id: string; name: string; account: string; status: string | null; business: string; spend: number; impressions: number; linkClicks: number; metaLeads: number }

// Pool campaign rows across businesses (a campaign surfaced by two businesses counts once).
export function poolCampaigns(byBusiness: Record<string, any[]>): Map<string, Campaign> {
  const out = new Map<string, Campaign>()
  for (const [business, rows] of Object.entries(byBusiness))
    for (const r of rows) {
      if (!r.platformEntityId || !r.customerId || out.has(String(r.platformEntityId))) continue
      out.set(String(r.platformEntityId), {
        id: String(r.platformEntityId),
        name: r.dimension || '',
        account: String(r.customerId),
        status: r.effectiveStatus,
        business,
        spend: num(r.spent),
        impressions: num(r.impressions),
        linkClicks: num(r.inlineLinkClicks),
        metaLeads: num(r.metaPlatformLeads),
      })
    }
  return out
}

// The campaigns a clinic is bound to: in a bound account AND (listed by id OR prefix-matched and not
// listed under another clinic).
export function ownedCampaigns(businessId: string, pool: Map<string, Campaign>): Campaign[] {
  const b = BINDINGS[businessId]
  if (!b) return []
  const listedElsewhere = (id: string) => Object.entries(BINDINGS).some(([other, ob]) => other !== businessId && ob.campaignIds.includes(id))
  return [...pool.values()].filter(
    (c) => b.accounts.includes(c.account) && (b.campaignIds.includes(c.id) || (!!b.campaignPrefix?.test(c.name) && !listedElsewhere(c.id)))
  )
}

export const unboundRaw = (): ClinicRaw => ({
  bound: false,
  spend: 0,
  impressions: 0,
  linkClicks: 0,
  leads: 0,
  leadsFrom: 'cortana',
  booked: 0,
  confirmed: 0,
  shown: 0,
  purchases: 0,
  revenue: 0,
  tracked: { lead: false, booked: false, confirmed: false, shown: false, purchase: false },
  daily: [],
  lastLeadDate: null,
  lastSpendDate: null,
  excludedCampaigns: 0,
})

function buildRaw(clinic: ClinicConfig, window: Window, win: Record<string, Attribution>, hist: Record<string, Attribution>, pool: Map<string, Campaign>): ClinicRaw {
  const id = clinic.businessId
  if (!BINDINGS[id]) return unboundRaw()
  const owned = ownedCampaigns(id, pool)
  const ownedIds = new Set(owned.map((c) => c.id))
  const sum = (k: 'spend' | 'impressions' | 'linkClicks' | 'metaLeads') => owned.reduce((s, c) => s + c[k], 0)

  // CRM conversions come from the clinic's own business: rows on its bound campaigns plus
  // organic / unattributed rows (the CRM sub-account is ours). Rows on other campaigns are dropped.
  const own = win[id].rows
  const rows = own.filter((r) => !r.platformEntityId || ownedIds.has(String(r.platformEntityId)))
  const cortanaLeads = unique(rows, EV.lead)
  const metaLeads = sum('metaLeads')

  // Daily spend: the series of the business that surfaced the clinic's campaigns, pro-rated.
  const source = [...owned].sort((a, b) => b.spend - a.spend)[0]?.business ?? id
  const sourceSpend = win[source].rows.reduce((s, r) => s + num(r.spent), 0)
  const spendShare = sourceSpend > 0 ? Math.min(1, sum('spend') / sourceSpend) : 0
  const spendByDate: Record<string, number> = Object.fromEntries(hist[source].daily.map((d) => [d.date, num(d.spend) * spendShare]))
  const allDays: DayPoint[] = hist[id].daily.map((d) => ({ date: d.date, spend: 0, leads: dayCount(d, EV.lead), revenue: d.revenue || 0 }))
  const byDate = Object.fromEntries(allDays.map((d) => [d.date, d]))
  for (const [date, spend] of Object.entries(spendByDate)) {
    if (byDate[date]) byDate[date].spend = spend
    else allDays.push((byDate[date] = { date, spend, leads: 0, revenue: 0 }))
  }
  allDays.sort((a, b) => a.date.localeCompare(b.date))
  // One point per window day, zero-filled.
  const daily: DayPoint[] = []
  for (let t = window.start.getTime(); isoDay(t) <= isoDay(window.end.getTime()); t += DAY) {
    const date = isoDay(t)
    daily.push(byDate[date] || { date, spend: 0, leads: 0, revenue: 0 })
  }
  const last = (pred: (d: DayPoint) => boolean) => [...allDays].reverse().find(pred)?.date ?? null
  const seen = hist[id].totals.uniqueByEventType || {}
  const seenEv = (ev: string) => (seen[ev] || 0) > 0 || unique(own, ev) > 0

  return {
    bound: true,
    spend: sum('spend'),
    impressions: sum('impressions'),
    linkClicks: sum('linkClicks'),
    leads: cortanaLeads || metaLeads,
    leadsFrom: cortanaLeads === 0 && metaLeads > 0 ? 'meta' : 'cortana',
    booked: unique(rows, EV.booked),
    confirmed: unique(rows, EV.confirmed),
    shown: unique(rows, EV.shown),
    purchases: unique(rows, EV.purchase),
    revenue: revenueOf(rows),
    tracked: {
      lead: seenEv(EV.lead),
      booked: seenEv(EV.booked),
      confirmed: seenEv(EV.confirmed),
      shown: seenEv(EV.shown),
      purchase: seenEv(EV.purchase),
    },
    daily,
    lastLeadDate: last((d) => d.leads > 0),
    lastSpendDate: last((d) => d.spend > 0),
    excludedCampaigns: own.filter((r) => r.platformEntityId && !ownedIds.has(String(r.platformEntityId)) && num(r.spent) > 0).length,
  }
}

export const cortanaSource: ClinicSource = {
  name: 'cortana',
  async fetchAll(clinics: ClinicConfig[], window: Window): Promise<ClinicRaw[]> {
    const range = { startDate: window.start.toISOString(), endDate: window.end.toISOString() }
    const lookback = { startDate: new Date(window.end.getTime() - LOOKBACK_DAYS * DAY).toISOString(), endDate: window.end.toISOString() }
    const failed: Record<string, string> = {}
    const none: Attribution = { rows: [], daily: [], totals: {} }
    const load = async (params: Record<string, string>) =>
      Object.fromEntries(
        await Promise.all(
          clinics.map(async (c) => {
            try {
              return [c.businessId, await attribution(c.businessId, params)] as const
            } catch (e) {
              failed[c.businessId] = (e as Error).message
              return [c.businessId, none] as const
            }
          })
        )
      ) as Record<string, Attribution>
    const [win, hist] = await Promise.all([
      load({ ...range, groupBy: 'campaign' }),
      load({ ...lookback, groupBy: 'source', eventTypes: Object.values(EV).join(SEP) }),
    ])
    const pool = poolCampaigns(Object.fromEntries(Object.entries(win).map(([id, a]) => [id, a.rows])))
    return clinics.map((c) => (failed[c.businessId] ? { ...unboundRaw(), bound: !!BINDINGS[c.businessId], error: failed[c.businessId] } : buildRaw(c, window, win, hist, pool)))
  },
}
