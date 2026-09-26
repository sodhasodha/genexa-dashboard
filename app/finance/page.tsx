'use client'

import { useEffect, useMemo, useState } from 'react'
import { LineChart, MultiLineChart, StackedForecast, TrendPill } from '@/components/Charts'
import MercuryLive from '@/components/MercuryLive'
import { linearForecast, monthLabel, nextMonths, paceProjection } from '@/lib/forecast'

const fmtCurrency = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const fmtK = (n: number) => (Math.abs(n) >= 1000 ? `${n < 0 ? '-' : ''}$${(Math.abs(n) / 1000).toFixed(1)}k` : `$${n.toFixed(0)}`)
const fmtPct = (n: number) => `${n.toFixed(0)}%`

const C = {
  newCash: '#3b82f6',
  backend: '#22c55e',
  sms: '#f59e0b',
  profit: '#e5e7eb',
  expenses: '#ef4444',
  margin: '#8b5cf6',
  clients: '#06b6d4',
}

type Tab = 'total' | 'genexa' | 'sms' | 'mercury'
type Period = 'mtd' | 'last' | 'q' | 'ytd'
const TABS: { key: Tab; label: string }[] = [
  { key: 'total', label: 'Everything' },
  { key: 'genexa', label: 'Genexa Scaling' },
  { key: 'sms', label: 'Cold SMS' },
  { key: 'mercury', label: 'Mercury Live' },
]
const PERIODS: { key: Period; label: string }[] = [
  { key: 'mtd', label: 'This month' },
  { key: 'last', label: 'Last month' },
  { key: 'q', label: 'Last 90d' },
  { key: 'ytd', label: 'YTD' },
]

type Row = { month: string; label?: any; forecast?: boolean; [k: string]: any }
type Kpi = { label: string; key: string; kind: 'money' | 'pct' | 'count'; invert?: boolean; hint?: string; color?: string }

/* --------------------------------- helpers -------------------------------- */

// Rows covered by the selected period (the current month is always the last row).
function periodRows(rows: Row[], period: Period): Row[] {
  const n = rows.length
  if (period === 'mtd') return rows.slice(-1)
  if (period === 'last') return rows.slice(-2, -1)
  if (period === 'q') return rows.slice(-4, -1)
  const year = rows[n - 1].month.slice(0, 4)
  return rows.filter((r) => r.month.startsWith(year))
}
// The equivalent prior period, for trend comparison.
function priorRows(rows: Row[], period: Period): Row[] {
  if (period === 'mtd') return rows.slice(-2, -1)
  if (period === 'last') return rows.slice(-3, -2)
  if (period === 'q') return rows.slice(-7, -4)
  return []
}

// Sum money fields; recompute ratios from sums; clients = latest row in period.
function aggregate(rows: Row[], margin: (s: Record<string, number>) => number) {
  const s: Record<string, number> = {}
  for (const r of rows) for (const [k, v] of Object.entries(r)) if (typeof v === 'number') s[k] = (s[k] || 0) + v
  if (rows.length) s.clients = rows[rows.length - 1].clients ?? 0
  s.netMargin = margin(s)
  return s
}

// Trim leading months with no activity so charts start at the first real month.
function trimLeading(rows: Row[], keys: string[]): Row[] {
  const first = rows.findIndex((r) => keys.some((k) => (r[k] || 0) !== 0))
  return first === -1 ? rows.slice(-1) : rows.slice(first)
}

// Chart rows: history (current month at run-rate pace, flagged) + 3 forecast months.
function withForecast(rows: Row[], keys: string[], day: number, dim: number, derive?: (r: Row) => Row) {
  const hist = rows.map((r, i) => {
    if (i < rows.length - 1) return { ...r, label: monthLabel(r.month) }
    const paced: Row = { ...r, label: `${monthLabel(r.month)}*`, forecast: true }
    for (const k of keys) paced[k] = paceProjection(r[k] || 0, day, dim)
    return derive ? derive(paced) : paced
  })
  const fc: Record<string, number[]> = {}
  for (const k of keys) fc[k] = linearForecast(hist.map((r) => r[k] || 0), 3, 6, 0)
  const future = nextMonths(rows[rows.length - 1].month).map((month, j) => {
    const r: Row = { month, label: monthLabel(month), forecast: true }
    for (const k of keys) r[k] = fc[k][j]
    return derive ? derive(r) : r
  })
  return [...hist, ...future]
}

/* -------------------------------- components ------------------------------ */

function KpiGrid({ kpis, rows, period, margin, day, dim, activeClients }: {
  kpis: Kpi[]
  rows: Row[]
  period: Period
  margin: (s: Record<string, number>) => number
  day: number
  dim: number
  activeClients?: number
}) {
  const cur = aggregate(periodRows(rows, period), margin)
  const prevRows = priorRows(rows, period)
  const prev = prevRows.length ? aggregate(prevRows, margin) : null
  const fmt = (k: Kpi, v: number) => (k.kind === 'money' ? fmtCurrency(v) : k.kind === 'pct' ? fmtPct(v) : String(Math.round(v)))

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
      {kpis.map((k) => {
        let value = cur[k.key] ?? 0
        // Live client count comes from a different source than the monthly history — don't compare them.
        const live = k.key === 'clients' && activeClients !== undefined && (period === 'mtd' || period === 'ytd')
        if (live) value = activeClients
        // This month: compare month-end pace against last month's full total.
        const paced = period === 'mtd' && k.kind === 'money' ? paceProjection(value, day, dim) : null
        const compare = paced ?? value
        const base = live ? undefined : prev?.[k.key]
        let trend: number | null = null
        if (base !== undefined && base !== null && k.kind !== 'pct' && Math.abs(base) > 0) trend = ((compare - base) / Math.abs(base)) * 100
        if (trend !== null && k.invert) trend = -trend
        return (
          <div key={k.key} className="los-card p-4">
            <div className="flex items-start justify-between gap-2">
              <p className="los-label">{k.label}</p>
              {trend !== null && isFinite(trend) && <TrendPill pct={trend} />}
            </div>
            <p className="los-metric-number mt-1" style={k.color ? { color: k.color } : undefined}>{fmt(k, value)}</p>
            <p className="text-[11px] text-los-text-muted mt-1 truncate">
              {paced !== null ? `Pace ${fmtK(paced)}` : k.hint || ' '}
              {prev && base !== undefined && k.kind !== 'pct' ? ` · prev ${k.kind === 'money' ? fmtK(base) : Math.round(base)}` : ''}
            </p>
          </div>
        )
      })}
    </div>
  )
}

function Card({ title, sub, children, className = '' }: { title: string; sub?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`los-card p-4 flex flex-col ${className}`}>
      <div className="mb-8">
        <h2 className="text-sm font-semibold text-los-text">{title}</h2>
        {sub && <p className="text-[11px] text-los-text-muted">{sub}</p>}
      </div>
      {children}
    </div>
  )
}

// Cumulative this-month vs last-month, aligned to today's day of month.
function PaceChart({ pace, color, name }: { pace: { current: number[]; previous: number[] }; color: string; name: string }) {
  const days = pace.current.length
  const data = pace.current.map((v, i) => ({ label: `D${i + 1}`, cur: v, prev: pace.previous[Math.min(i, pace.previous.length - 1)] ?? 0 }))
  const lastFull = pace.previous[pace.previous.length - 1] ?? 0
  const delta = (pace.current[days - 1] ?? 0) - (pace.previous[Math.min(days, pace.previous.length) - 1] ?? 0)
  return (
    <>
      <MultiLineChart
        data={data}
        series={[
          { key: 'cur', name: `This month`, color },
          { key: 'prev', name: 'Last month', color: '#6b6b78' },
        ]}
        height={170}
        format={fmtK}
      />
      <p className="text-[11px] text-los-text-muted mt-3">
        {name} {delta >= 0 ? 'ahead of' : 'behind'} last month by <span className="text-los-text font-mono">{fmtK(Math.abs(delta))}</span> at day {days}. Last month finished at{' '}
        <span className="text-los-text font-mono">{fmtK(lastFull)}</span>.
      </p>
    </>
  )
}

function ForecastTable({ rows, cols }: { rows: Row[]; cols: { key: string; label: string; kind?: 'pct' }[] }) {
  const future = rows.filter((r) => r.forecast)
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-los-text-muted text-left">
            <th className="font-medium py-1.5 pr-3">Month</th>
            {cols.map((c) => (
              <th key={c.key} className="font-medium py-1.5 px-2 text-right">{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {future.map((r) => (
            <tr key={r.month} className="border-t border-los-border">
              <td className="py-1.5 pr-3 text-los-text-secondary">{r.label}</td>
              {cols.map((c) => (
                <td key={c.key} className="py-1.5 px-2 text-right font-mono text-los-text">
                  {c.kind === 'pct' ? fmtPct(r[c.key] || 0) : fmtCurrency(r[c.key] || 0)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] text-los-text-muted mt-2">* current month at run-rate pace. Forecast = linear trend over last 6 months.</p>
    </div>
  )
}

/* ---------------------------------- page ---------------------------------- */

export default function FinancePage() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('total')
  const [period, setPeriod] = useState<Period>('mtd')

  const load = async () => {
    setLoading(true)
    try {
      setData(await fetch('/api/finance/overview').then((r) => r.json()))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    try {
      const saved = localStorage.getItem('finance-tab') as Tab | null
      if (saved && TABS.some((t) => t.key === saved)) setTab(saved)
    } catch {}
    load()
  }, [])
  const pickTab = (t: Tab) => {
    setTab(t)
    try {
      localStorage.setItem('finance-tab', t)
    } catch {}
  }

  const day = data?.dayOfMonth ?? 1
  const dim = data?.daysInMonth ?? 30

  const view = useMemo(() => {
    if (!data?.genexa || tab === 'mercury') return null
    const profitMargin = (s: Record<string, number>) => (s.netRev > 0 ? (s.netProfit / s.netRev) * 100 : 0)
    const deriveProfit = (r: Row) => {
      r.netProfit = (r.netRev || 0) - (r.expenses || 0)
      r.netMargin = r.netRev > 0 ? (r.netProfit / r.netRev) * 100 : 0
      return r
    }

    if (tab === 'genexa') {
      const rows = trimLeading(data.genexa.monthly, ['gross', 'expenses'])
      const chart = withForecast(rows, ['newCash', 'backend', 'refunds', 'expenses'], day, dim, (r) => {
        r.netRev = (r.newCash || 0) + (r.backend || 0) - (r.refunds || 0)
        return deriveProfit(r)
      })
      return { kind: 'genexa' as const, rows, chart, margin: profitMargin }
    }
    if (tab === 'sms') {
      const rows = trimLeading(data.sms.monthly, ['gross'])
      const chart = withForecast(rows, ['newCash', 'backend', 'refunds', 'fees'], day, dim, (r) => {
        r.netRev = (r.newCash || 0) + (r.backend || 0) - (r.refunds || 0) - (r.fees || 0)
        return r
      })
      const takeRows = trimLeading(data.sms.take, ['payouts'])
      const takeChart = withForecast(takeRows, ['payouts'], day, dim)
      const margin = (s: Record<string, number>) => (s.gross > 0 ? (s.netRev / s.gross) * 100 : 0)
      return { kind: 'sms' as const, rows, chart, takeRows, takeChart, margin }
    }
    const rows = trimLeading(data.total.monthly, ['netRev', 'expenses'])
    const chart = withForecast(rows, ['newCash', 'backend', 'refunds', 'smsPayouts', 'expenses'], day, dim, (r) => {
      r.genexaNetRev = (r.newCash || 0) + (r.backend || 0) - (r.refunds || 0)
      r.netRev = r.genexaNetRev + (r.smsPayouts || 0)
      return deriveProfit(r)
    })
    return { kind: 'total' as const, rows, chart, margin: profitMargin }
  }, [data, tab, day, dim])

  const histLabel = (rows: Row[]) => rows.map((r) => ({ ...r, label: monthLabel(r.month) }))

  return (
    <div className="px-4 sm:px-6 py-5 max-w-[1400px] mx-auto flex flex-col gap-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-los-text tracking-tight">Finance</h1>
          <p className="text-xs text-los-text-muted mt-0.5">
            Whop · Mercury · Commas{data?.asOf ? ` · updated ${new Date(data.asOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}
          </p>
        </div>
        <button onClick={load} disabled={loading} className="los-btn los-btn-ghost">
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-0.5 bg-los-surface-2 rounded-lg p-0.5 max-w-full overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => pickTab(t.key)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition ${tab === t.key ? 'bg-los-accent text-white' : 'text-los-text-muted hover:text-los-text'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className={`flex items-center gap-0.5 bg-los-surface-2 rounded-lg p-0.5 ${tab === 'mercury' ? 'invisible' : ''}`}>
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className={`px-2 py-1 rounded-md text-[11px] font-medium transition ${period === p.key ? 'bg-los-accent text-white' : 'text-los-text-muted hover:text-los-text'}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'mercury' && <MercuryLive />}

      {tab !== 'mercury' && data?.errors?.length > 0 && (
        <div className="los-card p-3 text-xs text-los-red">Some sources failed: {data.errors.join(' · ')}</div>
      )}
      {tab !== 'mercury' && data?.error && <div className="los-card p-3 text-xs text-los-red">{data.error}</div>}
      {tab !== 'mercury' && !view && loading && <div className="los-card p-8 text-center text-xs text-los-text-muted">Loading finance data…</div>}

      {view?.kind === 'total' && (
        <>
          <KpiGrid
            rows={view.rows}
            period={period}
            margin={view.margin}
            day={day}
            dim={dim}
            activeClients={data.genexa.activeClients + data.sms.activeClients}
            kpis={[
              { label: 'Net Revenue', key: 'netRev', kind: 'money', hint: 'Genexa net + SMS payouts' },
              { label: 'Net Profit', key: 'netProfit', kind: 'money', color: C.backend },
              { label: 'Expenses', key: 'expenses', kind: 'money', invert: true },
              { label: 'Net Margin', key: 'netMargin', kind: 'pct', color: C.margin },
              { label: 'Active Clients', key: 'clients', kind: 'count', hint: 'Genexa + SMS' },
              { label: 'New Cash', key: 'newCash', kind: 'money', hint: 'Genexa first payments' },
              { label: 'Backend Revenue', key: 'backend', kind: 'money', hint: 'Genexa repeat payments' },
              { label: 'Refunds', key: 'refunds', kind: 'money', invert: true },
              { label: 'SMS Payouts', key: 'smsPayouts', kind: 'money', color: C.sms },
              { label: 'Genexa Net Rev', key: 'genexaNetRev', kind: 'money' },
            ]}
          />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <Card title="Income trajectory & forecast" sub="Monthly income by source · line = net profit" className="lg:col-span-2">
              <StackedForecast
                data={view.chart}
                series={[
                  { key: 'newCash', name: 'New cash', color: C.newCash },
                  { key: 'backend', name: 'Backend', color: C.backend },
                  { key: 'smsPayouts', name: 'SMS payouts', color: C.sms },
                ]}
                line={{ key: 'netProfit', name: 'Net profit', color: C.profit }}
                height={220}
                format={fmtK}
              />
            </Card>
            <Card title="Forecast" sub="Next 3 months">
              <ForecastTable rows={view.chart} cols={[{ key: 'netRev', label: 'Net rev' }, { key: 'expenses', label: 'Exp' }, { key: 'netProfit', label: 'Profit' }]} />
              <RunRate chart={view.chart} />
            </Card>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <Card title="Net revenue vs expenses" sub="Monthly actuals (current month to date)">
              <MultiLineChart
                data={histLabel(view.rows)}
                series={[
                  { key: 'netRev', name: 'Net rev', color: C.newCash },
                  { key: 'expenses', name: 'Expenses', color: C.expenses },
                  { key: 'netProfit', name: 'Net profit', color: C.backend },
                ]}
                format={fmtK}
              />
            </Card>
            <Card title="This month vs last" sub="Cumulative net revenue by day">
              <PaceChart pace={data.total.pace} color={C.newCash} name="Net revenue" />
            </Card>
          </div>
          <MarginClients rows={view.rows} />
        </>
      )}

      {view?.kind === 'genexa' && (
        <>
          <KpiGrid
            rows={view.rows}
            period={period}
            margin={view.margin}
            day={day}
            dim={dim}
            activeClients={data.genexa.activeClients}
            kpis={[
              { label: 'New Cash', key: 'newCash', kind: 'money', hint: 'First payments' },
              { label: 'Backend Revenue', key: 'backend', kind: 'money', hint: 'Repeat payments' },
              { label: 'Refunds', key: 'refunds', kind: 'money', invert: true },
              { label: 'Net Revenue', key: 'netRev', kind: 'money' },
              { label: 'Expenses', key: 'expenses', kind: 'money', invert: true },
              { label: 'Net Profit', key: 'netProfit', kind: 'money', color: C.backend },
              { label: 'Net Margin', key: 'netMargin', kind: 'pct', color: C.margin },
              { label: 'Active Clients', key: 'clients', kind: 'count', hint: data.genexa.clientsDetail },
            ]}
          />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <Card title="Revenue trajectory & forecast" sub="New cash vs backend · line = net profit" className="lg:col-span-2">
              <StackedForecast
                data={view.chart}
                series={[
                  { key: 'newCash', name: 'New cash', color: C.newCash },
                  { key: 'backend', name: 'Backend', color: C.backend },
                ]}
                line={{ key: 'netProfit', name: 'Net profit', color: C.profit }}
                height={220}
                format={fmtK}
              />
            </Card>
            <Card title="Forecast" sub="Next 3 months">
              <ForecastTable rows={view.chart} cols={[{ key: 'netRev', label: 'Net rev' }, { key: 'expenses', label: 'Exp' }, { key: 'netProfit', label: 'Profit' }]} />
              <RunRate chart={view.chart} />
            </Card>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <Card title="Net revenue vs expenses" sub="Monthly actuals (current month to date)">
              <MultiLineChart
                data={histLabel(view.rows)}
                series={[
                  { key: 'netRev', name: 'Net rev', color: C.newCash },
                  { key: 'expenses', name: 'Expenses', color: C.expenses },
                  { key: 'netProfit', name: 'Net profit', color: C.backend },
                ]}
                format={fmtK}
              />
            </Card>
            <Card title="This month vs last" sub="Cumulative Whop net revenue by day">
              <PaceChart pace={data.genexa.pace} color={C.newCash} name="Revenue" />
            </Card>
          </div>
          <MarginClients rows={view.rows} clientsSub="Unique Whop payers, trailing 90 days" />
          <Card title="Expenses by category" sub="Mercury business spend · excludes transfers, owner draws, personal">
            <ExpenseTable rows={data.genexa.expenseBreakdown} />
          </Card>
        </>
      )}

      {view?.kind === 'sms' && (
        <>
          <p className="los-label -mb-1">Whole business · Commas</p>
          <KpiGrid
            rows={view.rows}
            period={period}
            margin={view.margin}
            day={day}
            dim={dim}
            kpis={[
              { label: 'New Cash', key: 'newCash', kind: 'money', hint: 'First payments' },
              { label: 'Backend Revenue', key: 'backend', kind: 'money', hint: 'Repeat payments' },
              { label: 'Refunds', key: 'refunds', kind: 'money', invert: true },
              { label: 'Processor Fees', key: 'fees', kind: 'money', invert: true },
              { label: 'Net Revenue', key: 'netRev', kind: 'money', hint: 'After refunds & fees' },
              { label: 'Net Margin', key: 'netMargin', kind: 'pct', color: C.margin, hint: 'Net rev / gross' },
              { label: 'Active Clients', key: 'clients', kind: 'count', hint: 'Paid in last 30 days' },
            ]}
          />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <Card title="Business revenue trajectory & forecast" sub="New cash vs backend · line = net revenue" className="lg:col-span-2">
              <StackedForecast
                data={view.chart}
                series={[
                  { key: 'newCash', name: 'New cash', color: C.newCash },
                  { key: 'backend', name: 'Backend', color: C.backend },
                ]}
                line={{ key: 'netRev', name: 'Net rev', color: C.profit }}
                height={220}
                format={fmtK}
              />
            </Card>
            <Card title="This month vs last" sub="Cumulative gross sales by day">
              <PaceChart pace={data.sms.pace} color={C.sms} name="Sales" />
            </Card>
          </div>
          <MarginClients rows={view.rows} clientsSub="Unique paying customers, trailing 30 days" />

          <p className="los-label -mb-1 mt-2">Your take · Mercury payouts (Ray Media / FanBasis)</p>
          <KpiGrid
            rows={view.takeRows}
            period={period}
            margin={(s) => (s.bizNet > 0 ? (s.payouts / s.bizNet) * 100 : 0)}
            day={day}
            dim={dim}
            kpis={[
              { label: 'Your Payouts', key: 'payouts', kind: 'money', color: C.sms },
              { label: 'Share of Net Rev', key: 'netMargin', kind: 'pct', hint: 'Payouts / business net rev' },
            ]}
          />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <Card title="Payouts trajectory & forecast" className="lg:col-span-2">
              <StackedForecast data={view.takeChart} series={[{ key: 'payouts', name: 'Payouts', color: C.sms }]} height={200} format={fmtK} />
            </Card>
            <Card title="Forecast" sub="Next 3 months">
              <ForecastTable rows={view.takeChart} cols={[{ key: 'payouts', label: 'Payouts' }]} />
            </Card>
          </div>
        </>
      )}
    </div>
  )
}

function RunRate({ chart }: { chart: Row[] }) {
  const cur = chart.find((r) => r.forecast)
  if (!cur) return null
  return (
    <div className="grid grid-cols-2 gap-2 mt-4">
      <div className="rounded-lg bg-los-surface-2 px-3 py-2.5">
        <p className="los-label mb-1">Annual run-rate</p>
        <p className="font-mono font-semibold text-sm text-los-text">{fmtK((cur.netRev || 0) * 12)}</p>
      </div>
      <div className="rounded-lg bg-los-surface-2 px-3 py-2.5">
        <p className="los-label mb-1">Profit run-rate</p>
        <p className="font-mono font-semibold text-sm" style={{ color: C.backend }}>{fmtK((cur.netProfit || 0) * 12)}</p>
      </div>
    </div>
  )
}

function MarginClients({ rows, clientsSub = 'Paying clients at month end' }: { rows: Row[]; clientsSub?: string }) {
  const lbl: Row[] = rows.map((r) => ({ ...r, label: monthLabel(r.month) }))
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <div className="los-card p-4">
        <h2 className="text-sm font-semibold text-los-text">Net margin</h2>
        <p className="text-[11px] text-los-text-muted mb-4">Monthly · clamped to ±100%</p>
        <LineChart data={lbl.map((r) => ({ label: r.label, value: Math.max(-100, Math.min(100, r.netMargin || 0)) }))} height={150} format={fmtPct} color={C.margin} />
      </div>
      <div className="los-card p-4">
        <h2 className="text-sm font-semibold text-los-text">Active clients</h2>
        <p className="text-[11px] text-los-text-muted mb-4">{clientsSub}</p>
        <LineChart data={lbl.map((r) => ({ label: r.label, value: r.clients || 0 }))} height={150} format={(v) => String(Math.round(v))} color={C.clients} />
      </div>
    </div>
  )
}

function ExpenseTable({ rows }: { rows: { category: string; current: number; avg3: number }[] }) {
  if (!rows?.length) return <p className="text-xs text-los-text-muted">No expenses found</p>
  const max = Math.max(...rows.map((r) => Math.max(r.current, r.avg3)), 1)
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-los-text-muted text-left">
          <th className="font-medium py-1.5 pr-3">Category</th>
          <th className="font-medium py-1.5 px-2 text-right">This month</th>
          <th className="font-medium py-1.5 px-2 text-right">3-mo avg</th>
          <th className="font-medium py-1.5 pl-3 w-1/3 hidden sm:table-cell"></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.category} className="border-t border-los-border">
            <td className="py-1.5 pr-3 text-los-text-secondary">{r.category}</td>
            <td className="py-1.5 px-2 text-right font-mono text-los-text">{fmtCurrency(r.current)}</td>
            <td className="py-1.5 px-2 text-right font-mono text-los-text-muted">{fmtCurrency(r.avg3)}</td>
            <td className="py-1.5 pl-3 hidden sm:table-cell">
              <div className="h-1.5 rounded-full bg-los-surface-2 overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${(Math.max(r.current, 0) / max) * 100}%`, background: C.expenses }} />
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
