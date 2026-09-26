'use client'

import { useEffect, useMemo, useState } from 'react'
import { Chip, Tone } from '@/components/finance/Chip'

type Status = 'Normal' | 'Review' | 'Cancel'
type Row = {
  key: string
  name: string
  category: string
  thisMonth: number
  pace: number
  avg3: number
  changePct: number | null
  recurring: boolean
  newMerchant: boolean
  autoStatus: Status
  reasons: string[]
}

const fmtCurrency = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const STATUS_TONE: Record<Status, Tone> = { Normal: 'muted', Review: 'amber', Cancel: 'red' }
const NEXT: Record<Status, Status> = { Normal: 'Review', Review: 'Cancel', Cancel: 'Normal' }
const PAGE = 10

// Actionable expenses: merchant/category rows with change, recurring, new-merchant flags and a
// status Aryan can cycle (Normal → Review → Cancel). Manual statuses persist via /api/finance/overrides.
export default function ExpenseControls({ rows }: { rows: Row[] }) {
  const [view, setView] = useState<'merchant' | 'category'>('merchant')
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    fetch('/api/finance/overrides')
      .then((r) => r.json())
      .then((d) => d && !d.error && setOverrides(d))
      .catch(() => {})
  }, [])

  const statusOf = (r: Row): Status => (overrides[`expense:${r.key}`] as Status) || r.autoStatus
  const cycle = (r: Row) => {
    const next = NEXT[statusOf(r)]
    const key = `expense:${r.key}`
    // Setting it back to the automatic status clears the override.
    const value = next === r.autoStatus ? '' : next
    setOverrides((o) => {
      const copy = { ...o }
      if (value) copy[key] = value
      else delete copy[key]
      return copy
    })
    fetch('/api/finance/overrides', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value }) }).catch(() => {})
  }

  const savings = useMemo(
    () =>
      rows.reduce((s, r) => {
        const st = statusOf(r)
        if (st === 'Cancel') return s + Math.max(r.avg3, r.pace)
        // Ad increases are deliberate scaling — reviewed, but not counted as savings.
        if (st === 'Review' && !/advertis|marketing/i.test(r.category)) return s + Math.max(0, r.pace - r.avg3)
        return s
      }, 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, overrides]
  )

  const categoryRows = useMemo(() => {
    const by: Record<string, { thisMonth: number; pace: number; avg3: number; recurringSpend: number; total: number; review: number; cancel: number; newCount: number }> = {}
    for (const r of rows) {
      const c = (by[r.category] ||= { thisMonth: 0, pace: 0, avg3: 0, recurringSpend: 0, total: 0, review: 0, cancel: 0, newCount: 0 })
      c.thisMonth += r.thisMonth
      c.pace += r.pace
      c.avg3 += r.avg3
      c.total += Math.max(r.pace, r.avg3)
      if (r.recurring) c.recurringSpend += Math.max(r.pace, r.avg3)
      if (r.newMerchant) c.newCount += 1
      const st = statusOf(r)
      if (st === 'Review') c.review += 1
      if (st === 'Cancel') c.cancel += 1
    }
    return Object.entries(by)
      .map(([category, c]) => ({ category, ...c, changePct: c.avg3 > 0 ? Math.round(((c.pace - c.avg3) / c.avg3) * 100) : null }))
      .sort((a, b) => b.total - a.total)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, overrides])

  const changeChip = (pct: number | null) => {
    if (pct === null) return <span className="text-los-text-muted">new</span>
    const tone: Tone = pct >= 150 ? 'red' : pct >= 50 ? 'amber' : pct <= -30 ? 'green' : 'muted'
    return tone === 'muted' ? (
      <span className="font-mono text-los-text-muted">{pct > 0 ? '+' : ''}{pct}%</span>
    ) : (
      <Chip tone={tone}>{pct > 0 ? '+' : ''}{pct}%</Chip>
    )
  }

  const list = view === 'merchant' ? rows : categoryRows
  const shown = showAll ? list : list.slice(0, PAGE)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="rounded-lg bg-los-surface-2 px-3 py-2">
          <p className="los-label mb-0.5">Potential savings</p>
          <p className="font-mono font-semibold text-base" style={{ color: savings > 0 ? '#22c55e' : undefined }}>
            {fmtCurrency(savings)} <span className="text-los-text-muted text-xs font-normal">/ month</span>
          </p>
        </div>
        <div className="flex items-center gap-0.5 bg-los-surface-2 rounded-lg p-0.5">
          {(['merchant', 'category'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-2 py-1 rounded-md text-[11px] font-medium transition ${view === v ? 'bg-los-accent text-white' : 'text-los-text-muted hover:text-los-text'}`}
            >
              By {v}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs min-w-[640px]">
          <thead>
            <tr className="text-los-text-muted text-left">
              <th className="font-medium py-1.5 pr-3">{view === 'merchant' ? 'Merchant' : 'Category'}</th>
              <th className="font-medium py-1.5 px-2 text-right">This month</th>
              <th className="font-medium py-1.5 px-2 text-right">3-mo avg</th>
              <th className="font-medium py-1.5 px-2 text-right">Change</th>
              <th className="font-medium py-1.5 px-2">Recurring</th>
              <th className="font-medium py-1.5 px-2">New</th>
              <th className="font-medium py-1.5 pl-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {view === 'merchant'
              ? (shown as Row[]).map((r) => {
                  const st = statusOf(r)
                  return (
                    <tr key={r.key} className="border-t border-los-border align-top">
                      <td className="py-1.5 pr-3">
                        <p className="text-los-text truncate max-w-[220px]">{r.name}</p>
                        <p className="text-[10px] text-los-text-muted">{r.category}</p>
                      </td>
                      <td className="py-1.5 px-2 text-right font-mono text-los-text">{fmtCurrency(r.thisMonth)}</td>
                      <td className="py-1.5 px-2 text-right font-mono text-los-text-muted">{fmtCurrency(r.avg3)}</td>
                      <td className="py-1.5 px-2 text-right">{changeChip(r.changePct)}</td>
                      <td className="py-1.5 px-2 text-los-text-secondary">{r.recurring ? 'Yes' : 'No'}</td>
                      <td className="py-1.5 px-2 text-los-text-secondary">{r.newMerchant ? 'Yes' : '—'}</td>
                      <td className="py-1.5 pl-2">
                        <span className="inline-flex flex-wrap gap-1">
                          <Chip tone={STATUS_TONE[st]} onClick={() => cycle(r)} title="Click to change: Normal → Review → Cancel">
                            {st}
                          </Chip>
                          {r.reasons.filter((x) => !/vs normal/.test(x)).map((x) => (
                            <Chip key={x} tone="amber">{x}</Chip>
                          ))}
                        </span>
                      </td>
                    </tr>
                  )
                })
              : (shown as typeof categoryRows).map((c) => (
                  <tr key={c.category} className="border-t border-los-border">
                    <td className="py-1.5 pr-3 text-los-text">{c.category}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-los-text">{fmtCurrency(c.thisMonth)}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-los-text-muted">{fmtCurrency(c.avg3)}</td>
                    <td className="py-1.5 px-2 text-right">{changeChip(c.changePct)}</td>
                    <td className="py-1.5 px-2 text-los-text-secondary">{c.total > 0 ? `${Math.round((c.recurringSpend / c.total) * 100)}%` : '—'}</td>
                    <td className="py-1.5 px-2 text-los-text-secondary">{c.newCount || '—'}</td>
                    <td className="py-1.5 pl-2">
                      <span className="inline-flex gap-1">
                        {c.cancel > 0 && <Chip tone="red">{c.cancel} cancel</Chip>}
                        {c.review > 0 && <Chip tone="amber">{c.review} review</Chip>}
                        {!c.cancel && !c.review && <Chip tone="muted">Normal</Chip>}
                      </span>
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
        {list.length > PAGE && (
          <button onClick={() => setShowAll((v) => !v)} className="text-[11px] text-los-accent hover:underline mt-2">
            {showAll ? 'Show less' : `Show all ${list.length}`}
          </button>
        )}
      </div>
      <p className="text-[10px] text-los-text-muted">
        Recurring = billed in 2 of the last 3 months. Click a status to mark Review or Cancel. Savings = cancelled costs + non-ad spend above the 3-mo average on items under review.
      </p>
    </div>
  )
}
