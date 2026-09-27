import { CLINICS, type ClinicConfig } from '@/lib/clinics/config'
import type { ClinicRaw, ClinicSource, DayPoint, SlackBookings, Window } from '@/lib/clinics/types'

// Mock data for /api/clinics/kpis?mock=1 — one scenario per clinic so every status rule is exercised.
// Deterministic (seeded by clinic index) so the page looks the same on every load.

const DAY = 86400000
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)

type Scenario = {
  perDaySpend: number
  ctr: number // %
  clickToLead: number // %
  booking: number // share of leads
  confirm: number // share of bookings
  show: number // share of confirmed
  close: number // share of shows
  aov: number
  opts?: Partial<{ error: string; noConfirmLogging: boolean; batchRevenue: boolean; adsOffDays: number; metaLeadsOnly: boolean; noPurchaseTracking: boolean }>
}

const SCENARIOS: Scenario[] = [
  { perDaySpend: 110, ctr: 2.6, clickToLead: 10, booking: 0.42, confirm: 0.78, show: 0.8, close: 0.35, aov: 4500 }, // healthy
  { perDaySpend: 95, ctr: 2.2, clickToLead: 9, booking: 0.4, confirm: 0.75, show: 0.7, close: 0.3, aov: 6000, opts: { batchRevenue: true } }, // Russell — month-end batch
  { perDaySpend: 105, ctr: 2.1, clickToLead: 8.5, booking: 0.18, confirm: 0.7, show: 0.7, close: 0.25, aov: 4000 }, // call centre issue
  { perDaySpend: 100, ctr: 1.9, clickToLead: 8, booking: 0.36, confirm: 0.7, show: 0.6, close: 0.2, aov: 3000, opts: { adsOffDays: 4 } }, // ads switched off
  { perDaySpend: 100, ctr: 1.2, clickToLead: 5, booking: 0.3, confirm: 0.6, show: 0.6, close: 0.2, aov: 3500 }, // creative + form issue
  { perDaySpend: 0, ctr: 0, clickToLead: 0, booking: 0, confirm: 0, show: 0, close: 0, aov: 0, opts: { error: 'mock: source not connected' } },
  { perDaySpend: 120, ctr: 2.4, clickToLead: 9, booking: 0.38, confirm: 0.72, show: 0.75, close: 0.3, aov: 5000, opts: { metaLeadsOnly: true } },
  { perDaySpend: 100, ctr: 3, clickToLead: 12, booking: 0.45, confirm: 0, show: 0.7, close: 0.3, aov: 4000, opts: { noConfirmLogging: true } },
  { perDaySpend: 60, ctr: 2.2, clickToLead: 8, booking: 0.35, confirm: 0.7, show: 0.7, close: 0.3, aov: 3000, opts: { noPurchaseTracking: true } }, // under-spending, no purchase event
  { perDaySpend: 100, ctr: 2.3, clickToLead: 9, booking: 0.36, confirm: 0.58, show: 0.7, close: 0.25, aov: 4000 }, // confirmation just off
]

// Small deterministic wobble so sparklines aren't flat.
const wobble = (i: number, d: number) => 0.75 + 0.5 * ((Math.sin(i * 12.9898 + d * 78.233) * 43758.5453) % 1 + 1) % 1

export const mockSource: ClinicSource = {
  name: 'mock',
  async fetchClinic(clinic: ClinicConfig, window: Window): Promise<ClinicRaw> {
    const i = Math.max(0, CLINICS.findIndex((c) => c.businessId === clinic.businessId))
    const s = SCENARIOS[i % SCENARIOS.length]
    const o = s.opts || {}
    const empty = { lead: false, booked: false, confirmed: false, shown: false, purchase: false }
    if (o.error)
      return { error: o.error, spend: 0, impressions: 0, linkClicks: 0, leads: 0, leadsFrom: 'cortana', booked: 0, confirmed: 0, shown: 0, purchases: 0, revenue: 0, tracked: empty, daily: [], lastLeadDate: null, lastSpendDate: null, excludedCampaigns: 0 }

    const daily: DayPoint[] = []
    const nDays = Math.ceil(window.days)
    for (let d = 0; d < nDays; d++) {
      const date = iso(window.start.getTime() + d * DAY)
      const off = o.adsOffDays && d >= nDays - o.adsOffDays
      const spend = off ? 0 : s.perDaySpend * wobble(i, d)
      const clicks = (spend / 1.4) * (s.ctr / 2.5)
      daily.push({ date, spend, leads: Math.round((clicks * s.clickToLead) / 100), revenue: 0 })
    }
    const spend = daily.reduce((a, d) => a + d.spend, 0)
    const leads = daily.reduce((a, d) => a + d.leads, 0)
    const impressions = Math.round((spend / 38) * 1000)
    const linkClicks = Math.round((impressions * s.ctr) / 100)
    const booked = Math.round(leads * s.booking)
    const confirmedTrue = Math.round(booked * (o.noConfirmLogging ? 0.7 : s.confirm))
    const shown = Math.round(confirmedTrue * s.show)
    const purchases = Math.round(shown * s.close)
    const revenue = purchases * s.aov
    // Revenue lands on sale days — or all on the last day for batch loggers.
    if (revenue) {
      if (o.batchRevenue) daily[daily.length - 1].revenue = revenue
      else for (let p = 0; p < purchases; p++) daily[Math.floor(((p + 0.5) / purchases) * daily.length)].revenue += s.aov
    }
    const lastWith = (f: (d: DayPoint) => boolean) => [...daily].reverse().find(f)?.date ?? null

    return {
      spend,
      impressions,
      linkClicks,
      leads,
      leadsFrom: o.metaLeadsOnly ? 'meta' : 'cortana',
      booked,
      confirmed: o.noConfirmLogging ? 0 : confirmedTrue,
      shown,
      purchases: o.noPurchaseTracking ? 0 : purchases,
      revenue: o.noPurchaseTracking ? 0 : revenue,
      tracked: { lead: !o.metaLeadsOnly, booked: true, confirmed: !o.noConfirmLogging, shown: true, purchase: !o.noPurchaseTracking },
      daily,
      lastLeadDate: lastWith((d) => d.leads > 0),
      lastSpendDate: lastWith((d) => d.spend > 0),
      excludedCampaigns: clinic.campaignFilter ? 7 : 0,
    }
  },
}

export function mockSlackBookings(): Record<string, SlackBookings> {
  const out: Record<string, SlackBookings> = {}
  CLINICS.forEach((c, i) => (out[c.name] = { connected: true, booked: 6 + i, confirmed: 4 + (i % 3), allBookings: 6 + i, confirmedPatients: 4 + (i % 3) }))
  return out
}
