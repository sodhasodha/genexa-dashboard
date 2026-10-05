import { AMBER_BAND, CORE_GREEN_MIN, CORE_KPIS, STALE_HOURS, TARGETS, Target, type ClinicConfig } from '@/lib/clinics/config'
import type { ClinicRaw, ClinicReport, ClinicsSummary, FunnelStep, Kpi, KpiKey, Prior, SlackBookings, Status, Window, WindowKey } from '@/lib/clinics/types'

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

// The prior period trends compare against: the same length immediately before, or for MTD the
// same number of days from the 1st of last month.
export function prevWindow(w: Window): Window {
  const len = w.end.getTime() - w.start.getTime()
  if (w.key !== 'mtd') return { key: w.key, start: new Date(w.start.getTime() - len), end: w.start, days: w.days }
  const start = new Date(Date.UTC(w.start.getUTCFullYear(), w.start.getUTCMonth() - 1, 1))
  return { key: w.key, start, end: new Date(Math.min(start.getTime() + len, w.start.getTime())), days: w.days }
}
const dayLabel = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const NAMES: Record<WindowKey, string> = { mtd: 'MTD', '7d': 'Last 7 days', '30d': 'Last 30 days' }
// Dates are UTC; the last day runs up to the data's refresh time.
export function windowLabel(w: Window, named = true): string {
  const last = new Date(Math.max(w.start.getTime(), w.end.getTime() - 1))
  const range = dayLabel(w.start) === dayLabel(last) ? dayLabel(last) : `${dayLabel(w.start)} – ${dayLabel(last)}`
  return named ? `${NAMES[w.key]} · ${range}` : range
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
// Not tracked ≠ zero: the event has never been logged for this clinic.
const untracked = (key: KpiKey, note: string) => kpi(key, null, 'Not tracked', 'grey', note)
const rated = (key: KpiKey, value: number, display: string, note?: string, target?: number) =>
  kpi(key, value, display, statusFor(value, TARGETS[key] as Target, target), note)

// Hours since the end of a YYYY-MM-DD day (0 if it's today).
const hoursSince = (date: string | null, now: number) => (date ? Math.max(0, now - (Date.parse(`${date}T00:00:00Z`) + DAY)) / HOUR : null)

// Duplicate guard: two clinics returning identical spend AND impressions for the same window are
// reading the same source. Both are marked as a data error and left out of totals.
export const DUPLICATE_ERROR = 'Data error: duplicate source'
export function flagDuplicates(clinics: ClinicConfig[], raws: ClinicRaw[]): void {
  const groups = new Map<string, number[]>()
  raws.forEach((r, i) => {
    if (r.error || !r.bound || r.impressions <= 0) return
    const key = `${r.spend.toFixed(2)}|${r.impressions}`
    groups.set(key, [...(groups.get(key) || []), i])
  })
  for (const idx of groups.values())
    if (idx.length > 1)
      for (const i of idx) raws[i].dataError = `${DUPLICATE_ERROR} — same spend and impressions as ${idx.filter((j) => j !== i).map((j) => clinics[j].name).join(', ')}`
}

/* --------------------------------- report ---------------------------------- */
const confirmedOf = (r: ClinicRaw) => Math.max(r.confirmed, r.shown)
const usable = (r: ClinicRaw | null | undefined): r is ClinicRaw => !!r && r.bound && !r.error && !r.dataError
const prior = (rs: ClinicRaw[]): Prior => {
  const spend = rs.reduce((s, r) => s + r.spend, 0)
  const leads = rs.reduce((s, r) => s + r.leads, 0)
  const tracking = rs.filter((r) => r.tracked.purchase)
  return { spend, leads, confirmed: rs.reduce((s, r) => s + confirmedOf(r), 0), cpl: leads > 0 ? spend / leads : null, revenue: tracking.length ? tracking.reduce((s, r) => s + r.revenue, 0) : null }
}

export function buildReport(clinic: ClinicConfig, raw: ClinicRaw, slack: SlackBookings | null, window: Window, prevRaw?: ClinicRaw | null): ClinicReport {
  const now = window.end.getTime()
  const days = window.days
  const notes: string[] = []
  const k = {} as Record<KpiKey, Kpi>
  const err = raw.error ? `Cortana: ${raw.error}` : raw.dataError ? raw.dataError : !raw.bound ? 'Not bound — no ad account binding in lib/clinics/bindings.ts' : null

  // Confirmed can't be fewer than shows — if it is, confirmations aren't being logged.
  const confirmedFloor = confirmedOf(raw)
  const leadNote = raw.leadsFrom === 'meta' ? 'Meta platform leads (Cortana has none)' : undefined
  if (leadNote && !err) notes.push(`Leads from Meta platform count — Cortana logged no lead events`)
  if (raw.excludedCampaigns > 0 && !err)
    notes.push(`${raw.excludedCampaigns} non-Genexa campaign${raw.excludedCampaigns > 1 ? 's' : ''} in Cortana for this clinic left out (not in its binding)`)
  if (raw.excludedEvents > 0 && !err) notes.push(`${raw.excludedEvents} CRM event${raw.excludedEvents > 1 ? 's' : ''} on non-Genexa campaigns not counted`)
  if (raw.testContacts.length > 0 && !err) notes.push(`${raw.testContacts.length} test contact${raw.testContacts.length > 1 ? 's' : ''} excluded`)

  // A funnel rate = numerator ÷ its proper denominator. Missing denominator → "Not tracked";
  // over 100% is impossible within a cohort → data error, never a number.
  const rate = (key: KpiKey, n: number, den: number, denTracked: boolean, denName: string, note?: string): Kpi => {
    if (!denTracked) return untracked(key, `${denName} not tracked in Cortana`)
    if (den === 0) return grey(key, `No ${denName.toLowerCase()} in window`)
    const v = (n / den) * 100
    if (v > 100) return { ...kpi(key, null, 'Data error', 'grey', `${n} ÷ ${den} ${denName.toLowerCase()} = ${Math.round(v)}% — over 100%, events mis-logged or from an earlier cohort`), error: true }
    return rated(key, v, pct(v), note)
  }
  const leadsTracked = raw.tracked.lead || raw.leadsFrom === 'meta'

  const hLead = err ? null : hoursSince(raw.lastLeadDate, now)
  const hSpend = err ? null : hoursSince(raw.lastSpendDate, now)
  const staleLead = !err && (hLead === null || hLead > STALE_HOURS)
  const staleSpend = !err && (hSpend === null || hSpend > STALE_HOURS)

  if (err) {
    for (const key of Object.keys(LABELS) as KpiKey[]) if (key !== 'pickupRate') k[key] = kpi(key, null, raw.dataError ? 'Data error' : raw.bound ? '—' : 'Not bound', 'grey', err)
  } else {
    // 1. CTR / click → lead
    k.ctr = raw.impressions > 0 ? rated('ctr', (raw.linkClicks / raw.impressions) * 100, pct((raw.linkClicks / raw.impressions) * 100)) : grey('ctr', 'No ad impressions in window')
    k.clickToLead = raw.linkClicks > 0 ? rate('clickToLead', raw.leads, raw.linkClicks, true, 'Link clicks', leadNote) : grey('clickToLead', 'No link clicks in window')

    // 2. CPL
    if (!leadsTracked) k.cpl = untracked('cpl', 'Lead event not tracked in Cortana')
    else if (raw.leads > 0 && raw.spend === 0) k.cpl = grey('cpl', `No paid spend — ${raw.leads} organic / carry-over lead${raw.leads > 1 ? 's' : ''}`)
    else if (raw.leads > 0) k.cpl = rated('cpl', raw.spend / raw.leads, money2(raw.spend / raw.leads), leadNote)
    else if (raw.spend > 0) k.cpl = kpi('cpl', null, 'No leads', 'red', `${money(raw.spend)} spent, 0 leads`)
    else k.cpl = kpi('cpl', null, 'No leads', 'red', 'No spend and no leads in window')
    if (staleLead && k.cpl.status !== 'red') k.cpl = { ...k.cpl, status: 'red', note: `No leads for ${hLead === null ? '60d+' : hours(hLead)}` }

    // 3. Booking rate — booked ÷ leads
    k.bookingRate = !raw.tracked.booked && !raw.tracked.confirmed ? untracked('bookingRate', 'Booking events not tracked in Cortana') : rate('bookingRate', raw.booked, raw.leads, leadsTracked, 'Leads')

    // 4. Confirmation rate — confirmed ÷ booked; Slack booking posts when confirmations aren't logged.
    const slackRate = slack?.connected && slack.allBookings > 0 ? Math.min(100, (slack.confirmedPatients / slack.allBookings) * 100) : null
    if (raw.confirmed === 0 && raw.shown > 0) {
      notes.push('Confirmations not being logged in Cortana (shows exist, 0 confirmed)')
      k.confirmationRate =
        slackRate !== null
          ? rated('confirmationRate', slackRate, pct(slackRate), `From Slack booking posts (${slack!.confirmedPatients}/${slack!.allBookings}) — confirmations not being logged in Cortana`)
          : untracked('confirmationRate', `Confirmations not being logged; Slack ${slack?.connected ? 'has no booking posts' : `not connected${slack?.error ? ` — ${slack.error}` : ''}`}`)
    } else if (!raw.tracked.confirmed && raw.booked === 0) k.confirmationRate = untracked('confirmationRate', 'Confirmed event not tracked in Cortana')
    else
      k.confirmationRate = rate(
        'confirmationRate',
        raw.confirmed,
        raw.booked,
        true,
        'Bookings',
        slackRate !== null ? `Slack cross-check: ${slack!.confirmedPatients}/${slack!.allBookings} confirmed (${pct(slackRate)})` : undefined
      )

    // 5. Close rate — closes ÷ shows. No fallback denominator.
    k.closeRate = !raw.tracked.purchase
      ? untracked('closeRate', 'No closes logged in Cortana for this clinic in the last 9 weeks')
      : raw.shown === 0 && raw.purchases > 0
        ? untracked('closeRate', `${raw.purchases} close${raw.purchases > 1 ? 's' : ''} logged but no shows logged in window`)
        : rate('closeRate', raw.purchases, raw.shown, raw.tracked.shown, 'Shows')

    // 6. Spend / day — also red when nothing spent in the last 24h.
    const perDay = raw.spend / days
    k.spendPerDay = rated('spendPerDay', perDay, money(perDay))
    if (hSpend === null || hSpend > 24) k.spendPerDay = { ...k.spendPerDay, status: 'red', note: `No spend in last ${hSpend === null ? '60d' : hours(hSpend)}` }

    // Extra KPIs
    const perWeek = confirmedFloor / (days / 7)
    k.confirmedPerWeek =
      !raw.tracked.confirmed && !raw.tracked.shown
        ? untracked('confirmedPerWeek', 'Confirmed event not tracked in Cortana')
        : rated('confirmedPerWeek', perWeek, perWeek.toFixed(1), raw.confirmed < raw.shown ? 'Floor from shows (confirmations under-logged)' : undefined)
    k.costPerConfirmed =
      raw.spend === 0
        ? grey('costPerConfirmed', 'No paid spend in window')
        : confirmedFloor > 0
        ? rated('costPerConfirmed', raw.spend / confirmedFloor, money(raw.spend / confirmedFloor))
        : raw.spend > 0
          ? kpi('costPerConfirmed', null, 'None', 'red', `${money(raw.spend)} spent, 0 confirmed`)
          : grey('costPerConfirmed', 'No confirmed appointments tracked')
    k.leadToSale = !raw.tracked.purchase ? untracked('leadToSale', 'No closes logged in Cortana for this clinic in the last 9 weeks') : rate('leadToSale', raw.purchases, raw.leads, leadsTracked, 'Leads')
    k.roas = !raw.tracked.purchase
      ? untracked('roas', 'No closes logged in Cortana for this clinic in the last 9 weeks')
      : raw.spend === 0
        ? grey('roas', 'No spend in window')
        : rated('roas', raw.revenue / raw.spend, mult(raw.revenue / raw.spend), raw.revenue / raw.spend >= (TARGETS.roas.good ?? Infinity) ? 'Strong (≥4x)' : undefined)
    const goal = (TARGETS.revenue.target * days) / AVG_MONTH_DAYS
    k.revenue = !raw.tracked.purchase
      ? untracked('revenue', 'No closes logged in Cortana for this clinic in the last 9 weeks')
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

  const step = (label: string, value: number | null, den: number | null, of?: string): FunnelStep => {
    const p = value !== null && den ? (value / den) * 100 : null
    return { label, value, of, pct: p !== null && p > 100 ? null : p, error: p !== null && p > 100 }
  }
  const leadsV = err || !leadsTracked ? null : raw.leads
  const bookedV = err || (!raw.tracked.booked && !raw.tracked.confirmed) ? null : raw.booked
  const confV = err || (!raw.tracked.confirmed && !raw.tracked.shown) ? null : raw.confirmed
  const shownV = err || !raw.tracked.shown ? null : raw.shown
  const soldV = err || !raw.tracked.purchase ? null : raw.purchases
  const funnel = [
    step('Leads', leadsV, null),
    step('Booked', bookedV, leadsV, 'leads'),
    step('Confirmed', confV, bookedV, 'booked'),
    step('Showed', shownV, bookedV, 'booked'),
    step('Sold', soldV, shownV, 'showed'),
  ]

  return {
    name: clinic.name,
    pod: clinic.pod,
    businessId: clinic.businessId,
    live: raw.bound && (!!raw.error || !!raw.dataError || raw.spend > 0 || raw.leads > 0 || !!raw.lastLeadDate || !!raw.lastSpendDate),
    kpis: k,
    atKpi,
    coreGreen,
    worst: (atKpi ? 0 : 1000) + coreRed * 100 + count('red') * 10 + count('amber') - (err ? 500 : 0),
    funnel,
    daily: raw.daily,
    problem: biggestProblem(k, err),
    notes,
    slack,
    health: { meta: raw.metaConnected, crm: !!raw.lastEventAt, revenue: raw.tracked.purchase, syncedAt: raw.syncedAt, lastEventAt: raw.lastEventAt },
    raw,
    prev: usable(raw) && usable(prevRaw) ? prior([prevRaw]) : null,
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
  if (err) return /^(Not bound|Data error)/.test(err) ? err : `No data — ${err}`
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

export function summarise(all: ClinicReport[]): ClinicsSummary {
  const reports = all.filter((r) => r.live)
  const ok = reports.filter((r) => !r.raw.error && !r.raw.dataError)
  const spend = ok.reduce((s, r) => s + r.raw.spend, 0)
  const leads = ok.reduce((s, r) => s + r.raw.leads, 0)
  // Revenue is closes logged in Cortana against our leads — never Meta pixel purchases.
  // Blended ROAS covers only clinics that track closes, and is hidden until at least half of live clinics do.
  const tracking = ok.filter((r) => r.raw.tracked.purchase)
  const revenue = tracking.reduce((s, r) => s + r.raw.revenue, 0)
  const trackedSpend = tracking.reduce((s, r) => s + r.raw.spend, 0)
  const roasShown = tracking.length > 0 && tracking.length * 2 >= reports.length
  const prevTotals: Prior = {
    spend: ok.reduce((s, r) => s + (r.prev?.spend ?? 0), 0),
    leads: ok.reduce((s, r) => s + (r.prev?.leads ?? 0), 0),
    confirmed: ok.reduce((s, r) => s + (r.prev?.confirmed ?? 0), 0),
    cpl: null,
    revenue: tracking.length ? tracking.reduce((s, r) => s + (r.prev?.revenue ?? 0), 0) : null,
  }
  prevTotals.cpl = prevTotals.leads > 0 ? prevTotals.spend / prevTotals.leads : null
  return {
    atKpi: reports.filter((r) => r.atKpi).length,
    total: reports.length,
    roster: all.length,
    spend,
    leads,
    confirmed: ok.reduce((s, r) => s + Math.max(r.raw.confirmed, r.raw.shown), 0),
    cpl: leads > 0 ? spend / leads : null,
    revenue: tracking.length ? revenue : null,
    revenueTracked: tracking.length,
    roas: roasShown && trackedSpend > 0 ? revenue / trackedSpend : null,
    prev: prevTotals,
    roasHidden: roasShown ? null : `Hidden — ${tracking.length} of ${reports.length} live clinics track closes (needs half)`,
  }
}
