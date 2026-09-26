'use client'

import { useState } from 'react'
import { Chip, Tone } from '@/components/finance/Chip'

type Item = {
  id: string
  customer: string
  business: string
  source: string
  amount: number
  date: string
  type: string
  confidence: number
  status: 'Expected' | 'Due soon' | 'Overdue' | 'At risk' | 'Paid'
  daysOverdue: number
  flags: string[]
  url?: string | null
}

const fmtCurrency = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const STATUS_TONE: Record<Item['status'], Tone> = { 'At risk': 'red', Overdue: 'red', 'Due soon': 'amber', Expected: 'muted', Paid: 'green' }
const FLAG_TONE = (f: string): Tone => (/failed|cancel/i.test(f) ? 'red' : 'amber')
const PAGE = 5

// Compact receivables: 4 headline numbers, then individual expected payments.
export default function ExpectedMoney({ items, filter }: { items: Item[]; filter?: (i: Item) => boolean }) {
  const [showAll, setShowAll] = useState(false)
  const list = filter ? items.filter(filter) : items
  const open = list.filter((i) => i.status !== 'Paid')
  const sum = (xs: Item[]) => xs.reduce((s, i) => s + i.amount, 0)
  const stats = [
    { label: 'Expected next 30 days', value: sum(open), color: undefined },
    { label: 'High confidence', value: sum(open.filter((i) => i.confidence >= 0.8 && (i.status === 'Expected' || i.status === 'Due soon'))), color: '#22c55e' },
    { label: 'Overdue', value: sum(open.filter((i) => i.status === 'Overdue')), color: '#f59e0b' },
    { label: 'At risk', value: sum(open.filter((i) => i.status === 'At risk')), color: '#ef4444' },
  ]
  // Most important first: at risk, overdue, then nearest due; paid last.
  const RANK: Record<Item['status'], number> = { 'At risk': 0, Overdue: 1, 'Due soon': 2, Expected: 3, Paid: 4 }
  const ordered = [...list].sort((a, b) => RANK[a.status] - RANK[b.status] || a.date.localeCompare(b.date))
  const shown = showAll ? ordered : ordered.slice(0, PAGE)
  const open_ = (i: Item) => i.url && window.open(i.url, '_blank', 'noopener,noreferrer')

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {stats.map((s) => (
          <div key={s.label} className="rounded-lg bg-los-surface-2 px-3 py-2.5">
            <p className="los-label mb-1 truncate">{s.label}</p>
            <p className="font-mono font-semibold text-base" style={{ color: s.value > 0 ? s.color : undefined }}>{fmtCurrency(s.value)}</p>
          </div>
        ))}
      </div>
      {list.length === 0 ? (
        <p className="text-xs text-los-text-muted">Nothing expected in the next 30 days.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[620px]">
            <thead>
              <tr className="text-los-text-muted text-left">
                <th className="font-medium py-1.5 pr-3">Client</th>
                <th className="font-medium py-1.5 px-2 text-right">Amount</th>
                <th className="font-medium py-1.5 px-2">Expected</th>
                <th className="font-medium py-1.5 px-2">Type</th>
                <th className="font-medium py-1.5 px-2 text-right">Conf.</th>
                <th className="font-medium py-1.5 pl-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((i) => (
                <tr
                  key={i.id}
                  onClick={() => open_(i)}
                  title={i.url ? 'Open client record' : undefined}
                  className={`border-t border-los-border align-top ${i.url ? 'cursor-pointer hover:bg-los-surface-2 transition' : ''}`}
                >
                  <td className="py-1.5 pr-3">
                    <p className="text-los-text truncate max-w-[200px]">
                      {i.customer}
                      {i.url && <span className="text-los-text-muted ml-1">↗</span>}
                    </p>
                    <p className="text-[10px] text-los-text-muted">{i.business} · {i.source}</p>
                  </td>
                  <td className={`py-1.5 px-2 text-right font-mono ${i.status === 'Paid' ? 'text-los-text-muted' : 'text-los-text'}`}>{fmtCurrency(i.amount)}</td>
                  <td className="py-1.5 px-2 text-los-text-secondary whitespace-nowrap">
                    {new Date(`${i.date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}
                  </td>
                  <td className="py-1.5 px-2 text-los-text-secondary whitespace-nowrap">{i.type}</td>
                  <td className="py-1.5 px-2 text-right font-mono text-los-text-muted">{Math.round(i.confidence * 100)}%</td>
                  <td className="py-1.5 pl-2">
                    <span className="inline-flex flex-wrap gap-1">
                      <Chip tone={STATUS_TONE[i.status]}>
                        {i.status}
                        {i.daysOverdue > 0 ? ` · ${i.daysOverdue}d` : ''}
                      </Chip>
                      {i.flags.map((f) => (
                        <Chip key={f} tone={FLAG_TONE(f)}>{f}</Chip>
                      ))}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.length > PAGE && (
            <button onClick={() => setShowAll((v) => !v)} className="text-[11px] text-los-accent hover:underline mt-2">
              {showAll ? 'Show less' : `Show all ${list.length} payments`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
