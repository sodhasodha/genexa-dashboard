import { NextResponse } from 'next/server'
import { classifyTx, fetchMercuryTransactions, mercuryGet, txCategory, txName, txTime } from '@/lib/mercury'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

const MONTHS = 13
const r2 = (n: number) => Math.round(n * 100) / 100
const monthKey = (ms: number) => new Date(ms).toISOString().slice(0, 7)
const fmt = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`

type Warning = { level: 'red' | 'amber' | 'info'; text: string }

// GET /api/mercury/overview — everything needed to skip logging in to Mercury:
// balances, month-by-month cash P&L, top spend, recent activity and warnings.
export async function GET() {
  try {
    const now = new Date()
    const months: string[] = []
    for (let i = MONTHS - 1; i >= 0; i--) months.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7))
    const since = `${months[0]}-01T00:00:00Z`
    const curMonth = months[months.length - 1]
    const day = now.getUTCDate()
    const dim = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()

    const [accData, credData, txs, problemTxs] = await Promise.all([
      mercuryGet('/accounts'),
      mercuryGet('/credit'),
      fetchMercuryTransactions(since),
      // Mercury ignores status[] for these, so filter again below.
      fetchMercuryTransactions(new Date(Date.now() - 30 * 86400000).toISOString(), ['failed', 'blocked', 'reversed'])
        .then((list) => list.filter((t) => ['failed', 'blocked', 'reversed'].includes(t.status)))
        .catch(() => []),
    ])

    /* -------------------------------- balances ------------------------------- */
    const accounts = (accData.accounts || []).filter((a: any) => a.status === 'active')
    const checking = accounts.filter((a: any) => a.kind === 'checking')
    const savings = accounts.filter((a: any) => a.kind === 'savings')
    const credit = (credData.accounts || [])[0] || null
    const sum = (list: any[], k: string) => list.reduce((s, a) => s + (a[k] || 0), 0)
    const checkingBal = sum(checking, 'availableBalance')
    const savingsBal = sum(savings, 'availableBalance')
    const creditOwed = credit ? -(credit.currentBalance || 0) : 0
    const creditPending = credit ? -(credit.availableBalance || 0) - creditOwed : 0 // authorised, not yet posted
    const cash = checkingBal + savingsBal
    const accountName: Record<string, string> = {}
    for (const a of accounts) accountName[a.id] = a.kind === 'savings' ? 'Savings' : 'Checking'
    if (credit) accountName[credit.id] = 'Card'

    /* ------------------------------ month-by-month --------------------------- */
    type M = { moneyIn: number; smsIn: number; expenses: number; personal: number; ownerDraws: number }
    const byMonth: Record<string, M> = {}
    for (const m of months) byMonth[m] = { moneyIn: 0, smsIn: 0, expenses: 0, personal: 0, ownerDraws: 0 }
    const merchantsBefore = new Set<string>()
    const curMerchants: Record<string, { amount: number; category: string; count: number }> = {}
    const curCategories: Record<string, number> = {}
    const last30Merchants: Record<string, number> = {}
    let uncategorised = 0
    let pendingCount = 0
    let pendingSum = 0
    const cutoff30 = Date.now() - 30 * 86400000
    const cutoff7 = Date.now() - 7 * 86400000
    const large: any[] = []

    for (const t of txs) {
      const ts = txTime(t)
      const mk = monthKey(ts)
      const b = byMonth[mk]
      const c = classifyTx(t)
      const name = txName(t)
      if (t.status === 'pending') {
        pendingCount += 1
        pendingSum += t.amount
      }
      if (!b) continue
      if (c === 'income') b.moneyIn += t.amount
      else if (c === 'smsPayout') {
        b.moneyIn += t.amount
        b.smsIn += t.amount
      } else if (c === 'expense' || c === 'cardRefund') b.expenses += -t.amount
      else if (c === 'personal') b.personal += -t.amount
      else if (c === 'ownerDraw') b.ownerDraws += -t.amount

      if (c === 'expense' || c === 'cardRefund') {
        if (mk === curMonth) {
          const cm = (curMerchants[name] ||= { amount: 0, category: txCategory(t), count: 0 })
          cm.amount += -t.amount
          cm.count += 1
          curCategories[txCategory(t)] = (curCategories[txCategory(t)] || 0) - t.amount
          if (!t.categoryData?.name && c === 'expense') uncategorised += 1
        } else if (ts < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) {
          merchantsBefore.add(name)
        }
        if (ts >= cutoff30) last30Merchants[name] = (last30Merchants[name] || 0) - t.amount
      }
      if (t.amount <= -1000 && ts >= cutoff7 && c !== 'transfer') large.push(t)
    }

    const monthly = months.map((month) => {
      const b = byMonth[month]
      const net = b.moneyIn - b.expenses
      return {
        month,
        moneyIn: r2(b.moneyIn),
        smsIn: r2(b.smsIn),
        expenses: r2(b.expenses),
        personal: r2(b.personal),
        ownerDraws: r2(b.ownerDraws),
        netProfit: r2(net),
        netMargin: b.moneyIn > 0 ? r2((net / b.moneyIn) * 100) : 0,
        cashChange: r2(net - b.personal - b.ownerDraws),
      }
    })

    const topMerchants = Object.entries(curMerchants)
      .map(([name, v]) => ({ name, amount: r2(v.amount), category: v.category, count: v.count }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10)
    const topCategories = Object.entries(curCategories)
      .map(([category, amount]) => ({ category, amount: r2(amount) }))
      .sort((a, b) => b.amount - a.amount)

    const recent = [...txs]
      .sort((a, b) => txTime(b) - txTime(a))
      .slice(0, 30)
      .map((t) => ({
        id: t.id,
        date: new Date(txTime(t)).toISOString().slice(0, 10),
        name: txName(t),
        amount: t.amount,
        status: t.status,
        account: accountName[t.accountId] || 'Other',
        category: txCategory(t),
        type: classifyTx(t),
      }))

    /* --------------------------------- warnings ------------------------------ */
    const warnings: Warning[] = []
    const full = monthly.slice(-4, -1) // last 3 full months
    const avg = (k: 'expenses' | 'moneyIn') => full.reduce((s, m) => s + m[k], 0) / (full.length || 1)
    const burn = full.reduce((s, m) => s + m.expenses + m.personal + m.ownerDraws, 0) / (full.length || 1)
    const avgIn = avg('moneyIn')
    const netBurn = burn - avgIn
    const cur = monthly[monthly.length - 1]
    const pace = (v: number) => (v / day) * dim

    if (netBurn > 0) {
      const runway = cash / netBurn
      warnings.push({
        level: runway < 3 ? 'red' : runway < 6 ? 'amber' : 'info',
        text: `Net burn ${fmt(netBurn)}/mo (3-mo avg) → ${runway.toFixed(1)} months of runway on current cash.`,
      })
    }
    if (creditOwed > 0) {
      warnings.push({
        level: creditOwed > checkingBal ? 'red' : creditOwed > checkingBal * 0.25 ? 'amber' : 'info',
        text: `Card autopay: ${fmt(creditOwed)} owed${creditPending > 1 ? ` (+${fmt(creditPending)} pending)` : ''} comes out of checking on the 1st → checking ≈ ${fmt(checkingBal - creditOwed - Math.max(creditPending, 0))} after.`,
      })
    }
    const avgExp = avg('expenses')
    if (avgExp > 0 && day >= 5 && pace(cur.expenses) > avgExp * 1.25) {
      warnings.push({ level: 'amber', text: `Spend on pace for ${fmt(pace(cur.expenses))} this month — ${Math.round((pace(cur.expenses) / avgExp - 1) * 100)}% above the 3-month average (${fmt(avgExp)}).` })
    }
    if (avgIn > 0 && day >= 10 && pace(cur.moneyIn) < avgIn * 0.7) {
      warnings.push({ level: 'amber', text: `Money in on pace for ${fmt(pace(cur.moneyIn))} — ${Math.round((1 - pace(cur.moneyIn) / avgIn) * 100)}% below the 3-month average (${fmt(avgIn)}).` })
    }
    if (cur.netProfit < 0 && day >= 10) warnings.push({ level: 'amber', text: `Month to date is net negative: ${fmt(cur.netProfit)}.` })
    for (const t of problemTxs.slice(0, 5)) {
      warnings.push({ level: 'red', text: `${t.status[0].toUpperCase()}${t.status.slice(1)} transaction: ${txName(t)} ${fmt(Math.abs(t.amount))} on ${new Date(txTime(t)).toISOString().slice(0, 10)}.` })
    }
    for (const t of large.slice(0, 5)) {
      warnings.push({ level: 'info', text: `Large payment: ${txName(t)} ${fmt(Math.abs(t.amount))} on ${new Date(txTime(t)).toISOString().slice(0, 10)}.` })
    }
    const newMerchants = topMerchants.filter((m) => !merchantsBefore.has(m.name) && m.amount >= 100)
    if (newMerchants.length) {
      warnings.push({ level: 'info', text: `New merchants this month: ${newMerchants.map((m) => `${m.name} (${fmt(m.amount)})`).join(', ')}.` })
    }
    if (uncategorised > 0) warnings.push({ level: 'amber', text: `${uncategorised} expense${uncategorised > 1 ? 's' : ''} this month have no custom category in Mercury.` })
    if (pendingCount > 0) warnings.push({ level: 'info', text: `${pendingCount} pending transaction${pendingCount > 1 ? 's' : ''} (${fmt(pendingSum)} net).` })
    const order = { red: 0, amber: 1, info: 2 }
    warnings.sort((a, b) => order[a.level] - order[b.level])

    return NextResponse.json({
      asOf: now.toISOString(),
      dayOfMonth: day,
      daysInMonth: dim,
      balances: {
        checking: r2(checkingBal),
        savings: r2(savingsBal),
        cash: r2(cash),
        creditOwed: r2(creditOwed),
        creditPending: r2(Math.max(creditPending, 0)),
        netPosition: r2(cash - creditOwed),
        accounts: [
          ...accounts.map((a: any) => ({ name: a.name, kind: a.kind, balance: a.availableBalance, link: a.dashboardLink })),
          ...(credit ? [{ name: 'Mercury Credit', kind: 'credit', balance: -creditOwed, link: null }] : []),
        ],
      },
      burn: { monthly: r2(burn), net: r2(netBurn), runwayMonths: netBurn > 0 ? r2(cash / netBurn) : null },
      monthly,
      topMerchants,
      topCategories,
      last30Top: Object.entries(last30Merchants).map(([name, amount]) => ({ name, amount: r2(amount) })).sort((a, b) => b.amount - a.amount).slice(0, 5),
      recent,
      warnings,
    })
  } catch (error) {
    console.error('mercury overview error:', error)
    return NextResponse.json({ error: 'Failed to load Mercury overview' }, { status: 500 })
  }
}
