import { MondayClient, mondayMatches } from '@/lib/monday'
import { whopCustomerName } from '@/lib/whop'

// Expected money (accounts receivable) — what should land in the next 30 days.
//
// Canonical sources, in priority order (never counted twice):
//  1. Whop active memberships  → auto-billed renewals (dates + prices are exact).
//  2. Whop failed payments      → declined charges not recovered by a later payment.
//  3. Monday CLIENTS board      → clients billed outside Whop (manual invoices / legacy).
//  4. Cold SMS                  → Aryan's projected payout for the current month.

export type ArStatus = 'Expected' | 'Due soon' | 'Overdue' | 'At risk' | 'Paid'
export type ArItem = {
  id: string
  customer: string
  business: string // 'Genexa' | 'Cold SMS' | other Whop product lines
  source: string
  amount: number
  date: string // expected payment date (YYYY-MM-DD)
  type: string
  confidence: number // 0–1
  status: ArStatus
  daysOverdue: number
  flags: string[]
  health?: string
  url?: string | null // underlying client record (Monday)
}

const DAY = 86400000
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const HEALTH_CONF: Record<string, number> = { Green: 0.95, Amber: 0.85, Red: 0.75 }

function statusFor(dateMs: number, now: number, atRisk: boolean): { status: ArStatus; daysOverdue: number } {
  const daysOverdue = Math.max(0, Math.floor((now - dateMs) / DAY))
  if (atRisk || daysOverdue > 14) return { status: 'At risk', daysOverdue }
  if (daysOverdue > 0) return { status: 'Overdue', daysOverdue }
  if (dateMs - now <= 7 * DAY) return { status: 'Due soon', daysOverdue: 0 }
  return { status: 'Expected', daysOverdue: 0 }
}

export function buildReceivables(input: {
  payments: any[]
  memberships: any[]
  plans: Record<string, any>
  products?: Record<string, string>
  monday: MondayClient[]
  smsExpectedPayout?: { amount: number; month: string } | null
  now?: number
}): ArItem[] {
  const now = input.now ?? Date.now()
  const horizon = now + 30 * DAY
  const items: ArItem[] = []
  const liveMonday = input.monday.filter((c) => !c.churned)
  const coveredMonday = new Set<string>()
  const mondayFor = (name: string, email: string) => liveMonday.find((c) => mondayMatches(c, name, email))

  // Latest successful payment per Whop user (for "Paid" + recovery detection).
  const paidByUser: Record<string, any[]> = {}
  for (const p of input.payments) {
    if (typeof p.paid_at !== 'number' || !p.user) continue
    ;(paidByUser[p.user] ||= []).push(p)
  }
  // Whop also bills non-Genexa product lines (irrigation, mentorships…) — label them by product.
  const businessFor = (planId: string) => {
    const product = input.products?.[input.plans[planId]?.product] || ''
    return !product || /genexa/i.test(product) ? 'Genexa' : product
  }
  const nameByUser: Record<string, string> = {}
  for (const p of input.payments) if (p.user && !nameByUser[p.user]) nameByUser[p.user] = whopCustomerName(p)

  /* 1. Whop renewals ------------------------------------------------------- */
  // One row per user+plan: a live membership supersedes duplicates that are set to cancel.
  const byUserPlan: Record<string, any> = {}
  for (const m of input.memberships) {
    if (m.status === 'completed') continue
    const k = `${m.user || m.email}-${m.plan}`
    const prev = byUserPlan[k]
    if (!prev || (prev.cancel_at_period_end && !m.cancel_at_period_end) || (prev.cancel_at_period_end === m.cancel_at_period_end && (m.renewal_period_end || 0) > (prev.renewal_period_end || 0))) byUserPlan[k] = m
  }
  for (const m of Object.values(byUserPlan)) {
    const plan = input.plans[m.plan]
    if (!plan || plan.plan_type !== 'renewal' || typeof m.renewal_period_end !== 'number') continue
    const amount = Number(plan.renewal_price) || 0
    if (!amount) continue
    const name = nameByUser[m.user] || m.email || 'Unknown'
    const client = mondayFor(name, m.email || '')
    if (client) coveredMonday.add(client.name)
    const dateMs = m.renewal_period_end * 1000
    const cancelling = !!m.cancel_at_period_end
    const pastDue = m.status === 'past_due' || m.status === 'unresolved'
    if (dateMs > horizon && !pastDue) continue
    const flags: string[] = []
    if (cancelling) flags.push('Cancels at period end')
    if (pastDue) flags.push('Payment failed')
    const base = HEALTH_CONF[client?.health || ''] ?? 0.85
    const { status, daysOverdue } = statusFor(dateMs, now, cancelling)
    items.push({
      id: `whop-${m.id}`,
      customer: client?.name.replace(/\s*pod\s*\d.*$/i, '') || name,
      business: businessFor(m.plan),
      source: 'Whop auto-renew',
      amount,
      date: iso(dateMs),
      type: `Renewal · ${plan.billing_period}d`,
      confidence: cancelling ? 0.1 : pastDue ? 0.4 : base,
      status: pastDue && status !== 'At risk' ? 'Overdue' : status,
      daysOverdue,
      flags,
      health: client?.health,
      url: client?.url,
    })
  }

  /* 2. Failed Whop payments not recovered ---------------------------------- */
  const seenFail = new Set<string>()
  const failed = input.payments
    .filter((p) => typeof p.paid_at !== 'number' && p.status === 'open' && (p.payments_failed || 0) > 0)
    .filter((p) => now - p.created_at * 1000 <= 45 * DAY)
    .sort((a, b) => b.created_at - a.created_at)
  for (const p of failed) {
    const failedAt = p.created_at * 1000
    const recovered = (paidByUser[p.user] || []).some((x) => x.paid_at * 1000 >= failedAt - DAY)
    // Membership renewed since the failure → it was recovered via a new charge.
    const renewed = input.memberships.some((m) => m.user === p.user && (m.renewal_period_start || 0) * 1000 > failedAt)
    const key = `${p.user || whopCustomerName(p)}-${p.final_amount}`
    if (recovered || renewed || seenFail.has(key)) continue
    seenFail.add(key)
    const name = whopCustomerName(p)
    const client = mondayFor(name, '')
    if (client) coveredMonday.add(client.name)
    const { status, daysOverdue } = statusFor(failedAt, now, false)
    items.push({
      id: `whop-fail-${p.id}`,
      customer: client?.name.replace(/\s*pod\s*\d.*$/i, '') || name,
      business: businessFor(p.plan),
      source: 'Whop · declined',
      amount: Number(p.final_amount) || 0,
      date: iso(failedAt),
      type: 'Failed charge',
      confidence: daysOverdue > 14 ? 0.3 : 0.5,
      status,
      daysOverdue,
      flags: ['Payment failed'],
      health: client?.health,
      url: client?.url,
    })
  }

  /* 3. Monday clients billed outside Whop --------------------------------- */
  for (const c of liveMonday) {
    if (coveredMonday.has(c.name) || !c.nextRenewal) continue
    const amount = c.lastPaymentAmount || c.monthlyFee * ((c.billingCycleDays || 30) / 30) || c.retainer
    if (!amount) continue
    const dateMs = new Date(`${c.nextRenewal}T12:00:00Z`).getTime()
    if (dateMs > horizon) continue
    const { status, daysOverdue } = statusFor(dateMs, now, false)
    items.push({
      id: `monday-${c.name}`,
      customer: c.name.replace(/\s*pod\s*\d.*$/i, ''),
      business: 'Genexa',
      source: 'Monday · manual invoice',
      amount,
      date: c.nextRenewal,
      type: c.billingCycleDays ? `Renewal · ${c.billingCycleDays}d` : 'Retainer',
      confidence: (HEALTH_CONF[c.health] ?? 0.75) - 0.1,
      status,
      daysOverdue,
      flags: /overdue/i.test(c.renewalStatus) ? ['Marked overdue in Monday'] : [],
      health: c.health,
      url: c.url,
    })
  }

  /* Paid in the last 7 days (shown for context, excluded from totals) ------- */
  for (const p of input.payments) {
    if (typeof p.paid_at !== 'number' || now - p.paid_at * 1000 > 7 * DAY) continue
    const plan = input.plans[p.plan]
    const client = mondayFor(whopCustomerName(p), p.email || '')
    items.push({
      id: `paid-${p.id}`,
      url: client?.url,
      customer: whopCustomerName(p),
      business: businessFor(p.plan),
      source: 'Whop',
      amount: Number(p.final_amount) || 0,
      date: iso(p.paid_at * 1000),
      type: plan?.plan_type === 'renewal' ? `Renewal · ${plan.billing_period}d` : 'One-off',
      confidence: 1,
      status: 'Paid',
      daysOverdue: 0,
      flags: [],
    })
  }

  /* 4. Cold SMS payout ----------------------------------------------------- */
  if (input.smsExpectedPayout && input.smsExpectedPayout.amount > 0) {
    const [y, mo] = input.smsExpectedPayout.month.split('-').map(Number)
    const dateMs = Date.UTC(y, mo, 5) // payouts typically land in the first week of the next month
    items.push({
      id: `sms-${input.smsExpectedPayout.month}`,
      customer: 'Jacob · Ray Media',
      business: 'Cold SMS',
      source: 'Pay structure (est.)',
      amount: input.smsExpectedPayout.amount,
      date: iso(dateMs),
      type: 'Partner payout',
      confidence: 0.8,
      ...statusFor(dateMs, now, false),
      flags: [],
    })
  }

  const order: Record<ArStatus, number> = { 'At risk': 0, Overdue: 1, 'Due soon': 2, Expected: 3, Paid: 4 }
  return items.sort((a, b) => order[a.status] - order[b.status] || a.date.localeCompare(b.date))
}

export function summariseReceivables(items: ArItem[]) {
  const open = items.filter((i) => i.status !== 'Paid')
  const sum = (list: ArItem[]) => Math.round(list.reduce((s, i) => s + i.amount, 0))
  return {
    expected30: sum(open),
    highConfidence: sum(open.filter((i) => i.confidence >= 0.8 && (i.status === 'Expected' || i.status === 'Due soon'))),
    overdue: sum(open.filter((i) => i.status === 'Overdue')),
    atRisk: sum(open.filter((i) => i.status === 'At risk')),
    weighted: sum(open.map((i) => ({ ...i, amount: i.amount * i.confidence }))),
  }
}
