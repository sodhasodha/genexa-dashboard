import { NextResponse } from 'next/server'
import { classifyTx, fetchMercuryTransactions, mercuryGet, txTime, businessExpenses } from '@/lib/mercury'
import { fetchWhopMemberships, fetchWhopPayments, fetchWhopPlans, fetchWhopProducts } from '@/lib/whop'
import { fetchMondayClients, MondayClient } from '@/lib/monday'
import { fetchColdSmsSheet, SheetMonth } from '@/lib/coldSmsSheet'
import { buildReceivables, summariseReceivables } from '@/lib/receivables'
import { buildExpenseRows, expenseDrivers } from '@/lib/expenseControls'
import { runAllScenarios, Renewal } from '@/lib/scenarios'
import { coldSmsPayout } from '@/lib/payStructure'
import { genexaMrr, smsMrr, totalMrr } from '@/lib/mrr'

const COMMAS_API_URL = 'https://www.fanbasis.com/public-api'
const MONTHS = 13 // 12 full months + current

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

const monthKey = (ms: number) => new Date(ms).toISOString().slice(0, 7)
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const r2 = (n: number) => Math.round(n * 100) / 100
const avg = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0)

function monthList(): string[] {
  const now = new Date()
  const out: string[] = []
  for (let i = MONTHS - 1; i >= 0; i--) {
    out.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7))
  }
  return out
}

type Sale = { ts: number; customer: string; amount: number; fee: number; product?: string }
type Refund = { ts: number; amount: number }

/* ---------------------------------- Whop ---------------------------------- */
function whopSales(payments: any[]): { sales: Sale[]; refunds: Refund[] } {
  const sales: Sale[] = []
  const refunds: Refund[] = []
  for (const p of payments) {
    if (typeof p.paid_at !== 'number') continue // never collected
    const amount = p.final_amount ?? p.total ?? 0
    const customer = p.user || p.billing_address?.name || p.id
    sales.push({ ts: p.paid_at * 1000, customer, amount, fee: 0 })
    if (p.refunded_amount > 0) refunds.push({ ts: (p.refunded_at ?? p.paid_at) * 1000, amount: p.refunded_amount })
  }
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
      sales.push({ ts, customer: t.fan?.id || t.fan?.email || String(t.id), amount: Number(t.amount) || 0, fee: Number(t.fee_amount) || 0, product: t.product?.title || t.service?.title || '' })
      for (const rf of t.refunds || []) {
        refunds.push({ ts: new Date(rf.created_at).getTime() || ts, amount: Number(rf.amount) || 0 })
      }
    }
    more = !!data.pagination?.has_more && txs.length > 0
    page += 1
  }
  return { sales, refunds }
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

const settled = <T,>(r: PromiseSettledResult<T>, fallback: T, label: string, errors: string[]): T => {
  if (r.status === 'fulfilled') return r.value
  errors.push(`${label}: ${(r.reason as Error)?.message || r.reason}`)
  return fallback
}

export async function GET() {
  try {
    const months = monthList()
    const since = `${months[0]}-01T00:00:00Z`
    const now = new Date()
    const day = now.getUTCDate()
    const dim = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()
    const curMonth = months[months.length - 1]

    const results = await Promise.allSettled([
      fetchWhopPayments(),
      fetchCommas(),
      fetchMercuryTransactions(since),
      fetchMondayClients(),
      fetchWhopMemberships(),
      fetchWhopPlans(),
      fetchColdSmsSheet(),
      Promise.all([mercuryGet('/accounts'), mercuryGet('/credit')]),
      fetchWhopProducts(),
    ])
    const errors: string[] = []
    const payments = settled(results[0], [] as any[], 'Whop', errors)
    const commas = settled(results[1], { sales: [] as Sale[], refunds: [] as Refund[] }, 'Commas', errors)
    const txs = settled(results[2], [] as any[], 'Mercury', errors)
    const monday = settled(results[3], [] as MondayClient[], 'Monday', errors)
    const memberships = settled(results[4], [] as any[], 'Whop memberships', errors)
    const plans = settled(results[5], {} as Record<string, any>, 'Whop plans', errors)
    const sheet = settled(results[6], [] as SheetMonth[], 'Cold SMS sheet', errors)
    const products = settled(results[8], {} as Record<string, string>, 'Whop products', errors)
    const [accData, credData] = settled(results[7], [{ accounts: [] }, { accounts: [] }] as any[], 'Mercury balances', errors)

    const whop = whopSales(payments)
    const expenses = businessExpenses(txs)
    const payouts = txs.filter((t) => classifyTx(t) === 'smsPayout').map((t) => ({ ts: txTime(t), amount: t.amount as number }))

    /* ------------------------------- Genexa ------------------------------- */
    // Whop revenue (90-day cycles → 90d active window) − Mercury business expenses.
    const g = monthlyRevenue(whop.sales, whop.refunds, months, 90)
    const expByMonth: Record<string, number> = {}
    const dailyExp: Record<string, number> = {}
    for (const e of expenses) {
      expByMonth[monthKey(e.ts)] = (expByMonth[monthKey(e.ts)] || 0) + e.amount
      dailyExp[dayKey(e.ts)] = (dailyExp[dayKey(e.ts)] || 0) + e.amount
    }
    const genexaMonthly = g.monthly.map((m) => {
      const exp = r2(expByMonth[m.month] || 0)
      const netProfit = r2(m.netRev - exp)
      return { ...m, expenses: exp, netProfit, netMargin: m.netRev > 0 ? r2((netProfit / m.netRev) * 100) : 0 }
    })
    const liveMonday = monday.filter((c) => !c.churned)
    const whopActive = new Set(memberships.filter((m) => m.valid && m.status !== 'completed').map((m) => m.user || m.email)).size

    /* ------------------------------ Cold SMS ------------------------------ */
    // Canonical per metric (never summed across sources):
    //   revenue / expenses / profit → Jacob's sheet for months he has closed;
    //                                 current month → Commas net (gross − refunds − fees), expenses est.
    //   Aryan's payout (cash)       → Mercury deposits (Ray Media / FanBasis).
    //   new cash / backend / fees / clients → Commas (sheet doesn't split these).
    const s = monthlyRevenue(commas.sales, commas.refunds, months, 30)
    const sheetBy: Record<string, SheetMonth> = {}
    for (const m of sheet) sheetBy[m.month] = m
    const sheetExpAvg = avg(sheet.slice(-3).map((m) => m.expenses))
    const smsMonthly = s.monthly.map((m) => {
      const commasNet = r2(m.gross - m.refunds - m.fees)
      const sh = sheetBy[m.month]
      const revenue = sh ? sh.revenue : commasNet
      // No sheet row yet: estimate expenses from the sheet's 3-mo average (prorated for the current month).
      const estExp = m.month === curMonth ? (sheetExpAvg * day) / dim : sheetExpAvg
      const exp = sh ? sh.expenses : commasNet > 0 && sheet.length ? estExp : 0
      const netProfit = revenue - exp
      return {
        ...m,
        commasNet,
        sheetRevenue: sh ? r2(sh.revenue) : null,
        netRev: r2(revenue),
        revenue: r2(revenue),
        expenses: r2(exp),
        netProfit: r2(netProfit),
        netMargin: revenue > 0 ? r2((netProfit / revenue) * 100) : 0,
        source: sh ? 'sheet' : 'commas',
      }
    })
    const payoutByMonth: Record<string, number> = {}
    const dailyPayout: Record<string, number> = {}
    for (const p of payouts) {
      payoutByMonth[monthKey(p.ts)] = (payoutByMonth[monthKey(p.ts)] || 0) + p.amount
      dailyPayout[dayKey(p.ts)] = (dailyPayout[dayKey(p.ts)] || 0) + p.amount
    }
    const takeMonthly = months.map((month, i) => {
      const received = r2(payoutByMonth[month] || 0)
      const calc = coldSmsPayout(smsMonthly[i].revenue)
      return { month, payouts: received, calcAryan: r2(calc.aryan), calcRishil: r2(calc.rishil), pool: r2(calc.pool) }
    })
    // Reconciliation rows for months where either source has data.
    const reconcile = smsMonthly
      .filter((m) => m.sheetRevenue !== null || m.commasNet > 0)
      .map((m, _i) => {
        const t = takeMonthly.find((x) => x.month === m.month)!
        return {
          month: m.month,
          sheet: m.sheetRevenue,
          commas: m.commasNet,
          canonical: m.revenue,
          source: m.source,
          calcAryan: t.calcAryan,
          received: t.payouts,
        }
      })

    /* ----------------------------- Everything ----------------------------- */
    // Genexa net rev + SMS payouts received (cash) — SMS business revenue is NOT added here,
    // since the payout is our share of it.
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

    /* ---------------------------- Expected money --------------------------- */
    const curSms = smsMonthly[smsMonthly.length - 1]
    const smsProjectedRev = (curSms.commasNet / day) * dim
    const smsExpected = Math.max(0, coldSmsPayout(smsProjectedRev).aryan)
    const receivables = buildReceivables({
      payments,
      memberships,
      plans,
      products,
      monday,
      smsExpectedPayout: { amount: Math.round(smsExpected), month: curMonth },
    })

    /* ---------------------------- Expense controls ------------------------- */
    const expenseRows = buildExpenseRows(txs, now)
    const drivers = expenseDrivers(expenseRows)

    /* -------------------------------- Forecast ----------------------------- */
    const accounts = (accData.accounts || []).filter((a: any) => a.status === 'active')
    const cash = accounts.reduce((sum: number, a: any) => sum + (a.availableBalance || 0), 0)
    const credit = (credData.accounts || [])[0]
    const cardOwed = credit ? -(credit.availableBalance ?? credit.currentBalance ?? 0) : 0 // incl. pending
    const netPosition = cash - cardOwed

    // Known renewals: Whop auto-renew schedule, plus Monday clients billed outside Whop.
    const renewals: Renewal[] = []
    for (const it of receivables) {
      if (it.business === 'Cold SMS' || it.status === 'Paid') continue
      if (it.source === 'Whop auto-renew' && !it.flags.includes('Cancels at period end') && !it.flags.includes('Payment failed')) {
        const cycle = Number(it.type.match(/(\d+)d/)?.[1]) || 30
        renewals.push({ dateMs: new Date(`${it.date}T12:00:00Z`).getTime(), amount: it.amount, confidence: it.confidence, cycleDays: cycle })
      }
      if (it.source.startsWith('Monday') && it.status !== 'Overdue' && it.status !== 'At risk') {
        const cycle = Number(it.type.match(/(\d+)d/)?.[1]) || 30
        renewals.push({ dateMs: new Date(`${it.date}T12:00:00Z`).getTime(), amount: it.amount, confidence: it.confidence, cycleDays: cycle })
      }
    }
    // Whop memberships renewing beyond the 30-day receivables window still recur inside the forecast.
    for (const m of memberships) {
      const plan = plans[m.plan]
      if (!plan || plan.plan_type !== 'renewal' || m.cancel_at_period_end || typeof m.renewal_period_end !== 'number') continue
      const dateMs = m.renewal_period_end * 1000
      if (dateMs <= Date.now() + 30 * 86400000) continue // already in receivables
      renewals.push({ dateMs, amount: Number(plan.renewal_price) || 0, confidence: 0.85, cycleDays: Number(plan.billing_period) || 30 })
    }
    const overdue = receivables
      .filter((i) => i.business !== 'Cold SMS' && (i.status === 'Overdue' || i.status === 'At risk') && !i.flags.includes('Cancels at period end'))
      .reduce((sum, i) => sum + i.amount, 0)

    const full3 = genexaMonthly.slice(-4, -1)
    const full6 = genexaMonthly.slice(-7, -1)
    const gross6 = full6.reduce((sum, m) => sum + m.gross, 0)
    const cur = genexaMonthly[genexaMonthly.length - 1]
    // Owner draws + personal spend: average of the last 3 full months.
    const drawsByMonth: Record<string, number> = {}
    for (const t of txs) {
      const c = classifyTx(t)
      if (c === 'ownerDraw' || c === 'personal') drawsByMonth[monthKey(txTime(t))] = (drawsByMonth[monthKey(txTime(t))] || 0) - t.amount
    }
    const forecastInput = {
      now,
      renewals,
      overdue,
      newCashAvg: avg(full3.map((m) => m.newCash)),
      refundRate: gross6 > 0 ? full6.reduce((sum, m) => sum + m.refunds, 0) / gross6 : 0,
      smsRevenueAvg: avg(smsMonthly.slice(-4, -1).map((m) => m.revenue)),
      expenses: drivers,
      drawsAvg: avg(months.slice(-4, -1).map((mk) => drawsByMonth[mk] || 0)),
      netPosition,
      actual: {
        newCash: cur.newCash,
        backend: cur.backend,
        refunds: cur.refunds,
        expenses: cur.expenses,
        smsReceived: takeMonthly[takeMonthly.length - 1].payouts,
      },
    }
    const recurringRevenue = memberships
      .filter((m) => plans[m.plan]?.plan_type === 'renewal' && !m.cancel_at_period_end && m.status !== 'completed')
      .reduce((sum, m) => sum + ((Number(plans[m.plan].renewal_price) || 0) * 30) / (Number(plans[m.plan].billing_period) || 30), 0)

    const gMrr = genexaMrr({ payments, memberships, plans, products, monday })
    const sMrr = smsMrr(commas.sales)
    const mrr = { genexa: gMrr, sms: sMrr, total: totalMrr(gMrr, sMrr) }

    return NextResponse.json({
      asOf: now.toISOString(),
      dayOfMonth: day,
      daysInMonth: dim,
      errors,
      genexa: {
        monthly: genexaMonthly,
        activeClients: liveMonday.length || genexaMonthly[genexaMonthly.length - 1].clients,
        clientsDetail: liveMonday.length
          ? `${liveMonday.filter((c) => /live/i.test(c.stage)).length} live · ${liveMonday.filter((c) => /onboard/i.test(c.stage)).length} onboarding · Whop ${whopActive} active`
          : 'Whop payers (90d)',
        pace: paceSeries(g.dailyNet),
        forecast: runAllScenarios(forecastInput, false),
      },
      sms: {
        monthly: smsMonthly,
        take: takeMonthly,
        reconcile,
        activeClients: smsMonthly[smsMonthly.length - 1].clients,
        pace: paceSeries(s.dailyNet),
        sheetUpdatedTo: sheet.length ? sheet[sheet.length - 1].month : null,
      },
      total: {
        monthly: totalMonthly,
        pace: paceSeries(dailyTotal),
        forecast: runAllScenarios(forecastInput, true),
      },
      mrr,
      receivables: { items: receivables, summary: summariseReceivables(receivables) },
      expenses: { rows: expenseRows },
      drivers: {
        recurringRevenue: Math.round(recurringRevenue),
        ...drivers,
        netPosition: Math.round(netPosition),
        overdue: Math.round(overdue),
        newCashAvg: Math.round(forecastInput.newCashAvg),
        refundRate: r2(forecastInput.refundRate * 100),
        drawsAvg: Math.round(forecastInput.drawsAvg),
      },
    })
  } catch (error) {
    console.error('finance overview error:', error)
    return NextResponse.json({ error: 'Failed to build finance overview' }, { status: 500 })
  }
}
