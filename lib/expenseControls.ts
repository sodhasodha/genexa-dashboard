import { businessExpenses } from '@/lib/mercury'

// Actionable expense rows built from Mercury business spend.
//  - recurring: billed in ≥2 of the last 3 full months, and again last month or this month
//  - new merchant: first-ever charge is this month
//  - status: auto 'Review' on spikes / new merchants / large one-offs; 'Cancel' is set by the user
//  - potential savings: Cancel rows' monthly cost + Review rows' excess over their 3-mo average

export type ExpenseStatus = 'Normal' | 'Review' | 'Cancel'
export type ExpenseRow = {
  key: string
  name: string
  category: string
  thisMonth: number
  pace: number // month-end projection at current run-rate
  avg3: number
  changePct: number | null // pace vs 3-mo avg
  recurring: boolean
  newMerchant: boolean
  largestThisMonth: number
  autoStatus: ExpenseStatus
  reasons: string[] // anomaly chips
}

const AD_CATS = /advertis|marketing/i
const SOFTWARE_CATS = /software|subscription/i
export const isAdCategory = (c: string) => AD_CATS.test(c)
export const isSoftwareCategory = (c: string) => SOFTWARE_CATS.test(c)
// Card descriptors like "Whop*cameronconsul" and "Whop" are the same merchant.
const merchantKey = (name: string) => name.split('*')[0].toLowerCase().replace(/[^a-z]/g, '').slice(0, 24) || 'unknown'

export function buildExpenseRows(txs: any[], now = new Date()): ExpenseRow[] {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  const monthKeyAt = (offset: number) => new Date(Date.UTC(y, m - offset, 1)).toISOString().slice(0, 7)
  const cur = monthKeyAt(0)
  const prev3 = [monthKeyAt(1), monthKeyAt(2), monthKeyAt(3)]
  const day = now.getUTCDate()
  const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()

  type Acc = { name: string; category: string; byMonth: Record<string, number>; first: number; largest: number; txCount: number }
  const acc: Record<string, Acc> = {}
  for (const e of businessExpenses(txs)) {
    const k = merchantKey(e.name)
    const a = (acc[k] ||= { name: e.name, category: e.category, byMonth: {}, first: e.ts, largest: 0, txCount: 0 })
    const mk = new Date(e.ts).toISOString().slice(0, 7)
    a.byMonth[mk] = (a.byMonth[mk] || 0) + e.amount
    a.first = Math.min(a.first, e.ts)
    if (mk === cur) {
      a.largest = Math.max(a.largest, e.amount)
      a.txCount += 1
      a.category = e.category // latest categorisation wins
    }
  }

  const rows: ExpenseRow[] = []
  for (const [key, a] of Object.entries(acc)) {
    const thisMonth = a.byMonth[cur] || 0
    const hist = prev3.map((mk) => a.byMonth[mk] || 0)
    const avg3 = hist.reduce((s, v) => s + v, 0) / 3
    if (thisMonth <= 0 && avg3 < 25) continue // dormant / trivial

    const activeMonths = hist.filter((v) => v > 0).length
    const recurring = activeMonths >= 2 && (hist[0] > 0 || thisMonth > 0)
    // Recurring charges bill on a schedule, so don't extrapolate them past what's billed;
    // variable spend (ads, one-offs) is projected at the daily run-rate.
    const pace = recurring && !isAdCategory(a.category) ? Math.max(thisMonth, avg3) : (thisMonth / day) * dim
    const changePct = avg3 > 0 ? ((pace - avg3) / avg3) * 100 : null
    const newMerchant = new Date(a.first).toISOString().slice(0, 7) === cur

    const reasons: string[] = []
    let autoStatus: ExpenseStatus = 'Normal'
    if (changePct !== null && changePct >= 50 && pace - avg3 >= 150) {
      reasons.push(`+${Math.round(changePct)}% vs normal`)
      autoStatus = 'Review'
    }
    if (newMerchant && thisMonth >= 100) {
      reasons.push(a.txCount >= 2 ? 'New recurring merchant' : 'New merchant')
      autoStatus = 'Review'
    }
    if (!recurring && a.largest >= 1000) {
      reasons.push('Large one-off')
      autoStatus = 'Review'
    }

    rows.push({
      key,
      name: a.name,
      category: a.category,
      thisMonth: Math.round(thisMonth * 100) / 100,
      pace: Math.round(pace),
      avg3: Math.round(avg3),
      changePct: changePct === null ? null : Math.round(changePct),
      recurring,
      newMerchant,
      largestThisMonth: Math.round(a.largest),
      autoStatus,
      reasons,
    })
  }
  return rows.sort((a, b) => Math.max(b.pace, b.avg3) - Math.max(a.pace, a.avg3))
}

// Monthly figures the forecast needs, split by behaviour.
export function expenseDrivers(rows: ExpenseRow[]) {
  let recurringFixed = 0 // payroll, software, other recurring (non-ad)
  let ads = 0
  let variable = 0
  let software = 0
  for (const r of rows) {
    // Ads follow the current run-rate (spend is switched up/down deliberately); others use the 3-mo average.
    if (isAdCategory(r.category)) ads += r.thisMonth > 0 ? r.pace : r.avg3 * 0.5
    else if (r.recurring) {
      recurringFixed += r.avg3
      if (isSoftwareCategory(r.category)) software += r.avg3
    } else variable += r.avg3
  }
  return { recurringFixed: Math.round(recurringFixed), ads: Math.round(ads), variable: Math.round(variable), software: Math.round(software) }
}

export function potentialSavings(rows: ExpenseRow[], status: (r: ExpenseRow) => ExpenseStatus): number {
  let total = 0
  for (const r of rows) {
    const s = status(r)
    if (s === 'Cancel') total += Math.max(r.avg3, r.pace)
    // Ad increases are deliberate scaling, not waste — flagged for review but not counted as savings.
    else if (s === 'Review' && !isAdCategory(r.category)) total += Math.max(0, r.pace - r.avg3)
  }
  return Math.round(total)
}
