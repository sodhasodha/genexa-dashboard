'use client'

import { useState } from 'react'
import { monthLabel } from '@/lib/forecast'

type ScenarioKey = 'conservative' | 'base' | 'upside'
type Month = { month: string; partial: boolean; revenue: number; expenses: number; profit: number; endingCash: number }
type Scenario = { months: Month[]; next3: { revenue: number; expenses: number; profit: number; endingCash: number } }

const fmtK = (n: number) => (Math.abs(n) >= 1000 ? `${n < 0 ? '-' : ''}$${(Math.abs(n) / 1000).toFixed(1)}k` : `$${Math.round(n)}`)
const KEYS: { key: ScenarioKey; label: string }[] = [
  { key: 'conservative', label: 'Conservative' },
  { key: 'base', label: 'Base' },
  { key: 'upside', label: 'Upside' },
]

// Compact 3-scenario forecast: next-3-month totals per scenario, then the monthly path of the selected one.
export default function ForecastScenarios({ scenarios, drivers, cashNote }: { scenarios: Record<ScenarioKey, Scenario>; drivers?: any; cashNote?: string }) {
  const [sel, setSel] = useState<ScenarioKey>('base')
  const rows: { label: string; k: keyof Scenario['next3']; color?: string }[] = [
    { label: 'Revenue', k: 'revenue' },
    { label: 'Expenses', k: 'expenses' },
    { label: 'Profit', k: 'profit', color: '#22c55e' },
    { label: 'Ending cash', k: 'endingCash', color: '#3b82f6' },
  ]
  const months = scenarios[sel].months

  return (
    <div className="flex flex-col gap-4">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-los-text-muted">
            <th className="font-medium py-1.5 pr-2 text-left">Next 3 mo</th>
            {KEYS.map((s) => (
              <th key={s.key} className="py-1 px-1 text-right">
                <button
                  onClick={() => setSel(s.key)}
                  className={`px-1.5 py-0.5 rounded text-[11px] font-medium transition ${sel === s.key ? 'bg-los-accent text-white' : 'text-los-text-muted hover:text-los-text'}`}
                >
                  {s.label}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.k} className="border-t border-los-border">
              <td className="py-1.5 pr-2 text-los-text-secondary">{r.label}</td>
              {KEYS.map((s) => {
                const v = scenarios[s.key].next3[r.k]
                return (
                  <td
                    key={s.key}
                    className={`py-1.5 px-1 text-right font-mono ${sel === s.key ? 'text-los-text' : 'text-los-text-muted'}`}
                    style={sel === s.key && r.color ? { color: v < 0 ? '#ef4444' : r.color } : undefined}
                  >
                    {fmtK(v)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <table className="w-full text-xs">
        <thead>
          <tr className="text-los-text-muted text-left">
            <th className="font-medium py-1 pr-2">{KEYS.find((k) => k.key === sel)!.label}</th>
            <th className="font-medium py-1 px-1 text-right">Rev</th>
            <th className="font-medium py-1 px-1 text-right">Exp</th>
            <th className="font-medium py-1 px-1 text-right">Profit</th>
            <th className="font-medium py-1 pl-1 text-right">Cash</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m) => (
            <tr key={m.month} className="border-t border-los-border">
              <td className="py-1.5 pr-2 text-los-text-secondary">{monthLabel(m.month)}{m.partial ? '*' : ''}</td>
              <td className="py-1.5 px-1 text-right font-mono text-los-text">{fmtK(m.revenue)}</td>
              <td className="py-1.5 px-1 text-right font-mono text-los-text-muted">{fmtK(m.expenses)}</td>
              <td className={`py-1.5 px-1 text-right font-mono ${m.profit >= 0 ? 'text-los-green' : 'text-los-red'}`}>{fmtK(m.profit)}</td>
              <td className="py-1.5 pl-1 text-right font-mono text-los-text">{fmtK(m.endingCash)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="text-[10px] text-los-text-muted leading-relaxed">
        * actuals to date + projected remainder.
        {drivers && (
          <>
            {' '}Built from {fmtK(drivers.recurringRevenue)}/mo contracted renewals (Whop + Monday), {fmtK(drivers.newCashAvg)}/mo new cash, {drivers.refundRate}% refund rate;
            costs {fmtK(drivers.recurringFixed)} recurring + {fmtK(drivers.ads)} ads + {fmtK(drivers.variable)} variable. Cash starts at {fmtK(drivers.netPosition)} (after card balance) less {fmtK(drivers.drawsAvg)}/mo draws.
          </>
        )}
        {cashNote ? ` ${cashNote}` : ''}
      </p>
    </div>
  )
}
