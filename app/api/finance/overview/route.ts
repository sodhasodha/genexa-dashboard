import { NextResponse } from 'next/server'
import { businessExpenses, classifyTx, fetchMercuryTransactions, txTime } from '@/lib/mercury'

const WHOP_API_URL = 'https://api.whop.com/api/v2'
const COMMAS_API_URL = 'https://www.fanbasis.com/public-api'
const MONDAY_API_URL = 'https://api.monday.com/v2'
const MONDAY_CLIENTS_BOARD = 5094961079
const MONDAY_STAGE_COL = 'color_mm7chs4k'

const MONTHS = 13 // 12 full months + current

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

const monthKey = (ms: number) => new Date(ms).toISOString().slice(0, 7)
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const r2 = (n: number) => Math.round(n * 100) / 100

function monthList(): string[] {
  const now = new Date()
  const out: string[] = []
  for (let i = MONTHS - 1; i >= 0; i--) {
    out.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7))
  }
  return out
}

type Sale = { ts: number; customer: string; amount: number; fee: number }
type Refund = { ts: number; amount: number }

/* ---------------------------------- Whop ---------------------------------- */
async function fetchWhop(): Promise<{ sales: Sale[]; refunds: Refund[] }> {
  const apiKey = process.env.WHOP_API_KEY
  if (!apiKey) throw new Error('Whop API key not configured')
  const sales: Sale[] = []
  const refunds: Refund[] = []
  let page = 1
  let totalPages = 1
  do {
    const res = await fetch(`${WHOP_API_URL}/payments?page=${page}&per=50`, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    })
    if (!res.ok) throw new Error(`Whop API error: ${res.statusText}`)
    const data = await res.json()
    totalPages = data.pagination?.total_page ?? 1
    for (const p of data.data || []) {
      if (typeof p.paid_at !== 'number') continue // never collected
      const amount = p.final_amount ?? p.total ?? 0
      const customer = p.user || p.billing_address?.name || p.id
      sales.push({ ts: p.paid_at * 1000, customer, amount, fee: 0 })
      if (p.refunded_amount > 0) {
        refunds.push({ ts: (p.refunded_at ?? p.paid_at) * 1000, amount: p.refunded_amount })
      }
    }
    page += 1
  } while (page <= totalPages && page <= 50)
  return { sales, refunds }
}

/* --------------------------------- Commas --------------------------------- */
async function fetchCommas(): Promise<{ sales: Sale[]; refunds: Refund[] }> {
  const apiKey = process.env.COMMAS_API_KEY
  if (!apiKey) throw new Error('Commas API key not configured')
  const sales: Sale[] = []
  const refunds: Refund[] = []
  let page = 1
  let more = true
  while (more && page <= 50) {
    const res = await fetch(`${COMMAS_API_URL}/checkout-sessions/transactions?per_page=100&page=${page}`, {
      headers: { 'x-api-key': apiKey, Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`Commas API error: ${res.statusText}`)
    const data = (await res.json()).data || {}
    const txs = data.transactions || []
    for (const t of txs) {
      const ts = new Date(t.transaction_date).getTime()
      if (!ts) continue
      sales.push({ ts, customer: t.fan?.id || t.fan?.email || String(t.id), amount: Number(t.amount) || 0, fee: Number(t.fee_amount) || 0 })
      for (const rf of t.refunds || []) {
        refunds.push({ ts: new Date(rf.created_at).getTime() || ts, amount: Number(rf.amount) || 0 })
      }
    }
    more = !!data.pagination?.has_more && txs.length > 0
    page += 1
  }
  return { sales, refunds }
}

/* --------------------------------- Mercury -------------------------------- */
type Expense = { ts: number; amount: number; category: string; name: string }
async function fetchMercury(since: string): Promise<{ expenses: Expense[]; payouts: { ts: number; amount: number }[] }> {
  const txs = await fetchMercuryTransactions(since)
  const payouts = txs.filter((t) => classifyTx(t) === 'smsPayout').map((t) => ({ ts: txTime(t), amount: t.amount }))
  return { expenses: businessExpenses(txs), payouts }
}

/* ------------------------------ Active clients ---------------------------- */
// Monday CLIENTS board: everything not in the churned group / Churned stage.
async function fetchMondayClients(): Promise<{ active: number; live: number; onboarding: number }> {
  const apiKey = process.env.MONDAY_API_KEY
  if (!apiKey) throw new Error('Monday API key not configured')
  const query = `{ boards(ids:[${MONDAY_CLIENTS_BOARD}]){ items_page(limit:500){ items{ group{ title } column_values(ids:["${MONDAY_STAGE_COL}"]){ text } } } } }`
  const res = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json', 'API-Version': '2024-10' },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) throw new Error(`Monday API error: ${res.statusText}`)
  const items = (await res.json()).data?.boards?.[0]?.items_page?.items || []
  let active = 0
  let live = 0
  let onboarding = 0
  for (const i of items) {
    const stage: string = i.column_values?.[0]?.text || ''
    if (/churn|archive/i.test(i.group?.title || '') || /churn/i.test(stage)) continue
    active += 1
    if (/live/i.test(stage)) live += 1
    else if (/onboard/i.test(stage)) onboarding += 1
  }
  return { active, live, onboarding }
}

// Whop memberships currently valid (paying / in an active cycle).
async function fetchWhopActiveMembers(): Promise<number> {
  const apiKey = process.env.WHOP_API_KEY
  if (!apiKey) throw new Error('Whop API key not configured')
  const members = new Set<string>()
  let page = 1
  let totalPages = 1
  do {
    const res = await fetch(`${WHOP_API_URL}/memberships?page=${page}&per=50&valid=true`, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    })
    if (!res.ok) throw new Error(`Whop API error: ${res.statusText}`)
    const data = await res.json()
    totalPages = data.pagination?.total_page ?? 1
    for (const m of data.data || []) if (m.valid) members.add(m.user || m.email || m.id)
    page += 1
  } while (page <= totalPages && page <= 50)
  return members.size
}

/* ------------------------------- Aggregation ------------------------------ */
// Splits sales into new cash (customer's first-ever payment) vs backend (repeat payments).
function monthlyRevenue(sales: Sale[], refunds: Refund[], months: string[], activeWindowDays: number) {
  const sorted = [...sales].sort((a, b) => a.ts - b.ts)
  const seen = new Set<string>()
  const byMonth: Record<string, { newCash: number; backend: number; refunds: number; fees: number }> = {}
  for (const m of months) byMonth[m] = { newCash: 0, backend: 0, refunds: 0, fees: 0 }
  const dailyNet: Record<string, number> = {}

  for (const s of sorted) {
    const isNew = !seen.has(s.customer)
    seen.add(s.customer)
    const m = byMonth[monthKey(s.ts)]
    if (m) {
      if (isNew) m.newCash += s.amount
      else m.backend += s.amount
      m.fees += s.fee
    }
    const d = dayKey(s.ts)
    dailyNet[d] = (dailyNet[d] || 0) + s.amount
  }
  for (const rf of refunds) {
    const m = byMonth[monthKey(rf.ts)]
    if (m) m.refunds += rf.amount
    const d = dayKey(rf.ts)
    dailyNet[d] = (dailyNet[d] || 0) - rf.amount
  }

  // Active clients at each month end = unique payers in the trailing window.
  const now = Date.now()
  const clientsAt = (endMs: number) => {
    const from = endMs - activeWindowDays * 86400000
    return new Set(sorted.filter((s) => s.ts > from && s.ts <= endMs).map((s) => s.customer)).size
  }

  const monthly = months.map((month) => {
    const [y, mo] = month.split('-').map(Number)
    const end = Math.min(Date.UTC(y, mo, 1) - 1, now)
    const b = byMonth[month]
    const gross = b.newCash + b.backend
    return {
      month,
      newCash: r2(b.newCash),
      backend: r2(b.backend),
      gross: r2(gross),
      refunds: r2(b.refunds),
      fees: r2(b.fees),
      netRev: r2(gross - b.refunds),
      clients: clientsAt(end),
    }
  })
  return { monthly, dailyNet }
}

// Cumulative daily series for the current and previous month (for pace charts).
function paceSeries(daily: Record<string, number>) {
  const now = new Date()
  const build = (y: number, m: number, uptoDay: number) => {
    const out: number[] = []
    let acc = 0
    for (let d = 1; d <= uptoDay; d++) {
      acc += daily[new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10)] || 0
      out.push(r2(acc))
    }
    return out
  }
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  const prevDays = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { current: build(y, m, now.getUTCDate()), previous: build(y, m - 1, prevDays) }
}

export async function GET() {
  try {
    const months = monthList()
    const since = `${months[0]}-01T00:00:00Z`
    const now = new Date()

    const [whopR, commasR, mercuryR, mondayR, whopMembersR] = await Promise.allSettled([
      fetchWhop(),
      fetchCommas(),
      fetchMercury(since),
      fetchMondayClients(),
      fetchWhopActiveMembers(),
    ])
    const errors: string[] = []
    if (whopR.status === 'rejected') errors.push(`Whop: ${whopR.reason?.message || whopR.reason}`)
    if (commasR.status === 'rejected') errors.push(`Commas: ${commasR.reason?.message || commasR.reason}`)
    if (mercuryR.status === 'rejected') errors.push(`Mercury: ${mercuryR.reason?.message || mercuryR.reason}`)

    const whop = whopR.status === 'fulfilled' ? whopR.value : { sales: [], refunds: [] }
    const commas = commasR.status === 'fulfilled' ? commasR.value : { sales: [], refunds: [] }
    const mercury = mercuryR.status === 'fulfilled' ? mercuryR.value : { expenses: [], payouts: [] }
    const monday = mondayR.status === 'fulfilled' ? mondayR.value : null
    const whopMembers = whopMembersR.status === 'fulfilled' ? whopMembersR.value : null
    if (mondayR.status === 'rejected') errors.push(`Monday: ${mondayR.reason?.message || mondayR.reason}`)

    // Genexa: Whop revenue (90-day cycles → 90d active window) − Mercury business expenses.
    const g = monthlyRevenue(whop.sales, whop.refunds, months, 90)
    const expByMonth: Record<string, number> = {}
    const dailyExp: Record<string, number> = {}
    for (const e of mercury.expenses) {
      expByMonth[monthKey(e.ts)] = (expByMonth[monthKey(e.ts)] || 0) + e.amount
      dailyExp[dayKey(e.ts)] = (dailyExp[dayKey(e.ts)] || 0) + e.amount
    }
    const genexaMonthly = g.monthly.map((m) => {
      const expenses = r2(expByMonth[m.month] || 0)
      const netProfit = r2(m.netRev - expenses)
      return { ...m, expenses, netProfit, netMargin: m.netRev > 0 ? r2((netProfit / m.netRev) * 100) : 0 }
    })

    // Expense breakdown: current month + trailing 3 full months, by category.
    const curMonth = months[months.length - 1]
    const last3 = months.slice(-4, -1)
    const breakdown: Record<string, { current: number; avg3: number }> = {}
    for (const e of mercury.expenses) {
      const mk = monthKey(e.ts)
      if (mk !== curMonth && !last3.includes(mk)) continue
      const b = (breakdown[e.category] ||= { current: 0, avg3: 0 })
      if (mk === curMonth) b.current += e.amount
      else b.avg3 += e.amount / 3
    }
    const expenseBreakdown = Object.entries(breakdown)
      .map(([category, v]) => ({ category, current: r2(v.current), avg3: r2(v.avg3) }))
      .sort((a, b) => b.current + b.avg3 - (a.current + a.avg3))

    // Cold SMS: whole business (Commas, weekly billing → 30d active window) + Aryan's Mercury payouts.
    const s = monthlyRevenue(commas.sales, commas.refunds, months, 30)
    const smsMonthly = s.monthly.map((m) => {
      const netRev = r2(m.gross - m.refunds - m.fees)
      return { ...m, netRev, netMargin: m.gross > 0 ? r2((netRev / m.gross) * 100) : 0 }
    })
    const payoutByMonth: Record<string, number> = {}
    const dailyPayout: Record<string, number> = {}
    for (const p of mercury.payouts) {
      payoutByMonth[monthKey(p.ts)] = (payoutByMonth[monthKey(p.ts)] || 0) + p.amount
      dailyPayout[dayKey(p.ts)] = (dailyPayout[dayKey(p.ts)] || 0) + p.amount
    }
    const takeMonthly = months.map((month, i) => {
      const payouts = r2(payoutByMonth[month] || 0)
      const bizNet = smsMonthly[i].netRev
      return { month, payouts, bizNet, share: bizNet > 0 ? r2((payouts / bizNet) * 100) : 0 }
    })

    // Everything: Genexa net rev + SMS payouts; expenses are Genexa/Mercury business spend.
    const totalMonthly = months.map((month, i) => {
      const gx = genexaMonthly[i]
      const sms = takeMonthly[i].payouts
      const netRev = r2(gx.netRev + sms)
      const netProfit = r2(netRev - gx.expenses)
      return {
        month,
        newCash: gx.newCash,
        backend: gx.backend,
        refunds: gx.refunds,
        genexaNetRev: gx.netRev,
        smsPayouts: sms,
        netRev,
        expenses: gx.expenses,
        netProfit,
        netMargin: netRev > 0 ? r2((netProfit / netRev) * 100) : 0,
        clients: gx.clients + smsMonthly[i].clients,
      }
    })

    const dailyTotal: Record<string, number> = { ...g.dailyNet }
    for (const [d, v] of Object.entries(dailyPayout)) dailyTotal[d] = (dailyTotal[d] || 0) + v
    const dailyTotalProfit: Record<string, number> = { ...dailyTotal }
    for (const [d, v] of Object.entries(dailyExp)) dailyTotalProfit[d] = (dailyTotalProfit[d] || 0) - v

    return NextResponse.json({
      asOf: now.toISOString(),
      dayOfMonth: now.getUTCDate(),
      daysInMonth: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate(),
      errors,
      genexa: {
        monthly: genexaMonthly,
        activeClients: monday?.active ?? genexaMonthly[genexaMonthly.length - 1].clients,
        clientsDetail: monday
          ? `${monday.live} live · ${monday.onboarding} onboarding${whopMembers !== null ? ` · Whop ${whopMembers} active` : ''}`
          : 'Whop payers (90d)',
        pace: paceSeries(g.dailyNet),
        expenseBreakdown,
      },
      sms: {
        monthly: smsMonthly,
        take: takeMonthly,
        activeClients: smsMonthly[smsMonthly.length - 1].clients,
        pace: paceSeries(s.dailyNet),
        takePace: paceSeries(dailyPayout),
      },
      total: {
        monthly: totalMonthly,
        pace: paceSeries(dailyTotal),
        profitPace: paceSeries(dailyTotalProfit),
      },
    })
  } catch (error) {
    console.error('finance overview error:', error)
    return NextResponse.json({ error: 'Failed to build finance overview' }, { status: 500 })
  }
}
