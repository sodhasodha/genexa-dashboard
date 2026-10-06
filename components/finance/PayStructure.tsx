'use client'

import { useMemo, useState } from 'react'
import { BANDS, bandLabel, bandRange, coldSmsPayout, poolRule, poolRuleLabel } from '@/lib/payStructure'
import { monthLabel } from '@/lib/forecast'
import { Chip } from '@/components/finance/Chip'

type Reconcile = { month: string; sheet: number | null; commas: number; canonical: number; expenses: number; profit: number; payoutRevenue: number; payoutProfit: number; payoutBasis: string; costSource: string; estimatedCosts: { name: string; amount: number }[]; current: boolean; calcAryan: number; received: number }

// Payout for a month under the pool rule in force that month. Worked out from Jacob's sheet
// (payoutRevenue / payoutProfit), not from Commas company revenue.
const payoutFor = (r: Reconcile) => coldSmsPayout({ revenue: r.payoutRevenue, profit: r.payoutProfit }, r.month)

const fmtCurrency = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const fmtPct = (n: number) => `${n.toFixed(1)}%`

type Reason = 'matched' | 'prior-month accrual' | 'timing difference' | 'month in progress' | 'unknown'

// Why calculated vs received payout differ for one month. Payouts are paid in arrears, so a
// mismatch is usually timing, not an error. `rows` must be sorted oldest → newest.
function varianceReason(rows: Reconcile[], i: number): Reason {
  const r = rows[i]
  const calc = payoutFor(r).aryan
  const v = r.received - calc
  if (Math.abs(v) < Math.max(250, calc * 0.1)) return 'matched'
  if (r.current) return v > 0 ? 'prior-month accrual' : 'month in progress'
  const varOf = (j: number) => (rows[j] ? rows[j].received - payoutFor(rows[j]).aryan : 0)
  // A neighbouring month off by roughly the opposite amount → money landed in the other month.
  for (const j of [i - 1, i + 1]) {
    const n = varOf(j)
    if (rows[j] && Math.sign(n) === -Math.sign(v) && Math.abs(v + n) < Math.abs(v) * 0.5) return 'timing difference'
  }
  if (v > 0 && varOf(i - 1) < 0) return 'prior-month accrual'
  return 'unknown'
}

const fmtSigned = (n: number) => `${n >= 0 ? '+' : '−'}${fmtCurrency(Math.abs(n))}`

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: React.ReactNode; color?: string }) {
  return (
    <div className="rounded-lg bg-los-surface-2 px-3 py-2.5 min-w-0">
      <p className="los-label mb-1 leading-tight">{label}</p>
      <p className="font-mono font-semibold text-base truncate" style={color ? { color } : undefined}>{value}</p>
      {sub && <div className="text-[10px] text-los-text-muted mt-0.5 truncate">{sub}</div>}
    </div>
  )
}

// Cold SMS pay structure: pool = our share of profit (60% from Sep 2026, 50% before) split progressively between Aryan and Rishil (see lib/payStructure.ts).
export default function PayStructure({ reconcile, sheetUpdatedTo }: { reconcile: Reconcile[]; sheetUpdatedTo: string | null }) {
  const months = [...reconcile].reverse()
  const [month, setMonth] = useState(months[0]?.month || '')
  const [calcInput, setCalcInput] = useState('')
  const [reconOpen, setReconOpen] = useState(false)
  const row = reconcile.find((r) => r.month === month) || months[0]
  const split = useMemo(() => (row ? payoutFor(row) : coldSmsPayout({ revenue: 0, profit: 0 })), [row])
  const calcRevenue = Number(calcInput.replace(/[^0-9.]/g, '')) || 0
  // Calculator uses the current rule; its input is whatever that rule is based on (profit now).
  const rule = poolRule()
  const calc = useMemo(() => coldSmsPayout({ revenue: calcRevenue, profit: calcRevenue }), [calcRevenue])

  if (!row) return <p className="text-xs text-los-text-muted">No Cold SMS revenue yet.</p>

  const band = BANDS[split.bandIndex]
  const sorted = [...reconcile].sort((a, b) => a.month.localeCompare(b.month))
  const idx = sorted.findIndex((r) => r.month === row.month)
  const variance = row.received - split.aryan
  const reason = varianceReason(sorted, idx)

  // Collapsed reconciliation summary: closed months only (current month is still accruing).
  const closed = sorted.map((r, i) => ({ r, i })).filter(({ r }) => !r.current && r.costSource !== 'estimate')
  const estNote = (r: Reconcile) => r.estimatedCosts.map((e) => `${e.name} ~${fmtCurrency(e.amount)}`).join(', ')
  const totalVar = closed.reduce((sum, { r }) => sum + r.received - payoutFor(r).aryan, 0)
  const totalCalc = closed.reduce((sum, { r }) => sum + payoutFor(r).aryan, 0)
  const reasons = closed.map(({ i }) => varianceReason(sorted, i)).filter((x) => x !== 'matched')
  const reasonSummary = Object.entries(reasons.reduce((m: Record<string, number>, x) => ((m[x] = (m[x] || 0) + 1), m), {}))
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r}${n > 1 ? ` ×${n}` : ''}`)
    .join(' · ')
  const srcDiffMonths = closed.filter(({ r }) => r.sheet && Math.abs((r.commas - r.sheet) / r.sheet) >= 0.15).length
  const allMatched = Math.abs(totalVar) < Math.max(250, totalCalc * 0.05) && srcDiffMonths === 0

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[11px] text-los-text-muted">
          {row.payoutBasis === 'sheet'
            ? `What Jacob owes you is worked out from his sheet: sheet revenue − costs${row.current ? ' (month so far)' : ''}.`
            : 'No revenue in the sheet for this month yet, so the payout is estimated from Commas.'}{' '}
          Company revenue ({fmtCurrency(row.canonical)}) comes from Commas and is not used here.
          {row.costSource === 'estimate' ? ' Costs estimated (not in sheet yet).' : ''}
          {row.costSource === 'partial' ? ` Costs include an estimate for ${estNote(row)} until Jacob fills it in.` : ''}
          {sheetUpdatedTo ? ` · sheet updated to ${monthLabel(sheetUpdatedTo)}` : ''}
        </p>
        <select
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="bg-los-surface-2 border border-los-border rounded-md text-[11px] text-los-text px-2 py-1"
        >
          {months.map((m) => (
            <option key={m.month} value={m.month}>{monthLabel(m.month)}</option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Metrics + progress */}
        <div className="lg:col-span-2 flex flex-col gap-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label={row.payoutBasis === 'sheet' ? 'Sheet revenue' : 'Revenue (est.)'} value={fmtCurrency(row.payoutRevenue)} sub={row.payoutBasis === 'sheet' ? "Jacob's sheet · payout basis" : 'Commas until sheet updated'} />
            <Stat label="Payout pool" value={fmtCurrency(split.pool)} sub={`${poolRuleLabel(split.rule)}${split.rule.basis === 'profit' ? ` (${fmtCurrency(row.payoutProfit)})` : ''}`} />
            <Stat label="Aryan payout" value={fmtCurrency(split.aryan)} color="#f59e0b" sub="Calculated" />
            <Stat label="Rishil payout" value={fmtCurrency(split.rishil)} />
            <Stat label="Current split" value={bandLabel(band)} sub={`Aryan / Rishil · ${bandRange(band)}`} />
            <Stat label="Next Aryan threshold" value={split.nextThreshold === null ? 'Top band' : fmtCurrency(split.nextThreshold)} />
            <Stat label="Aryan income to next band" value={split.untilNextBand === null ? '—' : fmtCurrency(split.untilNextBand)} sub={split.untilNextBand === null ? '' : 'Aryan income'} />
            <Stat label="Aryan effective" value={fmtPct(split.aryanPctOfRevenue)} sub="of sheet revenue" />
          </div>

          <div className="rounded-lg bg-los-surface-2 px-3 py-2.5 flex items-center gap-x-5 gap-y-1 flex-wrap text-xs">
            <span className="text-los-text-muted">
              Calculated payout <span className="font-mono text-los-text ml-1">{fmtCurrency(split.aryan)}</span>
            </span>
            <span className="text-los-text-muted">
              Received payout <span className="font-mono text-los-text ml-1">{fmtCurrency(row.received)}</span>
            </span>
            <span className="text-los-text-muted">
              Variance{' '}
              <span className={`font-mono ml-1 ${reason === 'matched' ? 'text-los-text' : 'text-los-amber'}`}>{fmtSigned(variance)}</span>
            </span>
            {reason === 'matched' ? <Chip tone="green">Matched</Chip> : <Chip tone="amber">{reason}</Chip>}
          </div>

          <div className="rounded-lg bg-los-surface-2 px-3 py-3">
            <div className="flex items-baseline justify-between mb-2">
              <p className="los-label">Aryan income</p>
              <p className="font-mono text-xs text-los-text">
                {fmtCurrency(split.aryan)}
                {band.to !== null && <span className="text-los-text-muted"> / {fmtCurrency(band.to)}</span>}
              </p>
            </div>
            <div className="h-2 rounded-full bg-los-surface-3 overflow-hidden">
              <div className="h-full rounded-full bg-los-amber transition-all" style={{ width: `${Math.min(split.bandProgress, 1) * 100}%` }} />
            </div>
            <p className="text-[10px] text-los-text-muted mt-1.5">
              {split.untilNextBand === null
                ? `In the top band (${bandLabel(band)}) — every extra pool dollar splits ${bandLabel(band)}.`
                : `${fmtCurrency(split.untilNextBand)} until the ${bandLabel(BANDS[split.bandIndex + 1])} band · progress through ${bandRange(band)}`}
            </p>
          </div>
        </div>

        {/* Bands + calculator */}
        <div className="flex flex-col gap-3">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-los-text-muted text-left">
                <th className="font-medium py-1.5 pr-2">Aryan income band</th>
                <th className="font-medium py-1.5 px-2 text-right">Aryan</th>
                <th className="font-medium py-1.5 pl-2 text-right">Rishil</th>
              </tr>
            </thead>
            <tbody>
              {BANDS.map((b, i) => (
                <tr key={i} className={`border-t border-los-border ${i === split.bandIndex ? 'text-los-text' : 'text-los-text-secondary'}`}>
                  <td className="py-1.5 pr-2">
                    {bandRange(b)} {i === split.bandIndex && <Chip tone="amber">current</Chip>}
                  </td>
                  <td className="py-1.5 px-2 text-right font-mono">{Math.round(b.aryan * 100)}%</td>
                  <td className="py-1.5 pl-2 text-right font-mono">{Math.round(b.rishil * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="rounded-lg bg-los-surface-2 px-3 py-3">
            <p className="los-label mb-2">Payout calculator</p>
            <div className="flex items-center gap-1 bg-los-surface-3 border border-los-border rounded-md px-2 mb-2">
              <span className="text-los-text-muted text-xs">$</span>
              <input
                inputMode="decimal"
                value={calcInput}
                onChange={(e) => setCalcInput(e.target.value)}
                placeholder={`Monthly Cold SMS ${rule.basis}`}
                className="bg-transparent w-full py-1.5 text-xs text-los-text font-mono outline-none placeholder:text-los-text-muted placeholder:font-sans"
              />
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
              {[
                [rule.basis === 'profit' ? 'Cold SMS profit' : 'Total revenue', fmtCurrency(calcRevenue)],
                [`Pool · ${poolRuleLabel(rule)}`, fmtCurrency(calc.pool)],
                ['Aryan payout', fmtCurrency(calc.aryan)],
                ['Rishil payout', fmtCurrency(calc.rishil)],
                [`Aryan % of ${rule.basis}`, fmtPct(calcRevenue > 0 ? (calc.aryan / calcRevenue) * 100 : 0)],
                [`Rishil % of ${rule.basis}`, fmtPct(calcRevenue > 0 ? (calc.rishil / calcRevenue) * 100 : 0)],
                ['Aryan band', `${bandLabel(BANDS[calc.bandIndex])} · ${bandRange(BANDS[calc.bandIndex])}`],
              ].map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-los-text-muted">{k}</dt>
                  <dd className="text-right font-mono text-los-text">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </div>

      {/* Reconciliation — collapsed by default */}
      <div className="rounded-lg bg-los-surface-2">
        <button onClick={() => setReconOpen((o) => !o)} className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left flex-wrap">
          <span className="flex items-center gap-2 flex-wrap min-w-0">
            <span className="los-label">Reconciliation</span>
            <span className={allMatched ? 'text-los-green' : 'text-los-amber'}>{allMatched ? '✓' : '⚠'}</span>
            <span className="text-xs text-los-text-secondary">
              {allMatched
                ? 'All sources matched'
                : `${fmtSigned(totalVar)} payout variance${reasonSummary ? ` · ${reasonSummary}` : ''}${srcDiffMonths ? ` · sheet vs Commas differ in ${srcDiffMonths} mo` : ''}`}
            </span>
          </span>
          <span className="text-[11px] text-los-accent whitespace-nowrap">{reconOpen ? 'Hide details' : 'View details'}</span>
        </button>
        {reconOpen && (
      <div className="overflow-x-auto px-3 pb-3">
        <table className="w-full text-xs min-w-[820px]">
          <thead>
            <tr className="text-los-text-muted text-left">
              <th className="font-medium py-1.5 pr-3">Month</th>
              <th className="font-medium py-1.5 px-2 text-right">Commas revenue</th>
              <th className="font-medium py-1.5 px-2 text-right">Sheet revenue</th>
              <th className="font-medium py-1.5 px-2 text-right">Costs</th>
              <th className="font-medium py-1.5 px-2 text-right">Sheet profit</th>
              <th className="font-medium py-1.5 px-2 text-right">Pool rule</th>
              <th className="font-medium py-1.5 px-2 text-right">Aryan (calc)</th>
              <th className="font-medium py-1.5 px-2 text-right">Received</th>
              <th className="font-medium py-1.5 px-2 text-right">Variance</th>
              <th className="font-medium py-1.5 pl-2">Check</th>
            </tr>
          </thead>
          <tbody>
            {months.map((r) => {
              const calcA = payoutFor(r).aryan
              const why = varianceReason(sorted, sorted.findIndex((x) => x.month === r.month))
              const srcDiff = r.sheet ? ((r.commas - r.sheet) / r.sheet) * 100 : null
              return (
                <tr key={r.month} className="border-t border-los-border">
                  <td className="py-1.5 pr-3 text-los-text-secondary">{monthLabel(r.month)}</td>
                  <td className="py-1.5 px-2 text-right font-mono text-los-text-muted">{fmtCurrency(r.canonical)}</td>
                  <td className="py-1.5 px-2 text-right font-mono text-los-text">{r.sheet === null ? '—' : fmtCurrency(r.sheet)}</td>
                  <td className="py-1.5 px-2 text-right font-mono text-los-text-muted">{fmtCurrency(r.expenses)}</td>
                  <td className="py-1.5 px-2 text-right font-mono text-los-text">{fmtCurrency(r.payoutProfit)}</td>
                  <td className="py-1.5 px-2 text-right text-los-text-muted whitespace-nowrap">{poolRuleLabel(poolRule(r.month))}</td>
                  <td className="py-1.5 px-2 text-right font-mono text-los-text">{fmtCurrency(calcA)}</td>
                  <td className="py-1.5 px-2 text-right font-mono text-los-text">{fmtCurrency(r.received)}</td>
                  <td className={`py-1.5 px-2 text-right font-mono ${why === 'matched' ? 'text-los-text-muted' : 'text-los-amber'}`}>{fmtSigned(r.received - calcA)}</td>
                  <td className="py-1.5 pl-2">
                    <span className="inline-flex gap-1 flex-wrap">
                      {why !== 'matched' && <Chip tone="amber">{why}</Chip>}
                      {srcDiff !== null && Math.abs(srcDiff) >= 15 && <Chip tone="amber">Sources differ {Math.round(Math.abs(srcDiff))}%</Chip>}
                      {r.payoutBasis !== 'sheet' && <Chip tone="muted">Sheet revenue pending</Chip>}
                      {r.costSource === 'estimate' && <Chip tone="muted">Costs est.</Chip>}
                      {r.costSource === 'partial' && <Chip tone="muted">Est. {estNote(r)}</Chip>}
                      {srcDiff !== null && Math.abs(srcDiff) < 15 && <Chip tone="green">Matches</Chip>}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="text-[10px] text-los-text-muted mt-2">
          Aryan (calc) = your share of sheet profit (sheet revenue − costs) — the sheet is what Jacob pays on. Sheet revenue = Fanbasis withdrawals, so it trails Commas by the withdrawal lag.
          Commas revenue = company revenue (gross − refunds − fees by charge date); shown for comparison, not used for the payout.
          Received = Ray Media / FanBasis deposits in Mercury that month; payouts land the following month, so compare over several months, not one.
        </p>
      </div>
        )}
      </div>
    </div>
  )
}
