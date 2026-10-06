'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
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
type Tx = { ts: number; amount: number; name: string; category: string; key: string }
type Line = { key: string; name: string; category: string; amount: number; txs: Tx[]; control?: Row }

const fmtCurrency = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const fmtExact = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const fmtDate = (ts: number) => new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const STATUS_TONE: Record<Status, Tone> = { Normal: 'muted', Review: 'amber', Cancel: 'red' }
const NEXT: Record<Status, Status> = { Normal: 'Review', Review: 'Cancel', Cancel: 'Normal' }
const PAGE = 15

// Where the Expenses KPI comes from: every business-expense transaction in the selected period,
// grouped by merchant or category, with a total that matches the KPI. Tap a row for its transactions.
// Recurring / new / status come from the current-month controls; statuses Aryan sets
// (Normal → Review → Cancel) persist via /api/finance/overrides.
export default function ExpenseControls({ rows, txs, months, periodLabel }: { rows: Row[]; txs: Tx[]; months: string[]; periodLabel: string }) {
  const [view, setView] = useState<'merchant' | 'category'>('merchant')
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [showAll, setShowAll] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/finance/overrides')
      .then((r) => r.json())
      .then((d) => d && !d.error && setOverrides(d))
      .catch(() => {})
  }, [])
  useEffect(() => {
    setOpen(null)
    setShowAll(false)
  }, [view, periodLabel])

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

  // Transactions in the selected period (same month bucketing as the KPI).
  const inPeriod = useMemo(() => {
    const set = new Set(months)
    return txs.filter((t) => set.has(new Date(t.ts).toISOString().slice(0, 7))).sort((a, b) => b.ts - a.ts)
  }, [txs, months])
  const total = useMemo(() => inPeriod.reduce((s, t) => s + t.amount, 0), [inPeriod])

  const lines = useMemo(() => {
    const controls = Object.fromEntries(rows.map((r) => [r.key, r]))
    const by: Record<string, Line> = {}
    for (const t of inPeriod) {
      const key = view === 'merchant' ? t.key : t.category
      // Newest transaction names the merchant and its category.
      const l = (by[key] ||= { key, name: view === 'merchant' ? t.name : t.category, category: t.category, amount: 0, txs: [], control: view === 'merchant' ? controls[t.key] : undefined })
      l.amount += t.amount
      l.txs.push(t)
    }
    return Object.values(by).sort((a, b) => b.amount - a.amount)
  }, [inPeriod, rows, view])

  const shown = showAll ? lines : lines.slice(0, PAGE)
  const hidden = lines.slice(shown.length)
  const share = (n: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : '—')

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-stretch gap-2 flex-wrap">
          <div className="rounded-lg bg-los-surface-2 px-3 py-2">
            <p className="los-label mb-0.5">Total · {periodLabel}</p>
            <p className="font-mono font-semibold text-base text-los-text">
              {fmtCurrency(total)} <span className="text-los-text-muted text-xs font-normal">· {inPeriod.length} transactions</span>
            </p>
          </div>
          <div className="rounded-lg bg-los-surface-2 px-3 py-2">
            <p className="los-label mb-0.5">Potential savings</p>
            <p className="font-mono font-semibold text-base" style={{ color: savings > 0 ? '#22c55e' : undefined }}>
              {fmtCurrency(savings)} <span className="text-los-text-muted text-xs font-normal">/ month</span>
            </p>
          </div>
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
              <th className="font-medium py-1.5 px-2 text-right">{periodLabel}</th>
              <th className="font-medium py-1.5 px-2 text-right">Share</th>
              <th className="font-medium py-1.5 px-2 text-right">Txns</th>
              {view === 'merchant' && (
                <>
                  <th className="font-medium py-1.5 px-2 text-right">3-mo avg</th>
                  <th className="font-medium py-1.5 px-2">Recurring</th>
                  <th className="font-medium py-1.5 pl-2">Status</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {shown.map((l) => {
              const c = l.control
              const st = c ? statusOf(c) : null
              const isOpen = open === l.key
              return (
                <Fragment key={l.key}>
                  <tr onClick={() => setOpen(isOpen ? null : l.key)} className="border-t border-los-border align-top cursor-pointer hover:bg-los-surface-2/50 transition">
                    <td className="py-1.5 pr-3">
                      <p className="text-los-text truncate max-w-[260px]">
                        <span className="text-los-text-muted mr-1">{isOpen ? '▾' : '▸'}</span>
                        {l.name}
                      </p>
                      {view === 'merchant' && <p className="text-[10px] text-los-text-muted pl-3.5">{l.category}</p>}
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono text-los-text">{fmtCurrency(l.amount)}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-los-text-muted">{share(l.amount)}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-los-text-muted">{l.txs.length}</td>
                    {view === 'merchant' && (
                      <>
                        <td className="py-1.5 px-2 text-right font-mono text-los-text-muted">{c ? fmtCurrency(c.avg3) : '—'}</td>
                        <td className="py-1.5 px-2 text-los-text-secondary">{c ? (c.recurring ? 'Yes' : 'No') : '—'}</td>
                        <td className="py-1.5 pl-2" onClick={(e) => e.stopPropagation()}>
                          {c && st ? (
                            <span className="inline-flex flex-wrap gap-1">
                              <Chip tone={STATUS_TONE[st]} onClick={() => cycle(c)} title="Click to change: Normal → Review → Cancel">
                                {st}
                              </Chip>
                              {c.newMerchant && <Chip tone="amber">New</Chip>}
                              {c.reasons.filter((x) => !/^New/.test(x)).map((x) => (
                                <Chip key={x} tone="amber">{x}</Chip>
                              ))}
                            </span>
                          ) : (
                            <span className="text-los-text-muted">—</span>
                          )}
                        </td>
                      </>
                    )}
                  </tr>
                  {isOpen && (
                    <tr className="bg-los-surface-3">
                      <td colSpan={view === 'merchant' ? 7 : 4} className="px-3.5 py-2">
                        <table className="w-full text-[11px]">
                          <tbody>
                            {l.txs.map((t, i) => (
                              <tr key={i} className="border-t first:border-t-0 border-los-border">
                                <td className="py-1 pr-3 text-los-text-muted whitespace-nowrap w-16">{fmtDate(t.ts)}</td>
                                <td className="py-1 pr-3 text-los-text-secondary truncate max-w-[280px]">{t.name}</td>
                                <td className="py-1 pr-3 text-los-text-muted">{t.category}</td>
                                <td className={`py-1 text-right font-mono ${t.amount < 0 ? 'text-los-green' : 'text-los-text'}`}>
                                  {fmtExact(t.amount)}
                                  {t.amount < 0 ? ' refund' : ''}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
            {hidden.length > 0 && (
              <tr className="border-t border-los-border">
                <td className="py-1.5 pr-3">
                  <button onClick={() => setShowAll(true)} className="text-los-accent hover:underline">
                    + {hidden.length} more
                  </button>
                </td>
                <td className="py-1.5 px-2 text-right font-mono text-los-text-muted">{fmtCurrency(hidden.reduce((s, l) => s + l.amount, 0))}</td>
                <td className="py-1.5 px-2 text-right font-mono text-los-text-muted">{share(hidden.reduce((s, l) => s + l.amount, 0))}</td>
                <td className="py-1.5 px-2 text-right font-mono text-los-text-muted">{hidden.reduce((s, l) => s + l.txs.length, 0)}</td>
                {view === 'merchant' && <td colSpan={3} />}
              </tr>
            )}
            <tr className="border-t-2 border-los-border font-semibold">
              <td className="py-2 pr-3 text-los-text">Total · {periodLabel}</td>
              <td className="py-2 px-2 text-right font-mono text-los-text">{fmtCurrency(total)}</td>
              <td className="py-2 px-2 text-right font-mono text-los-text-muted">{total > 0 ? '100%' : '—'}</td>
              <td className="py-2 px-2 text-right font-mono text-los-text-muted">{inPeriod.length}</td>
              {view === 'merchant' && <td colSpan={3} />}
            </tr>
          </tbody>
        </table>
        {showAll && lines.length > PAGE && (
          <button onClick={() => setShowAll(false)} className="text-[11px] text-los-accent hover:underline mt-2">
            Show less
          </button>
        )}
        {!lines.length && <p className="text-xs text-los-text-muted py-3">No business expenses in this period.</p>}
      </div>
      <p className="text-[10px] text-los-text-muted">
        Follows the period selector and adds up to the Expenses KPI. Tap a row for its transactions; refunds show as negatives. Recurring = billed in 2 of the last 3 months. 3-mo avg, recurring
        and status are as of this month. Click a status to mark Review or Cancel. Savings = cancelled costs + non-ad spend above the 3-mo average on items under review.
      </p>
    </div>
  )
}
