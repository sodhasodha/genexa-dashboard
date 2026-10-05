import { unstable_cache } from 'next/cache'
import { cortanaGet } from '@/lib/clinics/client'
import { CACHE_SECONDS, type ClinicConfig } from '@/lib/clinics/config'
import type { ClinicRaw, ClinicSource, DayPoint, Window } from '@/lib/clinics/types'

// Cortana REST adapter (server-side only). Key: CORTANA_API_KEY.
//
// Per clinic:
//  1. attribution?groupBy=campaign for the window → spend, impressions, link clicks, Meta leads
//     and unique counts per conversion event (summed across rows).
//  2. attribution for a 60-day lookback → daily series (sparkline, last lead / last spend)
//     and which events the clinic tracks at all. Cortana only returns dailySummary when a filter is
//     set, so this call filters to the funnel events.
//  Each call is cached 15 min (windows end on a 15-min boundary, so keys are stable). Cortana
//  rate-limits at ~60 calls/min; failures aren't cached.
//  With a campaign filter, paid rows that don't match are dropped. The REST API ignores `campaigns`
//  and dailySummary spend is account-wide, so daily spend is pro-rated by the filtered share of
//  window spend (leads / revenue are CRM-level and stay unscoped).

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

const ROW_FIELDS = ['dimension', 'spent', 'impressions', 'inlineLinkClicks', 'metaPlatformLeads', 'totalRevenue', 'conversions'] as const

async function fetchAttribution(businessId: string, qs: string) {
  const json = await cortanaGet(`businesses/${businessId}/attribution?${qs}`)
  // Keep only what the KPIs use so cache entries stay small.
  return {
    rows: ((json?.data?.data || []) as any[]).map((r) => Object.fromEntries(ROW_FIELDS.map((f) => [f, r[f] ?? null]))),
    daily: (json?.data?.dailySummary || []) as any[],
    totals: (json?.data?.globalTotals || {}) as { uniqueByEventType?: Record<string, number> },
  }
}
const cachedAttribution = unstable_cache(fetchAttribution, ['cortana-attribution-v1'], { revalidate: CACHE_SECONDS, tags: ['clinic-kpis'] })
const attribution = (businessId: string, params: Record<string, string>) => cachedAttribution(businessId, new URLSearchParams(params).toString())

const unique = (rows: any[], ev: string) => rows.reduce((s, r) => s + (r.conversions?.[ev]?.uniqueCount ?? r.conversions?.[ev]?.count ?? 0), 0)
const revenueOf = (rows: any[]) =>
  rows.reduce((s, r) => s + (r.conversions?.[EV.purchase]?.revenue ?? 0), 0) || rows.reduce((s, r) => s + (r.totalRevenue || 0), 0)
const dayCount = (d: any, ev: string) => d.conversions?.[ev]?.count ?? 0
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export const cortanaSource: ClinicSource = {
  name: 'cortana',
  async fetchClinic(clinic: ClinicConfig, window: Window): Promise<ClinicRaw> {
    const range = { startDate: window.start.toISOString(), endDate: window.end.toISOString() }
    const lookback = { startDate: new Date(window.end.getTime() - LOOKBACK_DAYS * DAY).toISOString(), endDate: window.end.toISOString() }

    const [win, hist] = await Promise.all([
      attribution(clinic.businessId, { ...range, groupBy: 'campaign' }),
      attribution(clinic.businessId, { ...lookback, groupBy: 'source', eventTypes: Object.values(EV).join(SEP) }),
    ])

    const rows = win.rows
    const excluded = 0
    const spendShare = 1

    const sum = (k: string) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0)
    const cortanaLeads = unique(rows, EV.lead)
    const metaLeads = sum('metaPlatformLeads')

    // Daily series over the lookback; the window slice feeds the sparkline.
    const allDays: DayPoint[] = hist.daily.map((d) => ({
      date: d.date,
      spend: (d.spend || 0) * spendShare,
      leads: dayCount(d, EV.lead),
      revenue: d.revenue || 0,
    }))
    // One point per window day, zero-filled.
    const byDate = Object.fromEntries(allDays.map((d) => [d.date, d]))
    const daily: DayPoint[] = []
    for (let t = window.start.getTime(); isoDay(t) <= isoDay(window.end.getTime()); t += DAY) {
      const date = isoDay(t)
      daily.push(byDate[date] || { date, spend: 0, leads: 0, revenue: 0 })
    }
    const last = (pred: (d: DayPoint) => boolean) => [...allDays].reverse().find(pred)?.date ?? null
    const seen = hist.totals.uniqueByEventType || {}
    const seenEv = (ev: string) => (seen[ev] || 0) > 0 || unique(win.rows, ev) > 0

    return {
      spend: sum('spent'),
      impressions: sum('impressions'),
      linkClicks: sum('inlineLinkClicks'),
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
      excludedCampaigns: excluded,
    }
  },
}
