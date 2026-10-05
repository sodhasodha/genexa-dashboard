import { unstable_cache } from 'next/cache'
import { BINDINGS } from '@/lib/clinics/bindings'
import { cortanaGet } from '@/lib/clinics/client'
import { CACHE_SECONDS, isTestContact, type ClinicConfig } from '@/lib/clinics/config'
import type { ClinicRaw, ClinicSource, DayPoint, Window } from '@/lib/clinics/types'

// Cortana REST adapter (server-side only).
//
// Per roster business:
//  1. attribution?groupBy=campaign for the window → one row per campaign with its Meta ad account id
//     (customerId), campaign id (platformEntityId), spend, impressions, link clicks, Meta leads and
//     unique counts per conversion event.
//  2. conversions/entries for a ~9-week lookback → every CRM event with its contact and attributed
//     campaign id. The funnel (leads, booked, confirmed, shown, sold, revenue) is counted from these
//     as unique contacts, so test contacts and events on non-bound campaigns can be dropped.
//  3. attribution for a 60-day lookback → daily spend series (sparkline, last spend). Cortana only
//     returns dailySummary when a filter is set, so this call filters to the funnel events.
//  Campaign rows from every business are pooled by campaign id, then handed to clinics by the explicit
//  binding in bindings.ts — a business's own row set is never trusted to be "its" campaigns.
//  Each call is cached 15 min (windows end on a 15-min boundary, so keys are stable); failures
//  aren't cached. The REST API ignores campaign filters and dailySummary spend is business-wide,
//  so daily spend is pro-rated by the clinic's share of that business's window spend.

const DAY = 86400000
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const num = (v: unknown) => Number(v) || 0
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

// One CRM conversion event. Contact details are reduced to an id + test flag before caching.
export type Entry = { ev: string; value: number; at: number; campaignId: string | null; campaign: string | null; contact: string; test: boolean }
const ENTRY_LOOKBACK_DAYS = 63 // covers the window and its prior period (30d + 30d, or MTD + last month)
const ENTRY_PAGE = 100 // Cortana's max
const ENTRY_MAX_PAGES = 40

async function fetchEntries(businessId: string, from: string): Promise<Entry[]> {
  const out: Entry[] = []
  for (let page = 1; page <= ENTRY_MAX_PAGES; page++) {
    const qs = new URLSearchParams({ from, limit: String(ENTRY_PAGE), page: String(page), sort: '-occurredAt' })
    const json = await cortanaGet(`businesses/${businessId}/conversions/entries?${qs}`)
    for (const e of (json?.data || []) as any[])
      out.push({
        ev: e.configName,
        value: num(e.eventValue),
        at: Date.parse(e.occurredAt),
        campaignId: e.attributionCampaignId ? String(e.attributionCampaignId) : null,
        campaign: e.attributionCampaign || null,
        contact: String(e.contactId ?? e.contact?.id ?? e.id),
        test: isTestContact(e.contact || {}),
      })
    if (!json?.pagination?.hasMore) break
  }
  return out
}
const cachedEntries = unstable_cache(fetchEntries, ['cortana-entries-v1'], { revalidate: CACHE_SECONDS, tags: ['clinic-kpis'] })

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
  excludedEvents: 0,
  testContacts: [],
  lastEventAt: null,
  excludedCampaigns: 0,
})

function buildRaw(
  clinic: ClinicConfig,
  window: Window,
  win: Record<string, Attribution>,
  hist: Record<string, Attribution>,
  entries: Record<string, Entry[]>,
  pool: Map<string, Campaign>,
  spendShare: { source: string; share: number }
): ClinicRaw {
  const id = clinic.businessId
  const binding = BINDINGS[id]
  if (!binding) return unboundRaw()
  const owned = ownedCampaigns(id, pool)
  const ownedIds = new Set([...owned.map((c) => c.id), ...binding.campaignIds])
  const sum = (k: 'spend' | 'impressions' | 'linkClicks' | 'metaLeads') => owned.reduce((s, c) => s + c[k], 0)

  // CRM events come from the clinic's own business: events on its bound campaigns plus organic /
  // unattributed ones (the CRM sub-account is ours). Events on other campaigns and test contacts are dropped.
  const all = entries[id]
  const ours = (e: Entry) => !e.campaignId || ownedIds.has(e.campaignId) || (!!e.campaign && !!binding.campaignPrefix?.test(e.campaign))
  const inWindow = (e: Entry) => e.at >= window.start.getTime() && e.at < window.end.getTime()
  const real = all.filter((e) => !e.test && ours(e))
  const cur = real.filter(inWindow)
  const contacts = (...evs: string[]) => new Set(cur.filter((e) => evs.includes(e.ev)).map((e) => e.contact)).size
  const cortanaLeads = contacts(EV.lead)
  const metaLeads = sum('metaLeads')

  // Daily leads / revenue from CRM events; daily spend from the business that surfaced the clinic's
  // campaigns, pro-rated by the clinic's share of that business's spend.
  const byDate: Record<string, DayPoint> = {}
  const day = (date: string) => (byDate[date] ??= { date, spend: 0, leads: 0, revenue: 0 })
  const leadDays = new Set<string>()
  for (const e of real) {
    const key = `${isoDay(e.at)}|${e.contact}`
    if (e.ev === EV.lead && !leadDays.has(key)) {
      leadDays.add(key)
      day(isoDay(e.at)).leads++
    }
    if (e.ev === EV.purchase) day(isoDay(e.at)).revenue += e.value
  }
  for (const d of hist[spendShare.source].daily) day(d.date).spend = num(d.spend) * spendShare.share
  const allDays = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date))
  // One point per window day, zero-filled.
  const daily: DayPoint[] = []
  for (let t = window.start.getTime(); isoDay(t) <= isoDay(window.end.getTime()); t += DAY) {
    const date = isoDay(t)
    daily.push(byDate[date] || { date, spend: 0, leads: 0, revenue: 0 })
  }
  const last = (pred: (d: DayPoint) => boolean) => [...allDays].reverse().find(pred)?.date ?? null
  const seenEv = (ev: string) => real.some((e) => e.ev === ev)

  return {
    bound: true,
    spend: sum('spend'),
    impressions: sum('impressions'),
    linkClicks: sum('linkClicks'),
    leads: cortanaLeads || metaLeads,
    leadsFrom: cortanaLeads === 0 && metaLeads > 0 ? 'meta' : 'cortana',
    // A confirmed appointment is a booking even when the unconfirmed event was never logged.
    booked: contacts(EV.booked, EV.confirmed),
    confirmed: contacts(EV.confirmed),
    shown: contacts(EV.shown),
    purchases: contacts(EV.purchase),
    revenue: cur.filter((e) => e.ev === EV.purchase).reduce((s, e) => s + e.value, 0),
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
    excludedEvents: all.filter((e) => !e.test && !ours(e) && inWindow(e)).length,
    testContacts: [...new Set(all.filter((e) => e.test && inWindow(e)).map((e) => e.contact))],
    lastEventAt: all.length ? new Date(Math.max(...all.map((e) => e.at))).toISOString() : null,
    excludedCampaigns: win[id].rows.filter((r) => r.platformEntityId && !ownedIds.has(String(r.platformEntityId)) && num(r.spent) > 0).length,
  }
}

export const cortanaSource: ClinicSource = {
  name: 'cortana',
  async fetchAll(clinics: ClinicConfig[], window: Window, prev: Window) {
    const range = (w: Window) => ({ startDate: w.start.toISOString(), endDate: w.end.toISOString(), groupBy: 'campaign' })
    const lookback = { startDate: new Date(window.end.getTime() - LOOKBACK_DAYS * DAY).toISOString(), endDate: window.end.toISOString() }
    const failed: Record<string, string> = {}
    const none: Attribution = { rows: [], daily: [], totals: {} }
    const load = async <T,>(get: (businessId: string) => Promise<T>, fallback: T) =>
      Object.fromEntries(
        await Promise.all(
          clinics.map(async (c) => {
            try {
              return [c.businessId, await get(c.businessId)] as const
            } catch (e) {
              failed[c.businessId] = (e as Error).message
              return [c.businessId, fallback] as const
            }
          })
        )
      ) as Record<string, T>
    // Entries start on a day boundary so the cache key is stable through the day.
    const entriesFrom = new Date(Math.floor(window.end.getTime() / DAY) * DAY - ENTRY_LOOKBACK_DAYS * DAY).toISOString()
    const [win, prevWin, hist, entries] = await Promise.all([
      load((id) => attribution(id, range(window)), none),
      load((id) => attribution(id, range(prev)), none),
      load((id) => attribution(id, { ...lookback, groupBy: 'source', eventTypes: Object.values(EV).join(SEP) }), none),
      load((id) => cachedEntries(id, entriesFrom), [] as Entry[]),
    ])
    const rowsOf = (w: Record<string, Attribution>) => Object.fromEntries(Object.entries(w).map(([id, a]) => [id, a.rows]))
    const pool = poolCampaigns(rowsOf(win))
    const prevPool = poolCampaigns(rowsOf(prevWin))
    // Share of the surfacing business's spend that is this clinic's, over both periods.
    const shareOf = (id: string) => {
      const owned = [...ownedCampaigns(id, pool), ...ownedCampaigns(id, prevPool)]
      const source = [...owned].sort((a, b) => b.spend - a.spend)[0]?.business ?? id
      const total = [...win[source].rows, ...prevWin[source].rows].reduce((s, r) => s + num(r.spent), 0)
      return { source, share: total > 0 ? Math.min(1, owned.reduce((s, c) => s + c.spend, 0) / total) : 0 }
    }
    const build = (w: Window, rows: Record<string, Attribution>, p: Map<string, Campaign>) =>
      clinics.map((c) => (failed[c.businessId] ? { ...unboundRaw(), bound: !!BINDINGS[c.businessId], error: failed[c.businessId] } : buildRaw(c, w, rows, hist, entries, p, shareOf(c.businessId))))
    return { cur: build(window, win, pool), prev: build(prev, prevWin, prevPool) }
  },
}
