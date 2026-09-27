'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { BarChart } from '@/components/Charts'
import { Chip, Tone } from '@/components/finance/Chip'
import type { Performance, ToolboxClient, ToolboxSummary, WindowKey } from '@/lib/toolbox/clients'

type Response = {
  window: { key: WindowKey; start: string; end: string; days: number }
  summary: ToolboxSummary
  clients: ToolboxClient[]
  eodDates: { first: string | null; last: string | null; count: number }
  eod: { files: number; failed: number; lastPostedAt: number | null }
  errors: string[]
  generatedAt: string
}

const WINDOWS: { key: WindowKey; label: string }[] = [
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'mtd', label: 'Month to date' },
]
const FILTERS = ['active', 'paused', 'churned', 'all'] as const
type Filter = (typeof FILTERS)[number]

const PERF: Record<Performance, { tone: Tone; label: string; rank: number }> = {
  not_performing: { tone: 'red', label: 'Not performing', rank: 0 },
  borderline: { tone: 'amber', label: 'Borderline', rank: 1 },
  performing: { tone: 'green', label: 'Performing', rank: 2 },
  no_data: { tone: 'muted', label: 'No data', rank: 3 },
}

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const k = (n: number) => (Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${Math.round(n)}`)
const shortDate = (d: string | null) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—')

type SortKey = 'risk' | 'name' | 'mrr' | 'leads' | 'lpd' | 'roi' | 'lastSent'
const sortVal = (c: ToolboxClient, key: SortKey): number | string => {
  if (key === 'name') return c.name.toLowerCase()
  if (key === 'mrr') return c.mrr
  if (key === 'leads') return c.leads
  if (key === 'lpd') return c.leadsPerDay ?? -1
  if (key === 'roi') return c.roi ?? -1
  if (key === 'lastSent') return c.lastSent ?? ''
  // risk: high risk first, then worst performance, then most major flags
  return -(c.highRisk ? 100 : 0) - (3 - PERF[c.performance].rank) * 10 - c.flags.filter((f) => f.level === 'major').length
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="los-card p-4 min-w-0">
      <p className="los-label">{label}</p>
      <p className="los-metric-number mt-1 truncate" style={color ? { color } : undefined}>
        {value}
      </p>
      {sub && <p className="text-[11px] text-los-text-muted mt-1 truncate">{sub}</p>}
    </div>
  )
}

function Mini({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-los-surface-2 px-3 py-2 min-w-0">
      <p className="los-label leading-tight">{label}</p>
      <p className="font-mono text-sm font-semibold text-los-text truncate">{value}</p>
      {sub && <p className="text-[10px] text-los-text-muted truncate">{sub}</p>}
    </div>
  )
}

// Weekly leads across the client's whole EOD history.
function weekly(c: ToolboxClient) {
  const weeks = new Map<string, number>()
  for (const d of c.history) {
    const t = new Date(`${d.date}T12:00:00Z`)
    t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)) // Monday
    const key = t.toISOString().slice(0, 10)
    weeks.set(key, (weeks.get(key) || 0) + d.leads)
  }
  return Array.from(weeks.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([w, v]) => ({ label: shortDate(w), value: v }))
}

function Detail({ c }: { c: ToolboxClient }) {
  const wk = weekly(c)
  return (
    <div className="flex flex-col gap-4 py-3 px-1">
      {c.flags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {c.flags.map((f) => (
            <Chip key={f.text} tone={f.level === 'major' ? 'red' : 'amber'}>
              {f.text}
            </Chip>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
        <Mini label="Niche" value={c.niches.join(', ') || 'Unknown'} sub={`Medium job ${money(c.jobValue)}`} />
        <Mini label="Billing" value={c.charge ? `${money(c.charge)} ${c.cadence ?? ''}` : 'Not in Commas'} sub={[c.priceText && `Sheet: ${c.priceText}`, c.billingName].filter(Boolean).join(' · ') || undefined} />
        <Mini label="MRR" value={money(c.mrr)} sub={c.status === 'churned' ? 'Churned' : `Next due ${shortDate(c.nextDue)}`} />
        <Mini label="Lifetime paid" value={money(c.lifetimePaid)} sub={`Since ${shortDate(c.firstPaid)}`} />
        <Mini label="Delivered" value={c.delivered === null ? '—' : `${c.delivered.toFixed(0)}%`} sub={`${c.sms.toLocaleString()} SMS in window`} />
        <Mini label="Lead trend" value={c.trend === null ? '—' : `${c.trend >= 0 ? '+' : ''}${Math.round(c.trend * 100)}%`} sub="Last 7d vs prior 21d" />
      </div>

      <div className="rounded-lg bg-los-surface-2 px-3 py-2.5 text-xs text-los-text-secondary">
        <span className="los-label mr-2">Revenue estimate</span>
        {c.estJobsMonth === null ? (
          'No EOD results in this window.'
        ) : (
          <>
            ~{((c.estJobsMonth ?? 0) * 10).toFixed(0)} leads/mo → ~{(c.estJobsMonth ?? 0).toFixed(1)} jobs/mo (1 in 10) × {money(c.jobValue)} ≈{' '}
            <span className="text-los-text font-mono">{money(c.estRevenueMonth ?? 0)}/mo</span> for the client
            {c.mrr > 0 && (
              <>
                {' '}
                vs <span className="font-mono">{money(c.mrr)}/mo</span> paid →{' '}
                <span className={`font-mono ${c.performance === 'performing' ? 'text-los-green' : c.performance === 'borderline' ? 'text-los-amber' : 'text-los-red'}`}>
                  {c.roi?.toFixed(1)}x ROI
                </span>
                {c.cpl !== null && <> · they pay ~{money(c.cpl)}/lead</>}
              </>
            )}
          </>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <p className="los-label mb-2">Leads per week (all history)</p>
          {wk.length ? <BarChart data={wk} height={150} format={(v) => String(Math.round(v))} color="#22c55e" /> : <p className="text-xs text-los-text-muted">No EOD rows yet</p>}
        </div>
        <div className="flex flex-col gap-2 text-[11px]">
          <p className="los-label">Payments (latest)</p>
          {c.payments.length ? (
            c.payments
              .slice(-8)
              .reverse()
              .map((p, i) => (
                <div key={i} className="flex justify-between gap-2 border-b border-los-border pb-1">
                  <span className="text-los-text-secondary">{shortDate(p.date)}</span>
                  <span className="text-los-text-muted truncate">{p.product}</span>
                  <span className="font-mono text-los-text">{money(p.amount)}</span>
                </div>
              ))
          ) : (
            <p className="text-los-text-muted">No payments matched in Commas</p>
          )}
          {c.accounts.length > 1 && (
            <p className="text-los-text-muted mt-1">
              Sheet rows: {c.accounts.slice(0, 6).join(' · ')}
              {c.accounts.length > 6 ? ` +${c.accounts.length - 6}` : ''}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

export default function ToolboxClientsPage() {
  const [win, setWin] = useState<WindowKey>('7d')
  const [filter, setFilter] = useState<Filter>('active')
  const [data, setData] = useState<Response | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sync, setSync] = useState<string | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'risk', dir: 1 })
  const [open, setOpen] = useState<string | null>(null)

  const load = async (w: WindowKey) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/toolbox/clients?window=${w}`)
      const json = await res.json()
      if (!res.ok || json.error) throw new Error(json.error || res.statusText)
      setData(json)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load(win)
  }, [win])
  // Pull any new EOD screenshots in the background; reload if something was imported.
  useEffect(() => {
    fetch('/api/toolbox/sync', { method: 'POST' })
      .then((r) => r.json())
      .then((j) => {
        setSync(j.error ?? null)
        if (j.processed?.some((p: any) => !p.error)) load(win)
      })
      .catch(() => {})
  }, [])

  const clients = useMemo(() => {
    if (!data) return []
    const inTab = (c: ToolboxClient) =>
      filter === 'all' ? true : filter === 'active' ? c.status === 'active' || c.status === 'no_billing' : filter === 'paused' ? c.status === 'paused' : c.status === 'churned' || c.status === 'failed_pay'
    const list = data.clients.filter(inTab)
    return [...list].sort((a, b) => {
      const x = sortVal(a, sort.key)
      const y = sortVal(b, sort.key)
      const cmp = typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number)
      // numbers: dir 1 = high first (except risk, which is already "worst = smallest")
      return sort.key === 'risk' || sort.key === 'name' ? cmp * sort.dir : -cmp * sort.dir
    })
  }, [data, filter, sort])
  const clickSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }))
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === 1 ? ' ↓' : ' ↑') : '')
  const s = data?.summary
  const th = 'font-medium py-2 px-2 cursor-pointer select-none whitespace-nowrap'

  return (
    <div className="px-4 sm:px-6 py-5 max-w-[1400px] mx-auto flex flex-col gap-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-los-text tracking-tight">Toolbox Clients</h1>
          <p className="text-xs text-los-text-muted mt-0.5">
            Cold SMS · Retainer Clients sheet · Commas billing · SMS sender EODs
            {data?.eodDates.last ? ` (latest ${shortDate(data.eodDates.last)}, ${data.eodDates.count} days)` : ''}
            {data?.generatedAt ? ` · updated ${new Date(data.generatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}
          </p>
        </div>
        <button onClick={() => load(win)} disabled={loading} className="los-btn los-btn-ghost">
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-0.5 bg-los-surface-2 rounded-lg p-0.5 max-w-full overflow-x-auto">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              onClick={() => setWin(w.key)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition ${win === w.key ? 'bg-los-accent text-white' : 'text-los-text-muted hover:text-los-text'}`}
            >
              {w.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0.5 bg-los-surface-2 rounded-lg p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium capitalize transition ${filter === f ? 'bg-los-accent text-white' : 'text-los-text-muted hover:text-los-text'}`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="los-card p-3 text-xs text-los-red">Couldn&apos;t load Toolbox clients: {error}</div>}
      {data?.errors?.map((e) => (
        <div key={e} className="los-card p-3 text-xs text-los-red">
          {e}
        </div>
      ))}
      {sync && <div className="los-card p-3 text-xs text-los-amber">EOD screenshots not being read: {sync} — using the Retainer Clients sheet&apos;s nightly numbers meanwhile.</div>}
      {!data && loading && <div className="los-card p-8 text-center text-xs text-los-text-muted">Loading Toolbox clients…</div>}

      {data && s && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
            <Stat label="Active clients" value={String(s.active)} sub={`${s.byCadence.daily} daily · ${s.byCadence.weekly} weekly · ${s.byCadence.monthly} monthly`} />
            <Stat label="MRR" value={money(s.mrr)} sub="Active clients, billing run-rate" color="#22c55e" />
            <Stat label="Leads" value={s.leads.toLocaleString()} sub={`${WINDOWS.find((w) => w.key === win)?.label.toLowerCase()}`} />
            <Stat label="Performing" value={`${s.performing} of ${s.active}`} sub={`${s.notPerforming} not performing`} color={s.notPerforming ? '#f59e0b' : '#22c55e'} />
            <Stat label="High risk" value={String(s.highRisk)} sub={`${s.paused} paused · ${s.failedPay} failed pay`} color={s.highRisk ? '#ef4444' : '#22c55e'} />
            <Stat label="Client revenue (est.)" value={k(s.estRevenueMonth)} sub="Per month, 1 in 10 leads = medium job" />
          </div>

          <div className="los-card p-0 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-[1100px]">
                <thead>
                  <tr className="text-los-text-muted text-left border-b border-los-border">
                    <th className={`${th} sticky left-0 z-10 bg-los-surface pl-4`} onClick={() => clickSort('name')}>
                      Client{arrow('name')}
                    </th>
                    <th className="font-medium py-2 px-2">Niche</th>
                    <th className="font-medium py-2 px-2">Billing</th>
                    <th className={th} onClick={() => clickSort('mrr')}>
                      MRR{arrow('mrr')}
                    </th>
                    <th className={th} onClick={() => clickSort('leads')}>
                      Leads{arrow('leads')}
                    </th>
                    <th className={th} onClick={() => clickSort('lpd')}>
                      Leads/day{arrow('lpd')}
                    </th>
                    <th className={th} onClick={() => clickSort('roi')}>
                      Est. ROI{arrow('roi')}
                    </th>
                    <th className={th} onClick={() => clickSort('risk')}>
                      Performance / risk{arrow('risk')}
                    </th>
                    <th className={th} onClick={() => clickSort('lastSent')}>
                      Last sent{arrow('lastSent')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((c) => (
                    <Fragment key={c.key}>
                      <tr onClick={() => setOpen(open === c.key ? null : c.key)} className="border-t border-los-border cursor-pointer hover:bg-los-surface-2/50 transition align-top">
                        <td className="sticky left-0 z-10 bg-los-surface py-2 pl-4 pr-2 min-w-[160px] max-w-[220px]">
                          <p className="text-los-text font-medium leading-tight">
                            <span className="text-los-text-muted mr-1">{open === c.key ? '▾' : '▸'}</span>
                            {c.name}
                          </p>
                          <p className="text-[10px] mt-0.5">
                            {c.status === 'active' ? (
                              <span className="text-los-green">Active</span>
                            ) : c.status === 'paused' ? (
                              <span className="text-los-amber">Paused</span>
                            ) : c.status === 'failed_pay' ? (
                              <span className="text-los-red">Failed pay</span>
                            ) : c.status === 'churned' ? (
                              <span className="text-los-text-muted">{c.rosterStatus ? c.rosterStatus.toLowerCase().replace(/^\w/, (x) => x.toUpperCase()) : `Churned ${c.nextDue ? shortDate(c.nextDue) : ''}`}</span>
                            ) : (
                              <span className="text-los-amber">No billing match</span>
                            )}
                          </p>
                        </td>
                        <td className="py-2 px-2 text-los-text-secondary">{c.niches.slice(0, 2).join(', ') || '—'}</td>
                        <td className="py-2 px-2 whitespace-nowrap">
                          {c.charge ? (
                            <>
                              <span className="font-mono text-los-text">{money(c.charge)}</span>
                              <span className="text-los-text-muted"> / {c.cadence === 'daily' ? 'day' : c.cadence === 'weekly' ? 'wk' : 'mo'}</span>
                              {c.daysOverdue > 0 && c.status === 'active' && <p className="text-[10px] text-los-red">{c.daysOverdue}d overdue</p>}
                            </>
                          ) : (
                            <span className="text-los-text-muted">—</span>
                          )}
                        </td>
                        <td className="py-2 px-2 font-mono text-los-text">{c.mrr ? money(c.mrr) : '—'}</td>
                        <td className="py-2 px-2 font-mono text-los-text">{c.leads || (c.sendDays ? 0 : '—')}</td>
                        <td className="py-2 px-2 font-mono text-los-text">
                          {c.leadsPerDay === null ? '—' : c.leadsPerDay.toFixed(1)}
                          {c.trend !== null && Math.abs(c.trend) >= 0.1 && (
                            <span className={`ml-1 text-[10px] ${c.trend > 0 ? 'text-los-green' : 'text-los-red'}`}>
                              {c.trend > 0 ? '▲' : '▼'}
                              {Math.round(Math.abs(c.trend) * 100)}%
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-2 font-mono text-los-text">{c.roi === null ? '—' : `${c.roi.toFixed(1)}x`}</td>
                        <td className="py-2 px-2">
                          <span className="inline-flex flex-wrap gap-1">
                            <Chip tone={PERF[c.performance].tone}>{PERF[c.performance].label}</Chip>
                            {(c.status === 'active' || c.status === 'no_billing') && (c.highRisk ? <Chip tone="red">High risk</Chip> : <Chip tone="green">Low risk</Chip>)}
                          </span>
                          {c.flags[0] && <p className="text-[10px] text-los-text-muted mt-0.5 truncate max-w-[220px]">{c.flags.map((f) => f.text).join(' · ')}</p>}
                        </td>
                        <td className="py-2 px-2 text-los-text-secondary whitespace-nowrap">{shortDate(c.lastSent)}</td>
                      </tr>
                      {open === c.key && (
                        <tr className="bg-los-surface-3">
                          <td colSpan={9} className="px-4">
                            <div className="sticky left-4 w-[calc(100vw-4.5rem)] md:w-[calc(100vw-14rem-5.5rem)] max-w-[1300px]">
                              <Detail c={c} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="text-[10px] text-los-text-muted">
            Est. ROI = (monthly leads × 1 in 10 × medium job value for the niche) ÷ what they pay per month. Performing ≥5x, borderline 3–5x. High risk = payment overdue, not in recent
            EODs, leads down ≥50%, ROI under 3x, or two smaller warnings. Job values and thresholds live in lib/toolbox/config.ts.
          </p>
        </>
      )}
    </div>
  )
}
