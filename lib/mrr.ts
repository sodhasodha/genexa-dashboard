import { MondayClient, mondayMatches } from '@/lib/monday'
import { whopCustomerName } from '@/lib/whop'
import { coldSmsPayout } from '@/lib/payStructure'
import { FACTORS } from '@/lib/scenarios'

// MRR (monthly recurring revenue) now, and predicted MRR 30 days out.
//
// Genexa   MRR = Whop renewal memberships (all product lines, normalised to 30 days)
//              + live Monday clients billed outside Whop.
//          Predicted = MRR − memberships set to cancel − 50% of past-due (base recovery)
//                    − expected churn on renewals due in the next 30 days (base retention)
//                    + average new MRR signed per month (last 90 days).
// Cold SMS MRR = each Commas customer's billing run-rate (daily / weekly / monthly), net of fees,
//              excluding setup fees, trials and one-off charges — see smsStreams.
//          Predicted = MRR × net MRR retention (avg of last 3 periods) + average new MRR per 30 days.
// Everything  = Genexa MRR + Aryan's share of Cold SMS MRR (pay structure on MRR − avg SMS expenses) — same basis as the total view.

const DAY = 86400000
const HORIZON = 30 * DAY
const r0 = (n: number) => Math.round(n)
const MONTH = (365 / 12) * DAY
const perMonth = (price: number, periodDays: number) => (price * 30) / (periodDays || 30)

export type Sale = { ts: number; customer: string; amount: number; fee: number; product?: string }

export function genexaMrr(input: { payments: any[]; memberships: any[]; plans: Record<string, any>; products: Record<string, string>; monday: MondayClient[]; now?: number }) {
  const now = input.now ?? Date.now()
  const base = FACTORS.base
  const isGenexa = (planId: string) => {
    const product = input.products[input.plans[planId]?.product] || ''
    return !product || /genexa/i.test(product)
  }
  const nameByUser: Record<string, string> = {}
  for (const p of input.payments) if (p.user && !nameByUser[p.user]) nameByUser[p.user] = whopCustomerName(p)

  // One membership per user+plan (a live one beats a duplicate set to cancel) — mirrors receivables.
  const byUserPlan: Record<string, any> = {}
  for (const m of input.memberships) {
    if (m.status === 'completed') continue
    const k = `${m.user || m.email}-${m.plan}`
    const prev = byUserPlan[k]
    if (!prev || (prev.cancel_at_period_end && !m.cancel_at_period_end)) byUserPlan[k] = m
  }

  let whop = 0
  let other = 0 // non-Genexa Whop product lines (irrigation, mentorships…)
  let cancelling = 0
  let pastDue = 0
  let dueSoon = 0
  const whopUsers = new Set<string>()
  const liveMonday = input.monday.filter((c) => !c.churned)
  const covered = new Set<string>()
  for (const m of Object.values(byUserPlan)) {
    const plan = input.plans[m.plan]
    if (!plan || plan.plan_type !== 'renewal') continue
    const mrr = perMonth(Number(plan.renewal_price) || 0, Number(plan.billing_period))
    if (!mrr) continue
    whop += mrr
    if (!isGenexa(m.plan)) other += mrr
    whopUsers.add(m.user || m.email)
    const client = liveMonday.find((c) => mondayMatches(c, nameByUser[m.user] || '', m.email || ''))
    if (client) covered.add(client.name)
    if (m.cancel_at_period_end) cancelling += mrr
    else if (m.status === 'past_due' || m.status === 'unresolved') pastDue += mrr
    else if (typeof m.renewal_period_end === 'number' && m.renewal_period_end * 1000 <= now + HORIZON) dueSoon += mrr
  }

  // Monday clients billed outside Whop.
  let monday = 0
  let mondayCount = 0
  for (const c of liveMonday) {
    if (covered.has(c.name)) continue
    const mrr = c.monthlyFee || (c.lastPaymentAmount ? perMonth(c.lastPaymentAmount, c.billingCycleDays || 30) : c.retainer)
    if (!mrr) continue
    monday += mrr
    mondayCount += 1
    if (c.nextRenewal && new Date(`${c.nextRenewal}T12:00:00Z`).getTime() <= now + HORIZON) dueSoon += mrr
  }

  // New MRR: renewal-plan customers whose first-ever payment landed in the last 90 days.
  const firstPaid: Record<string, any> = {}
  for (const p of input.payments) {
    if (typeof p.paid_at !== 'number' || !p.user) continue
    if (!firstPaid[p.user] || p.paid_at < firstPaid[p.user].paid_at) firstPaid[p.user] = p
  }
  let new90 = 0
  for (const p of Object.values(firstPaid)) {
    const plan = input.plans[p.plan]
    if (!plan || plan.plan_type !== 'renewal' || now - p.paid_at * 1000 > 90 * DAY) continue
    new90 += perMonth(Number(plan.renewal_price) || 0, Number(plan.billing_period))
  }
  const newAvg = new90 / 3

  const current = whop + monday
  const lost = cancelling + pastDue * (1 - base.recovery) + dueSoon * (1 - base.retention)
  return {
    current: r0(current),
    predicted: r0(Math.max(0, current - lost + newAvg)),
    whop: r0(whop),
    other: r0(other),
    monday: r0(monday),
    clients: whopUsers.size + mondayCount,
    cancelling: r0(cancelling),
    pastDue: r0(pastDue),
    lost: r0(lost),
    newAvg: r0(newAvg),
  }
}

// One-off charges that aren't part of a recurring plan (setup fees, trials, flat one-off invoices).
const ONE_OFF = /setup|trial|one[\s-]?(time|off)|^\$?[\d,.]+$/i

export type Stream = { customer: string; mrr: number; first: number; cadence: number }

// Each customer's MRR at time `at`, from their own billing cadence (daily / weekly / monthly):
//  - cadence  = median gap between billing days (last 60d); single payment → from the plan name, default weekly.
//  - established customers (billing for 28d+) → last 28 days of billing, scaled to a month.
//  - new customers → what they've paid ÷ the days it covers (so a daily payer who started
//    3 days ago counts at a full month of daily billing, a new weekly payer at 4.3 weeks).
//  - lapsed customers (no payment for 2 cycles + 2 days, min 7) drop out; returning ones restart as new.
export function smsStreams(sales: Sale[], at: number): Stream[] {
  const by: Record<string, Sale[]> = {}
  for (const s of sales) if (s.ts <= at && !ONE_OFF.test((s.product || '').trim())) (by[s.customer] ||= []).push(s)
  const out: Stream[] = []
  for (const [customer, list] of Object.entries(by)) {
    list.sort((a, b) => a.ts - b.ts)
    const last = list[list.length - 1]
    const days = Array.from(new Set(list.filter((s) => at - s.ts <= 60 * DAY).map((s) => Math.floor(s.ts / DAY))))
    const gaps = days.slice(1).map((d, i) => d - days[i]).sort((a, b) => a - b)
    const title = last.product || ''
    const cadence = gaps.length
      ? Math.max(1, gaps[Math.floor(gaps.length / 2)])
      : /month|\/mo\b/i.test(title) ? 30 : /estimate|daily|per day/i.test(title) ? 1 : 7
    const lapse = Math.max(7, 2 * cadence + 2) * DAY
    if (at - last.ts > lapse) continue
    // Start of the current unbroken run — a customer returning after a lapse counts as new.
    let i = list.length - 1
    while (i > 0 && list[i].ts - list[i - 1].ts <= Math.max(lapse, 16 * DAY)) i--
    const first = list[i].ts
    const window = Math.max(28, cadence) * DAY
    const inWindow = list.filter((s) => at - s.ts < window)
    const paid = inWindow.reduce((a, s) => a + s.amount - s.fee, 0)
    const covered = first > at - window ? Math.max(last.ts + cadence * DAY, at) - first : window
    out.push({ customer, first, cadence, mrr: (paid / covered) * MONTH })
  }
  return out
}

export function smsMrr(sales: Sale[], now = Date.now()) {
  const snap = (k: number) => {
    const at = now - k * HORIZON
    const streams = smsStreams(sales, at)
    return { at, streams, by: Object.fromEntries(streams.map((s) => [s.customer, s.mrr])) as Record<string, number> }
  }
  const snaps = [0, 1, 2, 3].map(snap)
  const total = (o: Record<string, number>) => Object.values(o).reduce((a, v) => a + v, 0)
  const current = total(snaps[0].by)

  // Net MRR retention per 30 days (last 3 periods): what a period's customers are worth 30 days later.
  let kept = 0
  let base = 0
  for (let k = 1; k <= 3; k++) {
    base += total(snaps[k].by)
    kept += Object.keys(snaps[k].by).reduce((a, c) => a + (snaps[k - 1].by[c] || 0), 0)
  }
  const nrr = base > 0 ? kept / base : 1

  // New MRR per 30 days: customers whose first recurring payment fell in the period, at that period's run-rate.
  const newAvg = [0, 1, 2].reduce((a, k) => a + snaps[k].streams.filter((s) => s.first > snaps[k].at - HORIZON).reduce((b, s) => b + s.mrr, 0), 0) / 3

  const streams = snaps[0].streams
  return {
    current: r0(current),
    predicted: r0(current * nrr + newAvg),
    customers: streams.length,
    daily: streams.filter((s) => s.cadence <= 2).length,
    weekly: streams.filter((s) => s.cadence > 2 && s.cadence <= 10).length,
    retention: Math.round(nrr * 100),
    newAvg: r0(newAvg),
  }
}

// smsExpenses = Cold SMS monthly running costs (the pool is a share of profit).
export function totalMrr(g: { current: number; predicted: number }, s: { current: number; predicted: number }, smsExpenses: number) {
  const smsNow = coldSmsPayout({ revenue: s.current, profit: s.current - smsExpenses }).aryan
  const smsNext = coldSmsPayout({ revenue: s.predicted, profit: s.predicted - smsExpenses }).aryan
  return {
    current: r0(g.current + smsNow),
    predicted: r0(g.predicted + smsNext),
    genexa: g.current,
    smsShare: r0(smsNow),
    smsSharePredicted: r0(smsNext),
  }
}
