import { AMBER_BAND, CORE_GREEN_MIN, CORE_KPIS, STALE_HOURS, TARGETS, Target, type ClinicConfig } from '@/lib/clinics/config'
import type { ClinicRaw, ClinicReport, ClinicsSummary, FunnelStep, Kpi, KpiKey, SlackBookings, Status, Window, WindowKey } from '@/lib/clinics/types'

const DAY = 86400000
const HOUR = 3600000
const AVG_MONTH_DAYS = 365 / 12

// Windows end on a 15-minute boundary so upstream calls cache cleanly (data is ≤15 min old).
export function makeWindow(key: WindowKey, at = new Date()): Window {
  const now = new Date(Math.floor(at.getTime() / (15 * 60000)) * 15 * 60000)
  const end = now
  const start =
    key === 'mtd' ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) : new Date(now.getTime() - (key === '30d' ? 30 : 7) * DAY)
  return { key, start, end, days: Math.max(1, (end.getTime() - start.getTime()) / DAY) }
}

/* -------------------------------- formatting ------------------------------- */
const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`
const money2 = (n: number) => (n < 100 ? `$${n.toFixed(2)}` : money(n))
const pct = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)}%`
const mult = (n: number) => `${n.toFixed(1)}x`
const hours = (n: number) => (n < 1 ? '<1h' : n >= 72 ? `${Math.round(n / 24)}d` : `${Math.round(n)}h`)

// Green at/above target, amber within AMBER_BAND, red beyond it.
export function statusFor(value: number, t: Target, target = t.target): Status {
  if (t.dir === 'higher') return value >= target ? 'green' : value >= target * (1 - AMBER_BAND) ? 'amber' : 'red'
  return value <= target ? 'green' : value <= target * (1 + AMBER_BAND) ? 'amber' : 'red'
}
// How far off target (0 = on target, 1 = fully off) — used to pick the biggest problem.
const miss = (k: Kpi): number => {
  if (k.status === 'grey' || k.status === 'green') return 0
  const t = TARGETS[k.key] as Target
  if (k.value === null) return 1
  return t.dir === 'higher' ? Math.min(1, (t.target - k.value) / t.target) : Math.min(1, (k.value - t.target) / t.target)
}

const LABELS: Record<KpiKey, string> = {
  ctr: 'CTR',
  clickToLead: 'Click → lead',
  cpl: 'CPL',
  bookingRate: 'Booking rate',
  confirmationRate: 'Confirmation',
  closeRate: 'Close rate',
  spendPerDay: 'Spend / day',
  confirmedPerWeek: 'Confirmed / wk',
  costPerConfirmed: 'Cost / confirmed',
  pickupRate: 'Pickup rate',
  leadToSale: 'Lead → sale',
  roas: 'ROAS',
  revenue: 'Revenue',
  hoursSinceLead: 'Last lead',
  hoursSinceSpend: 'Last spend',
}
const TARGET_LABELS: Record<KpiKey, string> = {
  ctr: '≥2%',
  clickToLead: '≥8%',
  cpl: '≤$25',
  bookingRate: '≥35%',
  confirmationRate: '≥70%',
  closeRate: '≥25%',
  spendPerDay: '$100',
  confirmedPerWeek: '≥3',
  costPerConfirmed: '≤$102',
  pickupRate: '≥60%',
  leadToSale: '≥10%',
  roas: '≥3x',
  revenue: '$30k/mo',
  hoursSinceLead: '≤48h',
  hoursSinceSpend: '≤48h',
}

const kpi = (key: KpiKey, value: number | null, display: string, status: Status, note?: string): Kpi => ({
  key,
  label: LABELS[key],
  value,
  display,
  targetLabel: TARGET_LABELS[key],
  status,
  note,
})
const grey = (key: KpiKey, note: string) => kpi(key, null, '—', 'grey', note)
const rated = (key: KpiKey, value: number, display: string, note?: string, target?: number) =>
  kpi(key, value, display, statusFor(value, TARGETS[key] as Target, target), note)

// Hours since the end of a YYYY-MM-DD day (0 if it's today).
const hoursSince = (date: string | null, now: number) => (date ? Math.max(0, now - (Date.parse(`${date}T00:00:00Z`) + DAY)) / HOUR : null)

/* --------------------------------- report ---------------------------------- */
export function buildReport(clinic: ClinicConfig, raw: ClinicRaw, slack: SlackBookings | null, window: Window): ClinicReport {
  const now = window.end.getTime()
  const days = window.days
  const notes: string[] = []
  const k = {} as Record<KpiKey, Kpi>
  const err = raw.error ? `Cortana: ${raw.error}` : null

  // Bookings can't be fewer than confirmed — if they are, unconfirmed bookings aren't being logged.
  const bookings = Math.max(raw.booked, raw.confirmed)
  if (raw.confirmed > raw.booked && raw.booked >= 0 && !err) notes.push('Unconfirmed bookings under-logged — using confirmed as the booking count')
  // Confirmed can't be fewer than shows either.
  const confirmedFloor = Math.max(raw.confirmed, raw.shown)
  const leadNote = raw.leadsFrom === 'meta' ? 'Meta platform leads (Cortana has none)' : undefined
  if (leadNote && !err) notes.push(`Leads from Meta platform count — Cortana logged no lead events`)
  if (raw.excludedCampaigns > 0 && !err)
    notes.push(`${raw.excludedCampaigns} non-Genexa campaign row${raw.excludedCampaigns > 1 ? 's' : ''} excluded by campaign filter (daily spend trend pro-rated)`)

  const hLead = err ? null : hoursSince(raw.lastLeadDate, now)
  const hSpend = err ? null : hoursSince(raw.lastSpendDate, now)
  const staleLead = !err && (hLead === null || hLead > STALE_HOURS)
  const staleSpend = !err && (hSpend === null || hSpend > STALE_HOURS)

  if (err) {
    for (const key of Object.keys(LABELS) as KpiKey[]) if (key !== 'pickupRate') k[key] = grey(key, err)
  } else {
    // 1. CTR / click → lead
    k.ctr = raw.impressions > 0 ? rated('ctr', (raw.linkClicks / raw.impressions) * 100, pct((raw.linkClicks / raw.impressions) * 100)) : grey('ctr', 'No ad impressions in window')
    k.clickToLead =
      raw.linkClicks > 0 ? rated('clickToLead', (raw.leads / raw.linkClicks) * 100, pct((raw.leads / raw.linkClicks) * 100), leadNote) : grey('clickToLead', 'No link clicks in window')

    // 2. CPL
    if (!raw.tracked.lead && raw.leadsFrom === 'cortana') k.cpl = grey('cpl', 'Lead event not tracked in Cortana')
    else if (raw.leads > 0 && raw.spend === 0) k.cpl = grey('cpl', `No paid spend — ${raw.leads} organic / carry-over lead${raw.leads > 1 ? 's' : ''}`)
    else if (raw.leads > 0) k.cpl = rated('cpl', raw.spend / raw.leads, money2(raw.spend / raw.leads), leadNote)
    else if (raw.spend > 0) k.cpl = kpi('cpl', null, 'No leads', 'red', `${money(raw.spend)} spent, 0 leads`)
    else k.cpl = kpi('cpl', null, 'No leads', 'red', 'No spend and no leads in window')
    if (staleLead && k.cpl.status !== 'red') k.cpl = { ...k.cpl, status: 'red', note: `No leads for ${hLead === null ? '60d+' : hours(hLead)}` }

    // 3. Booking rate
    if (!raw.tracked.booked && !raw.tracked.confirmed) k.bookingRate = grey('bookingRate', 'Booking events not tracked in Cortana')
    else if (raw.leads === 0) k.bookingRate = grey('bookingRate', 'No leads in window')
    else k.bookingRate = rated('bookingRate', (bookings / raw.leads) * 100, pct((bookings / raw.leads) * 100), bookings > raw.leads ? 'Includes bookings from leads before this window' : undefined)

    // 4. Confirmation rate — Cortana, falling back to Slack booking posts when confirmations aren't logged.
    const slackRate = slack?.connected && slack.allBookings > 0 ? (slack.confirmedPatients / slack.allBookings) * 100 : null
    if (raw.confirmed === 0 && raw.shown > 0) {
      notes.push('Confirmations not being logged in Cortana (shows exist, 0 confirmed)')
      k.confirmationRate =
        slackRate !== null
          ? rated('confirmationRate', slackRate, pct(slackRate), `From Slack booking posts (${slack!.confirmedPatients}/${slack!.allBookings}) — confirmations not being logged in Cortana`)
          : grey('confirmationRate', `Confirmations not being logged; Slack ${slack?.connected ? 'has no booking posts' : `not connected${slack?.error ? ` — ${slack.error}` : ''}`}`)
    } else if (!raw.tracked.confirmed && bookings === 0) k.confirmationRate = grey('confirmationRate', 'Confirmed event not tracked in Cortana')
    else if (bookings === 0) k.confirmationRate = grey('confirmationRate', 'No bookings in window')
    else {
      const v = (raw.confirmed / bookings) * 100
      k.confirmationRate = rated('confirmationRate', v, pct(v), slackRate !== null ? `Slack cross-check: ${slack!.confirmedPatients}/${slack!.allBookings} confirmed (${pct(slackRate)})` : undefined)
    }

    // 5. Close rate — purchases / shows, or / confirmed when shows are under-logged.
    if (!raw.tracked.purchase) k.closeRate = grey('closeRate', 'Purchase event not tracked in Cortana')
    else if (raw.shown > 0 && raw.shown >= raw.purchases) k.closeRate = rated('closeRate', (raw.purchases / raw.shown) * 100, pct((raw.purchases / raw.shown) * 100))
    else if (confirmedFloor > 0) {
      const v = (raw.purchases / confirmedFloor) * 100
      k.closeRate = rated('closeRate', v, `${pct(v)} vs conf.`, 'vs confirmed — shows under-logged')
    } else k.closeRate = grey('closeRate', raw.purchases > 0 ? 'Sales logged with no shows or confirmed appointments' : 'No shows or confirmed appointments in window')

    // 6. Spend / day — also red when nothing spent in the last 24h.
    const perDay = raw.spend / days
    k.spendPerDay = rated('spendPerDay', perDay, money(perDay))
    if (hSpend === null || hSpend > 24) k.spendPerDay = { ...k.spendPerDay, status: 'red', note: `No spend in last ${hSpend === null ? '60d' : hours(hSpend)}` }

    // Extra KPIs
    const perWeek = confirmedFloor / (days / 7)
    k.confirmedPerWeek =
      !raw.tracked.confirmed && !raw.tracked.shown
        ? grey('confirmedPerWeek', 'Confirmed event not tracked in Cortana')
        : rated('confirmedPerWeek', perWeek, perWeek.toFixed(1), raw.confirmed < raw.shown ? 'Floor from shows (confirmations under-logged)' : undefined)
    k.costPerConfirmed =
      raw.spend === 0
        ? grey('costPerConfirmed', 'No paid spend in window')
        : confirmedFloor > 0
        ? rated('costPerConfirmed', raw.spend / confirmedFloor, money(raw.spend / confirmedFloor))
        : raw.spend > 0
          ? kpi('costPerConfirmed', null, 'None', 'red', `${money(raw.spend)} spent, 0 confirmed`)
          : grey('costPerConfirmed', 'No confirmed appointments tracked')
    k.leadToSale = !raw.tracked.purchase
      ? grey('leadToSale', 'Purchase event not tracked in Cortana')
      : raw.leads === 0
        ? grey('leadToSale', 'No leads in window')
        : rated('leadToSale', (raw.purchases / raw.leads) * 100, pct((raw.purchases / raw.leads) * 100))
    k.roas = !raw.tracked.purchase
      ? grey('roas', 'Purchase event not tracked in Cortana')
      : raw.spend === 0
        ? grey('roas', 'No spend in window')
        : rated('roas', raw.revenue / raw.spend, mult(raw.revenue / raw.spend), raw.revenue / raw.spend >= (TARGETS.roas.good ?? Infinity) ? 'Strong (≥4x)' : undefined)
    const goal = (TARGETS.revenue.target * days) / AVG_MONTH_DAYS
    k.revenue = !raw.tracked.purchase
      ? grey('revenue', 'Purchase event not tracked in Cortana')
      : rated('revenue', raw.revenue, money(raw.revenue), `Goal ${money(goal)} for this window`, goal)
    k.hoursSinceLead = hLead === null ? kpi('hoursSinceLead', null, '60d+', 'red', 'No leads in 60 days') : rated('hoursSinceLead', hLead, hLead === 0 ? 'Today' : hours(hLead))
    if (hLead !== null && hLead > STALE_HOURS) k.hoursSinceLead.status = 'red'
    k.hoursSinceSpend = hSpend === null ? kpi('hoursSinceSpend', null, '60d+', 'red', 'No spend in 60 days') : rated('hoursSinceSpend', hSpend, hSpend === 0 ? 'Today' : hours(hSpend))
    if (hSpend !== null && hSpend > STALE_HOURS) k.hoursSinceSpend.status = 'red'
    if (staleSpend) notes.push(`No ad spend for ${hSpend === null ? '60d+' : hours(hSpend)}`)

    // Batch-logged revenue (e.g. Russell logs sales at month end).
    const topDay = raw.daily.reduce((m, d) => (d.revenue > m.revenue ? d : m), { date: '', revenue: 0 } as { date: string; revenue: number })
    if (raw.revenue > 0 && raw.purchases >= 2 && topDay.revenue > raw.revenue * 0.5)
      notes.push(`${Math.round((topDay.revenue / raw.revenue) * 100)}% of revenue logged on ${topDay.date} — sales may be batch-logged`)
  }

  // 8. Pickup rate — not posted in any Slack channel; needs a dialer (Hot Prospector) source.
  k.pickupRate = grey('pickupRate', "Pickups aren't posted in Slack; Hot Prospector not connected")

  const coreGreen = CORE_KPIS.filter((c) => k[c].status === 'green').length
  const atKpi = k.confirmedPerWeek.status === 'green' && coreGreen >= CORE_GREEN_MIN
  const all = Object.values(k)
  const count = (s: Status) => all.filter((x) => x.status === s).length
  const coreRed = CORE_KPIS.filter((c) => k[c].status === 'red').length

  const step = (label: string, value: number | null, prev: number | null): FunnelStep => ({
    label,
    value,
    pct: value !== null && prev ? (value / prev) * 100 : null,
  })
  const leadsV = err ? null : raw.leads
  const bookedV = err || (!raw.tracked.booked && !raw.tracked.confirmed) ? null : bookings
  const confV = err || (!raw.tracked.confirmed && !raw.tracked.shown) ? null : confirmedFloor
  const shownV = err || !raw.tracked.shown ? null : raw.shown
  const soldV = err || !raw.tracked.purchase ? null : raw.purchases
  const funnel = [
    step('Leads', leadsV, null),
    step('Booked', bookedV, leadsV),
    step('Confirmed', confV, bookedV),
    step('Showed', shownV, confV),
    step('Sold', soldV, shownV ?? confV),
  ]

  return {
    name: clinic.name,
    pod: clinic.pod,
    businessId: clinic.businessId,
    kpis: k,
    atKpi,
    coreGreen,
    worst: (atKpi ? 0 : 1000) + coreRed * 100 + count('red') * 10 + count('amber') - (err ? 500 : 0),
    funnel,
    daily: raw.daily,
    problem: biggestProblem(k, err),
    notes,
    slack,
    raw,
  }
}

// Plain-English line naming the worst miss, in funnel order on ties.
const DIAGNOSIS: Partial<Record<KpiKey, string>> = {
  spendPerDay: 'ads paused or under-delivering — check the ad account / billing',
  ctr: 'creative issue',
  clickToLead: 'landing page / form issue',
  cpl: 'ad performance issue',
  bookingRate: 'call centre issue',
  confirmationRate: 'CSR confirmation calls issue',
  closeRate: 'clinic sales issue',
  confirmedPerWeek: 'not enough confirmed appointments',
}
function biggestProblem(k: Record<KpiKey, Kpi>, err: string | null): string {
  if (err) return `No data — ${err}`
  const order = Object.keys(DIAGNOSIS) as KpiKey[]
  const bad = order.map((key) => k[key]).filter((x) => x.status === 'red' || x.status === 'amber')
  if (!bad.length) {
    const greys = order.filter((key) => k[key].status === 'grey')
    return greys.length ? `On target where tracked — no data for ${greys.map((g) => LABELS[g].toLowerCase()).join(', ')}` : 'On track — every core KPI at target'
  }
  const reds = bad.filter((x) => x.status === 'red')
  const pool = reds.length ? reds : bad
  const top = pool.reduce((a, b) => (miss(b) > miss(a) ? b : a))
  const vs = top.value === null ? (top.note ?? top.display) : `${top.display} vs ${top.targetLabel.replace(/[≥≤]/g, '')} target`
  return `${top.label} ${vs} — ${DIAGNOSIS[top.key]}`
}

export function summarise(reports: ClinicReport[]): ClinicsSummary {
  const ok = reports.filter((r) => !r.raw.error)
  const spend = ok.reduce((s, r) => s + r.raw.spend, 0)
  const leads = ok.reduce((s, r) => s + r.raw.leads, 0)
  // ROAS only over clinics that track purchases (untracked revenue isn't zero revenue).
  const tracking = ok.filter((r) => r.raw.tracked.purchase)
  const revenue = tracking.reduce((s, r) => s + r.raw.revenue, 0)
  const trackedSpend = tracking.reduce((s, r) => s + r.raw.spend, 0)
  return {
    atKpi: reports.filter((r) => r.atKpi).length,
    total: reports.length,
    spend,
    leads,
    confirmed: ok.reduce((s, r) => s + Math.max(r.raw.confirmed, r.raw.shown), 0),
    cpl: leads > 0 ? spend / leads : null,
    roas: trackedSpend > 0 ? revenue / trackedSpend : null,
  }
}
