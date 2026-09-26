import { coldSmsPayout } from '@/lib/payStructure'

// Driver-based forecast: current month + next 3, in three scenarios.
//
// Revenue = known renewals (Whop schedule + Monday manual invoices, weighted by client
//           health and compounded retention per cycle)
//         + recovery of overdue/failed payments
//         + new cash (3-mo average × scenario factor)
//         − refunds (6-mo refund rate × scenario factor)
//         + Cold SMS payout (pay structure on 3-mo avg SMS revenue × scenario factor)   [total view only]
// Expenses = recurring fixed (payroll, software…) + ad spend + variable spend (3-mo averages)
// Ending cash = today's net position (cash − card owed; card autopays are financing, not
//               expense) + projected profit − average owner draws/personal spend.

export type ScenarioKey = 'conservative' | 'base' | 'upside'
export type Renewal = { dateMs: number; amount: number; confidence: number; cycleDays: number | null }

const FACTORS: Record<ScenarioKey, {
  prob: number // added to each renewal's confidence
  retention: number // chance a client renews each further cycle
  newCash: number
  refunds: number
  sms: number
  recovery: number // share of overdue/failed payments recovered
  fixed: number
  ads: number
  variable: number
}> = {
  conservative: { prob: -0.15, retention: 0.85, newCash: 0.5, refunds: 1.5, sms: 0.85, recovery: 0.25, fixed: 1.05, ads: 1, variable: 1.2 },
  base: { prob: 0, retention: 0.93, newCash: 1, refunds: 1, sms: 1, recovery: 0.5, fixed: 1, ads: 1, variable: 1 },
  upside: { prob: 0.05, retention: 0.98, newCash: 1.3, refunds: 0.5, sms: 1.1, recovery: 0.75, fixed: 1, ads: 1.15, variable: 0.9 },
}

export type ForecastMonth = {
  month: string
  partial: boolean // current month (actuals + remainder)
  newCash: number
  backend: number
  refunds: number
  smsPayouts: number
  revenue: number
  expenses: number
  profit: number
  endingCash: number
}

export type ForecastInput = {
  now: Date
  renewals: Renewal[]
  overdue: number
  newCashAvg: number
  refundRate: number // refunds / gross
  smsRevenueAvg: number
  expenses: { recurringFixed: number; ads: number; variable: number }
  drawsAvg: number
  netPosition: number
  actual: { newCash: number; backend: number; refunds: number; expenses: number; smsReceived: number }
}

export function runScenario(key: ScenarioKey, input: ForecastInput, includeSms: boolean): ForecastMonth[] {
  const f = FACTORS[key]
  const now = input.now
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  const day = now.getUTCDate()
  const dimCur = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  const remainingFrac = (dimCur - day) / dimCur
  const monthStart = (k: number) => Date.UTC(y, m + k, 1)

  // Spread each renewal forward over its billing cycle, decaying by retention per cycle.
  const backendByMonth = [0, 0, 0, 0]
  const horizonEnd = monthStart(4)
  for (const r of input.renewals) {
    const p = Math.min(1, Math.max(0.2, r.confidence + f.prob))
    let date = r.dateMs
    let cycle = 0
    while (date < horizonEnd) {
      if (date >= now.getTime()) {
        const idx = [0, 1, 2, 3].find((k) => date >= monthStart(k) && date < monthStart(k + 1))
        if (idx !== undefined) backendByMonth[idx] += r.amount * p * Math.pow(f.retention, cycle)
      }
      if (!r.cycleDays) break
      date += r.cycleDays * 86400000
      cycle += 1
    }
  }
  // Overdue money: recovered this month if there's time left, else next month.
  backendByMonth[remainingFrac > 0.15 ? 0 : 1] += input.overdue * f.recovery

  const smsMonthly = includeSms ? coldSmsPayout(input.smsRevenueAvg * f.sms).aryan : 0
  const monthlyExp = input.expenses.recurringFixed * f.fixed + input.expenses.ads * f.ads + input.expenses.variable * f.variable

  const out: ForecastMonth[] = []
  let cash = input.netPosition
  for (let k = 0; k < 4; k++) {
    const month = new Date(monthStart(k)).toISOString().slice(0, 7)
    const frac = k === 0 ? remainingFrac : 1
    const newCashRest = input.newCashAvg * f.newCash * frac
    const backendRest = backendByMonth[k]
    const refundsRest = (newCashRest + backendRest) * input.refundRate * f.refunds
    const smsRest = k === 0 ? Math.max(0, smsMonthly - input.actual.smsReceived) : smsMonthly
    const expRest = monthlyExp * frac
    const drawsRest = input.drawsAvg * frac

    // Current month = actuals so far + projected remainder; future months = projection.
    const a = k === 0 ? input.actual : { newCash: 0, backend: 0, refunds: 0, expenses: 0, smsReceived: 0 }
    const newCash = a.newCash + newCashRest
    const backend = a.backend + backendRest
    const refunds = a.refunds + refundsRest
    const smsPayouts = (includeSms ? a.smsReceived : 0) + smsRest
    const revenue = newCash + backend - refunds + smsPayouts
    const expenses = a.expenses + expRest
    // Cash already reflects this month's actuals, so only the remainder moves it.
    cash += newCashRest + backendRest - refundsRest + smsRest - expRest - drawsRest
    out.push({
      month,
      partial: k === 0,
      newCash: Math.round(newCash),
      backend: Math.round(backend),
      refunds: Math.round(refunds),
      smsPayouts: Math.round(smsPayouts),
      revenue: Math.round(revenue),
      expenses: Math.round(expenses),
      profit: Math.round(revenue - expenses),
      endingCash: Math.round(cash),
    })
  }
  return out
}

export function runAllScenarios(input: ForecastInput, includeSms: boolean) {
  const keys: ScenarioKey[] = ['conservative', 'base', 'upside']
  const result = {} as Record<ScenarioKey, { months: ForecastMonth[]; next3: { revenue: number; expenses: number; profit: number; endingCash: number } }>
  for (const k of keys) {
    const months = runScenario(k, input, includeSms)
    const next = months.slice(1)
    result[k] = {
      months,
      next3: {
        revenue: next.reduce((s, x) => s + x.revenue, 0),
        expenses: next.reduce((s, x) => s + x.expenses, 0),
        profit: next.reduce((s, x) => s + x.profit, 0),
        endingCash: next[next.length - 1].endingCash,
      },
    }
  }
  return result
}
