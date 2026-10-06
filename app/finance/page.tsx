'use client'

import { useEffect, useMemo, useState } from 'react'
import { LineChart, MultiLineChart, StackedForecast, TrendPill } from '@/components/Charts'
import MercuryLive from '@/components/MercuryLive'
import ExpectedMoney from '@/components/finance/ExpectedMoney'
import ExpenseControls from '@/components/finance/ExpenseControls'
import ForecastScenarios from '@/components/finance/ForecastScenarios'
import PayStructure from '@/components/finance/PayStructure'
import { ChipData, Chips } from '@/components/finance/Chip'
import { monthLabel, paceProjection } from '@/lib/forecast'

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
type Kpi = {
  label: string
  key: string
  kind: 'money' | 'pct' | 'count'
  invert?: boolean
  hint?: string
  color?: string
  watch?: 'revenue' | 'cost' | 'refunds' | 'margin' // anomaly rule to apply
  fixed?: number // point-in-time value (e.g. cash) — not summed per period, no pace/trend
}

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

// Chart rows: full months as actuals, then the current month + next 3 from the base scenario.
function withScenario(rows: Row[], months: any[], map: (m: any) => Record<string, number>) {
  const hist = rows.slice(0, -1).map((r) => ({ ...r, label: monthLabel(r.month) }))
  const future = months.map((m) => ({ ...map(m), month: m.month, label: `${monthLabel(m.month)}${m.partial ? '*' : ''}`, forecast: true }))
  return [...hist, ...future]
}

// Chart rows: history with the current month projected at run-rate pace (no forward months).
function withPace(rows: Row[], keys: string[], day: number, dim: number) {
  return rows.map((r, i) => {
    if (i < rows.length - 1) return { ...r, label: monthLabel(r.month) }
    const paced: Row = { ...r, label: `${monthLabel(r.month)}*`, forecast: true }
    for (const k of keys) paced[k] = paceProjection(r[k] || 0, day, dim)
    return paced
  })
}

// Contextual anomaly chips for a KPI: this month's pace vs the prior 3-month average.
function kpiAnomalies(k: Kpi, rows: Row[], value: number, day: number, dim: number, trend: number | null): ChipData[] {
  if (!k.watch || day < 5 || rows.length < 2) return []
  const hist = rows.slice(-4, -1).map((r) => r[k.key] || 0)
  const avg3 = hist.reduce((s, v) => s + v, 0) / (hist.length || 1)
  const pace = paceProjection(value, day, dim)
  const pct = avg3 > 0 ? Math.round(((pace - avg3) / avg3) * 100) : null
  if (k.watch === 'margin') return value < 0 ? [{ tone: 'red', text: 'Negative margin' }] : []
  if (k.watch === 'refunds') {
    if (value > 500 && (avg3 === 0 || value > avg3 * 2)) return [{ tone: 'red', text: 'Refund spike' }]
    return []
  }
  if (pct === null) return []
  if (k.watch === 'revenue') {
    if (pct <= -40) return [{ tone: 'red', text: `Pace ${pct}% vs avg` }]
    if (pct <= -20) return [{ tone: 'amber', text: `Pace ${pct}% vs avg` }]
    // Positive chips only when clearly above normal AND also up on last month (avoid mixed signals).
    if (pct >= 50 && (trend === null || trend > 0)) return [{ tone: 'green', text: `Well above normal · +${pct}%` }]
    return []
  }
  // cost
  if (pct >= 75) return [{ tone: 'red', text: `+${pct}% vs 3-mo avg` }]
  if (pct >= 25) return [{ tone: 'amber', text: `+${pct}% vs 3-mo avg` }]
  if (pct <= -30 && (trend === null || trend > 0)) return [{ tone: 'green', text: `${pct}% vs 3-mo avg` }]
  return []
}

/* -------------------------------- components ------------------------------ */

function KpiGrid({ kpis, rows, period, margin, day, dim, activeClients, extraChips, variant = 'primary' }: {
  kpis: Kpi[]
  rows: Row[]
  period: Period
  margin: (s: Record<string, number>) => number
  day: number
  dim: number
  activeClients?: number
  extraChips?: Record<string, ChipData[]>
  variant?: 'primary' | 'secondary' // secondary = compact, lower-emphasis cards
}) {
  const cur = aggregate(periodRows(rows, period), margin)
  const prevRows = priorRows(rows, period)
  const prev = prevRows.length ? aggregate(prevRows, margin) : null
  const fmt = (k: Kpi, v: number) => (k.kind === 'money' ? fmtCurrency(v) : k.kind === 'pct' ? fmtPct(v) : String(Math.round(v)))

  return (
    <div className={`grid gap-3 ${variant === 'secondary' ? 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-6' : 'grid-cols-2 md:grid-cols-3 xl:grid-cols-5'}`}>
      {kpis.map((k) => {
        let value = k.fixed ?? cur[k.key] ?? 0
        // Live client count comes from a different source than the monthly history — don't compare them.
        const live = k.key === 'clients' && activeClients !== undefined && (period === 'mtd' || period === 'ytd')
        if (live) value = activeClients
        // This month: compare month-end pace against last month's full total.
        const paced = period === 'mtd' && k.kind === 'money' && k.fixed === undefined ? paceProjection(value, day, dim) : null
        const compare = paced ?? value
        const base = live || k.fixed !== undefined ? undefined : prev?.[k.key]
        let trend: number | null = null
        if (base !== undefined && base !== null && k.kind !== 'pct' && Math.abs(base) > 0) trend = ((compare - base) / Math.abs(base)) * 100
        if (trend !== null && k.invert) trend = -trend
        const chips = [...(period === 'mtd' ? kpiAnomalies(k, rows, value, day, dim, trend) : []), ...(extraChips?.[k.key] || [])]
        const sub = `${paced !== null ? `Pace ${fmtK(paced)}` : k.hint || ''}${prev && base !== undefined && k.kind !== 'pct' ? ` · prev ${k.kind === 'money' ? fmtK(base) : Math.round(base)}` : ''}`
        if (variant === 'secondary')
          return (
            <div key={k.key} className="los-card px-3 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <p className="los-label truncate">{k.label}</p>
                {trend !== null && isFinite(trend) && <TrendPill pct={trend} />}
              </div>
              <p className="font-mono font-semibold text-lg text-los-text mt-0.5" style={k.color ? { color: k.color } : undefined}>{fmt(k, value)}</p>
              {chips.length > 0 && <Chips chips={chips} />}
              <p className="text-[10px] text-los-text-muted mt-0.5 truncate">{sub || '\u00a0'}</p>
            </div>
          )
        return (
          <div key={k.key} className="los-card p-4">
            <div className="flex items-start justify-between gap-2">
              <p className="los-label">{k.label}</p>
              {trend !== null && isFinite(trend) && <TrendPill pct={trend} />}
            </div>
            <p className="los-metric-number mt-1" style={k.color ? { color: k.color } : undefined}>{fmt(k, value)}</p>
            {chips.length > 0 && (
              <div className="mt-1">
                <Chips chips={chips} />
              </div>
            )}
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

function Card({ title, sub, children, className = '', tight = false }: { title: string; sub?: string; children: React.ReactNode; className?: string; tight?: boolean }) {
  return (
    <div className={`los-card p-4 flex flex-col ${className}`}>
      {/* charts render their legend above the plot, so they need the extra gap */}
      <div className={tight ? 'mb-4' : 'mb-8'}>
        <h2 className="text-sm font-semibold text-los-text">{title}</h2>
        {sub && <p className="text-[11px] text-los-text-muted">{sub}</p>}
      </div>
      {children}
    </div>
  )
}

// MRR now vs predicted MRR in 30 days, with the drivers behind the prediction.
function MrrStrip({ current, predicted, currentSub, predictedSub }: { current: number; predicted: number; currentSub: string; predictedSub: string }) {
  const delta = current > 0 ? ((predicted - current) / current) * 100 : null
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="los-card p-4">
        <p className="los-label">MRR</p>
        <p className="los-metric-number mt-1" style={{ color: C.backend }}>{fmtCurrency(current)}</p>
        <p className="text-[11px] text-los-text-muted mt-1 truncate" title={currentSub}>{currentSub}</p>
      </div>
      <div className="los-card p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="los-label">Predicted MRR · 30d</p>
          {delta !== null && isFinite(delta) && <TrendPill pct={delta} />}
        </div>
        <p className="los-metric-number mt-1">{fmtCurrency(predicted)}</p>
        <p className="text-[11px] text-los-text-muted mt-1 truncate" title={predictedSub}>{predictedSub}</p>
      </div>
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

    if (tab === 'genexa') {
      const rows = trimLeading(data.genexa.monthly, ['gross', 'expenses'])
      const chart = withScenario(rows, data.genexa.forecast.base.months, (m) => ({ newCash: m.newCash, backend: m.backend, netProfit: m.profit }))
      return { kind: 'genexa' as const, rows, chart, margin: profitMargin }
    }
    if (tab === 'sms') {
      const rows = trimLeading(data.sms.monthly, ['gross', 'revenue'])
      const chart = withPace(rows, ['newCash', 'backend', 'netProfit'], day, dim)
      const margin = (s: Record<string, number>) => (s.revenue > 0 ? (s.netProfit / s.revenue) * 100 : 0)
      return { kind: 'sms' as const, rows, chart, margin }
    }
    const rows = trimLeading(data.total.monthly, ['netRev', 'expenses'])
    const chart = withScenario(rows, data.total.forecast.base.months, (m) => ({ newCash: m.newCash, backend: m.backend, smsPayouts: m.smsPayouts, netProfit: m.profit }))
    return { kind: 'total' as const, rows, chart, margin: profitMargin }
  }, [data, tab, day, dim])

  // Anomaly chips that come from other sections (receivables, sheet status).
  const arItems: any[] = data?.receivables?.items || []
  const failed = arItems.filter((i) => i.business !== 'Cold SMS' && i.flags.includes('Payment failed')).length
  const overdueGx = arItems.filter((i) => i.business !== 'Cold SMS' && (i.status === 'Overdue' || i.status === 'At risk')).length
  const backendChips: ChipData[] = [
    ...(failed ? [{ tone: 'red' as const, text: `Payment failed${failed > 1 ? ` ×${failed}` : ''}` }] : []),
    ...(overdueGx > failed ? [{ tone: 'red' as const, text: 'Backend payment missing' }] : []),
  ]

  return (
    <div className="px-4 sm:px-6 py-5 max-w-[1400px] mx-auto flex flex-col gap-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-los-text tracking-tight">Finance</h1>
          <p className="text-xs text-los-text-muted mt-0.5">
            Whop · Mercury · Commas · Monday · Cold SMS sheet{data?.asOf ? ` · updated ${new Date(data.asOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}
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
          {data.mrr && (
            <MrrStrip
              current={data.mrr.total.current}
              predicted={data.mrr.total.predicted}
              currentSub={`Genexa ${fmtK(data.mrr.total.genexa)} + your SMS share ${fmtK(data.mrr.total.smsShare)}`}
              predictedSub={`Genexa ${fmtK(data.mrr.genexa.predicted)} + SMS share ${fmtK(data.mrr.total.smsSharePredicted)}`}
            />
          )}
          <KpiGrid
            rows={view.rows}
            period={period}
            margin={view.margin}
            day={day}
            dim={dim}
            kpis={[
              { label: 'Net Revenue', key: 'netRev', kind: 'money', hint: 'Genexa net + SMS payouts', watch: 'revenue' },
              { label: 'Net Profit', key: 'netProfit', kind: 'money', color: C.backend, watch: 'revenue' },
              { label: 'Net Margin', key: 'netMargin', kind: 'pct', color: C.margin, watch: 'margin' },
              { label: 'Net Cash Position', key: 'cash', kind: 'money', color: C.newCash, fixed: data.drivers.netPosition, hint: 'Mercury cash − card owed (live)' },
              { label: 'SMS Payouts', key: 'smsPayouts', kind: 'money', color: C.sms },
            ]}
          />
          <KpiGrid
            variant="secondary"
            rows={view.rows}
            period={period}
            margin={view.margin}
            day={day}
            dim={dim}
            activeClients={data.genexa.activeClients + data.sms.activeClients}
            extraChips={{ backend: backendChips }}
            kpis={[
              { label: 'New Cash', key: 'newCash', kind: 'money', hint: 'Genexa first payments', watch: 'revenue' },
              { label: 'Backend', key: 'backend', kind: 'money', hint: 'Genexa repeat payments', watch: 'revenue' },
              { label: 'Refunds', key: 'refunds', kind: 'money', invert: true, watch: 'refunds' },
              { label: 'Genexa Net Rev', key: 'genexaNetRev', kind: 'money', watch: 'revenue' },
              { label: 'Active Clients', key: 'clients', kind: 'count', hint: 'Genexa + SMS' },
              { label: 'Expenses', key: 'expenses', kind: 'money', invert: true, watch: 'cost' },
            ]}
          />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <Card title="Revenue & profit" sub="Monthly income by source · line = net profit · faded = base forecast" className="lg:col-span-2">
              <StackedForecast
                data={view.chart}
                series={[
                  { key: 'newCash', name: 'New cash', color: C.newCash },
                  { key: 'backend', name: 'Backend', color: C.backend },
                  { key: 'smsPayouts', name: 'SMS payouts', color: C.sms },
                ]}
                line={{ key: 'netProfit', name: 'Net profit', color: C.profit }}
                height={260}
                format={fmtK}
              />
            </Card>
            <Card title="Forecast" sub="Known renewals, recurring costs and cash" tight>
              <ForecastScenarios scenarios={data.total.forecast} drivers={data.drivers} />
            </Card>
          </div>
          <Card title="Expected money" sub="Next 30 days · Whop renewals, failed charges, Monday invoices, SMS payout" tight>
            <ExpectedMoney items={arItems} />
          </Card>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <Card title="This month vs last" sub="Cumulative net revenue by day">
              <PaceChart pace={data.total.pace} color={C.newCash} name="Net revenue" />
            </Card>
            <MarginClients rows={view.rows} />
          </div>
        </>
      )}

      {view?.kind === 'genexa' && (
        <>
          {data.mrr && (
            <MrrStrip
              current={data.mrr.genexa.current}
              predicted={data.mrr.genexa.predicted}
              currentSub={`${data.mrr.genexa.clients} recurring · Whop ${fmtK(data.mrr.genexa.whop)}${data.mrr.genexa.other ? ` (incl. ${fmtK(data.mrr.genexa.other)} other products)` : ''} + Monday ${fmtK(data.mrr.genexa.monday)}`}
              predictedSub={`−${fmtK(data.mrr.genexa.lost)} churn/cancels · +${fmtK(data.mrr.genexa.newAvg)} new/mo (90d avg)`}
            />
          )}
          <KpiGrid
            rows={view.rows}
            period={period}
            margin={view.margin}
            day={day}
            dim={dim}
            activeClients={data.genexa.activeClients}
            extraChips={{ backend: backendChips }}
            kpis={[
              { label: 'New Cash', key: 'newCash', kind: 'money', hint: 'First payments', watch: 'revenue' },
              { label: 'Backend Revenue', key: 'backend', kind: 'money', hint: 'Repeat payments', watch: 'revenue' },
              { label: 'Refunds', key: 'refunds', kind: 'money', invert: true, watch: 'refunds' },
              { label: 'Net Revenue', key: 'netRev', kind: 'money', watch: 'revenue' },
              { label: 'Expenses', key: 'expenses', kind: 'money', invert: true, watch: 'cost' },
              { label: 'Net Profit', key: 'netProfit', kind: 'money', color: C.backend, watch: 'revenue' },
              { label: 'Net Margin', key: 'netMargin', kind: 'pct', color: C.margin, watch: 'margin' },
              { label: 'Active Clients', key: 'clients', kind: 'count', hint: data.genexa.clientsDetail },
            ]}
          />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <Card title="Revenue & profit" sub="New cash vs backend · line = net profit · faded = base forecast" className="lg:col-span-2">
              <StackedForecast
                data={view.chart}
                series={[
                  { key: 'newCash', name: 'New cash', color: C.newCash },
                  { key: 'backend', name: 'Backend', color: C.backend },
                ]}
                line={{ key: 'netProfit', name: 'Net profit', color: C.profit }}
                height={260}
                format={fmtK}
              />
            </Card>
            <Card title="Forecast" sub="Genexa only · excludes SMS payouts" tight>
              <ForecastScenarios scenarios={data.genexa.forecast} drivers={data.drivers} cashNote="Ending cash here excludes SMS payouts." />
            </Card>
          </div>
          <Card title="Expected money" sub="Next 30 days · Whop renewals, failed charges, Monday invoices" tight>
            <ExpectedMoney items={arItems} filter={(i) => i.business === 'Genexa'} />
          </Card>
          <Card title="Expenses" sub="Mercury business spend · excludes transfers, owner draws, personal · adds up to the Expenses KPI above" tight>
            <ExpenseControls
              rows={data.expenses.rows}
              txs={data.expenses.txs || []}
              months={periodRows(data.genexa.monthly, period).map((r) => r.month)}
              periodLabel={PERIODS.find((p) => p.key === period)!.label}
            />
          </Card>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <Card title="This month vs last" sub="Cumulative Whop net revenue by day">
              <PaceChart pace={data.genexa.pace} color={C.newCash} name="Revenue" />
            </Card>
            <MarginClients rows={view.rows} clientsSub="Unique Whop payers, trailing 90 days" />
          </div>
        </>
      )}

      {view?.kind === 'sms' && (
        <>
          {data.mrr && (
            <MrrStrip
              current={data.mrr.sms.current}
              predicted={data.mrr.sms.predicted}
              currentSub={`${data.mrr.sms.customers} active payers · ${data.mrr.sms.daily} daily, ${data.mrr.sms.weekly} weekly · billing run-rate, net of fees`}
              predictedSub={`${data.mrr.sms.retention}% net retention · +${fmtK(data.mrr.sms.newAvg)} new & returning/mo (90d avg)`}
            />
          )}
          <KpiGrid
            rows={view.rows}
            period={period}
            margin={view.margin}
            day={day}
            dim={dim}
            extraChips={{
              revenue: view.rows[view.rows.length - 1].source === 'sheet' || period !== 'mtd' ? [] : [{ tone: 'muted', text: 'Sheet pending · Commas est.' }],
              expenses: view.rows[view.rows.length - 1].source === 'sheet' || period !== 'mtd' ? [] : [{ tone: 'muted', text: 'Est. from 3-mo avg' }],
            }}
            kpis={[
              { label: 'Revenue', key: 'revenue', kind: 'money', hint: "Jacob's sheet (Commas until updated)", watch: 'revenue' },
              { label: 'Expenses', key: 'expenses', kind: 'money', invert: true, hint: "Jacob's sheet", watch: 'cost' },
              { label: 'Net Profit', key: 'netProfit', kind: 'money', color: C.backend, watch: 'revenue' },
              { label: 'Net Margin', key: 'netMargin', kind: 'pct', color: C.margin, watch: 'margin' },
              { label: 'Active Clients', key: 'clients', kind: 'count', hint: 'Paid in last 30 days' },
              { label: 'New Cash', key: 'newCash', kind: 'money', hint: 'Commas first payments', watch: 'revenue' },
              { label: 'Backend Revenue', key: 'backend', kind: 'money', hint: 'Commas repeat payments', watch: 'revenue' },
              { label: 'Refunds', key: 'refunds', kind: 'money', invert: true, watch: 'refunds' },
              { label: 'Processor Fees', key: 'fees', kind: 'money', invert: true, watch: 'cost' },
            ]}
          />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <Card title="Revenue & profit" sub="Bars = Commas sales · line = net profit (sheet) · * current month at pace" className="lg:col-span-2">
              <StackedForecast
                data={view.chart}
                series={[
                  { key: 'newCash', name: 'New cash', color: C.newCash },
                  { key: 'backend', name: 'Backend', color: C.backend },
                ]}
                line={{ key: 'netProfit', name: 'Net profit', color: C.profit }}
                height={260}
                format={fmtK}
              />
            </Card>
            <Card title="This month vs last" sub="Cumulative Commas sales by day">
              <PaceChart pace={data.sms.pace} color={C.sms} name="Sales" />
            </Card>
          </div>
          <Card title="Pay structure" sub="Our share of Cold SMS profit (60% from Sep 2026, 50% before; Jacob keeps the rest) is split progressively between Aryan and Rishil" tight>
            <PayStructure reconcile={data.sms.reconcile} sheetUpdatedTo={data.sms.sheetUpdatedTo} />
          </Card>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <MarginClients rows={view.rows} clientsSub="Unique paying customers, trailing 30 days" />
          </div>
        </>
      )}
    </div>
  )
}

function MarginClients({ rows, clientsSub = 'Paying clients at month end' }: { rows: Row[]; clientsSub?: string }) {
  const lbl: Row[] = rows.map((r) => ({ ...r, label: monthLabel(r.month) }))
  return (
    <>
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
    </>
  )
}
