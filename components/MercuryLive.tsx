'use client'

import { useEffect, useState } from 'react'
import { MultiLineChart, StackedForecast } from '@/components/Charts'
import { monthLabel, paceProjection } from '@/lib/forecast'
import ExpenseControls from '@/components/finance/ExpenseControls'
import { ChipData, Chips, Tone } from '@/components/finance/Chip'

const fmtCurrency = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const fmtCents = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
const fmtK = (n: number) => (Math.abs(n) >= 1000 ? `${n < 0 ? '-' : ''}$${(Math.abs(n) / 1000).toFixed(1)}k` : `$${n.toFixed(0)}`)

const LEVEL = {
  red: { dot: '#ef4444', label: 'Action' },
  amber: { dot: '#f59e0b', label: 'Watch' },
  info: { dot: '#6b6b78', label: 'Info' },
}
const TYPE_LABEL: Record<string, string> = {
  income: 'Income',
  smsPayout: 'SMS payout',
  expense: 'Expense',
  cardRefund: 'Refund',
  transfer: 'Transfer',
  ownerDraw: 'Owner draw',
  personal: 'Personal',
}

// One comparison period drives every Mercury comparison, chart and table on this tab.
const RANGES = [
  { key: '1m', label: '1m', days: 30, months: 1, ago: 'last month' },
  { key: '3m', label: '3m', days: 90, months: 3, ago: '3 months ago' },
  { key: '6m', label: '6m', days: 180, months: 6, ago: '6 months ago' },
  { key: '1y', label: '1y', days: 365, months: 12, ago: '1 year ago' },
] as const
type Range = (typeof RANGES)[number]

// Direction-aware change chip. good: 'up' (cash, profit), 'down' (card debt), 'watch' (draws — rising needs a look).
function delta(now: number, then: number | undefined, good: 'up' | 'down' | 'watch', ago: string): ChipData | null {
  if (then === undefined || !isFinite(then)) return null
  const diff = now - then
  if (Math.abs(diff) < 1) return { tone: 'muted', text: `No change vs ${ago}` }
  const up = diff > 0
  const tone: Tone = good === 'up' ? (up ? 'green' : 'red') : good === 'down' ? (up ? 'red' : 'green') : up ? 'amber' : 'green'
  const text = then > 0 ? `${up ? '+' : '−'}${Math.abs(Math.round((diff / then) * 100))}%` : `${up ? '+' : '−'}${fmtK(Math.abs(diff))}`
  return { tone, text: `${text} vs ${ago}` }
}

function Tile({ label, value, sub, color, chips }: { label: string; value: string; sub?: string; color?: string; chips?: ChipData[] }) {
  return (
    <div className="los-card p-4">
      <p className="los-label">{label}</p>
      <p className="los-metric-number mt-1" style={color ? { color } : undefined}>{value}</p>
      {chips && chips.length > 0 && (
        <div className="mt-1">
          <Chips chips={chips} />
        </div>
      )}
      <p className="text-[11px] text-los-text-muted mt-1 truncate">{sub || ' '}</p>
    </div>
  )
}

function Card({ title, sub, right, children, className = '' }: { title: string; sub?: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={`los-card p-4 flex flex-col ${className}`}>
      <div className="flex justify-between items-start gap-3 mb-4 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold text-los-text">{title}</h2>
          {sub && <p className="text-[11px] text-los-text-muted">{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </div>
  )
}

export default function MercuryLive() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<Range>(RANGES[1])
  const [series, setSeries] = useState<any[]>([])

  const load = async () => {
    setLoading(true)
    try {
      setData(await fetch('/api/mercury/overview').then((r) => r.json()))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load()
  }, [])
  useEffect(() => {
    fetch(`/api/finance/series?days=${range.days}`)
      .then((r) => r.json())
      .then((d) => Array.isArray(d.series) && setSeries(d.series))
      .catch(() => {})
  }, [range])

  if (!data && loading) return <div className="los-card p-8 text-center text-xs text-los-text-muted">Loading Mercury…</div>
  if (data?.error) return <div className="los-card p-3 text-xs text-los-red">{data.error}</div>
  if (!data) return null

  const b = data.balances
  const first = data.monthly.findIndex((m: any) => m.moneyIn || m.expenses)
  const monthly = (first === -1 ? data.monthly.slice(-1) : data.monthly.slice(first)).map((m: any) => ({ ...m, label: monthLabel(m.month) }))
  const cur = monthly[monthly.length - 1]
  const newNames = new Set<string>(data.expenseRows.filter((r: any) => r.newMerchant).map((r: any) => r.name))
  // Contextual chips.
  const full3 = monthly.slice(-4, -1)
  const avgExp = full3.reduce((s: number, m: any) => s + m.expenses, 0) / (full3.length || 1)
  const avgIn = full3.reduce((s: number, m: any) => s + m.moneyIn, 0) / (full3.length || 1)
  const expPace = paceProjection(cur.expenses, data.dayOfMonth, data.daysInMonth)
  const inPace = paceProjection(cur.moneyIn, data.dayOfMonth, data.daysInMonth)
  const profitChips: ChipData[] = []
  if (data.dayOfMonth >= 5 && avgExp > 0 && expPace > avgExp * 1.25) profitChips.push({ tone: 'amber', text: `Spend +${Math.round((expPace / avgExp - 1) * 100)}% vs avg` })
  if (data.dayOfMonth >= 5 && avgIn > 0 && inPace < avgIn * 0.8) profitChips.push({ tone: 'amber', text: `Money in ${Math.round((inPace / avgIn - 1) * 100)}% vs avg` })
  if (data.dayOfMonth >= 5 && avgIn > 0 && inPace > avgIn * 1.3) profitChips.push({ tone: 'green', text: `Money in +${Math.round((inPace / avgIn - 1) * 100)}% vs avg` })
  const cardChips: ChipData[] =
    b.creditOwed > 0 && data.autopayDays <= 5 ? [{ tone: b.creditOwed > b.checking * 0.25 ? 'red' : 'amber', text: `Autopay in ${data.autopayDays}d` }] : []
  const runwayChips: ChipData[] = data.burn.runwayMonths !== null && data.burn.runwayMonths < 6 ? [{ tone: 'red', text: 'Under 6 months' }] : []

  // Period comparisons: balances vs the start of the selected window; monthly figures vs the month N ago.
  const start = series[0]
  const end = series[series.length - 1]
  const pastMonth = data.monthly[data.monthly.length - 1 - range.months]
  const curProfitPace = paceProjection(cur.netProfit, data.dayOfMonth, data.daysInMonth)
  const curDrawsPace = paceProjection(cur.ownerDraws + cur.personal, data.dayOfMonth, data.daysInMonth)
  const cmp = (c: ChipData | null) => (c ? [c] : [])
  const checkingCmp = cmp(delta(b.checking, start?.checking, 'up', range.ago))
  const cardCmp = cmp(delta(b.creditOwed, start?.credit, 'down', range.ago))
  const netCmp = cmp(delta(b.netPosition, start?.warChest, 'up', range.ago))
  const profitCmp = cmp(delta(curProfitPace, pastMonth?.netProfit, 'up', range.ago))
  const drawsCmp = cmp(delta(curDrawsPace, pastMonth ? pastMonth.ownerDraws + pastMonth.personal : undefined, 'watch', range.ago))
  const shownMonths = monthly.slice(-(range.months + 1))
  const chartSummary = start && end
    ? [
        { name: 'Checking', from: start.checking, to: end.checking, good: 'up' as const },
        { name: 'Card owed', from: start.credit, to: end.credit, good: 'down' as const },
        { name: 'Net position', from: start.warChest, to: end.warChest, good: 'up' as const },
      ]
    : []

  return (
    <>
      <div className="flex items-center justify-between -mb-1 gap-3 flex-wrap">
        <p className="los-label">Live from Mercury · {new Date(data.asOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</p>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-los-text-muted hidden sm:inline">Compare vs</span>
          <div className="flex items-center gap-0.5 bg-los-surface-2 rounded-lg p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRange(r)}
                className={`px-2 py-1 rounded-md text-[11px] font-medium transition ${range.key === r.key ? 'bg-los-accent text-white' : 'text-los-text-muted hover:text-los-text'}`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button onClick={load} disabled={loading} className="text-[11px] text-los-accent hover:underline disabled:opacity-50">
            {loading ? '…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <Tile label="Checking" value={fmtCurrency(b.checking)} sub={b.savings ? `Savings ${fmtCurrency(b.savings)}` : 'Available'} chips={checkingCmp} />
        <Tile label="Card Balance" value={fmtCurrency(b.creditOwed)} sub={b.creditPending ? `+${fmtCurrency(b.creditPending)} pending` : 'Owed'} color="#8b5cf6" chips={[...cardCmp, ...cardChips]} />
        <Tile label="Net Position" value={fmtCurrency(b.netPosition)} sub="Cash − card" color="#3b82f6" chips={netCmp} />
        <Tile
          label="Runway"
          value={data.burn.runwayMonths === null ? 'Profitable' : `${data.burn.runwayMonths.toFixed(1)} mo`}
          sub={data.burn.runwayMonths === null ? `Burn ${fmtK(data.burn.monthly)}/mo covered` : `Net burn ${fmtK(data.burn.net)}/mo`}
          color={data.burn.runwayMonths !== null && data.burn.runwayMonths < 6 ? '#ef4444' : '#22c55e'}
          chips={runwayChips}
        />
        <Tile label="Net Profit MTD" value={fmtCurrency(cur.netProfit)} sub={`In ${fmtK(cur.moneyIn)} · out ${fmtK(cur.expenses)}`} color={cur.netProfit >= 0 ? '#22c55e' : '#ef4444'} chips={[...profitCmp, ...profitChips]} />
        <Tile label="Draws + Personal" value={fmtCurrency(cur.ownerDraws + cur.personal)} sub="This month, not in profit" chips={drawsCmp} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Card title="Warnings" sub={`${data.warnings.length} item${data.warnings.length === 1 ? '' : 's'}`}>
          {data.warnings.length === 0 ? (
            <p className="text-xs text-los-text-muted">All clear.</p>
          ) : (
            <ul className="space-y-2.5 overflow-y-auto max-h-[300px]">
              {data.warnings.map((w: any, i: number) => (
                <li key={i} className="flex gap-2 text-xs text-los-text-secondary leading-relaxed">
                  <span className="w-2 h-2 rounded-full mt-1.5 shrink-0" style={{ background: LEVEL[w.level as keyof typeof LEVEL].dot }} title={LEVEL[w.level as keyof typeof LEVEL].label} />
                  <span>{w.text}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Balances" sub={`Checking vs card owed · last ${range.label} · reconstructed from transactions`} className="lg:col-span-2">
          {chartSummary.length > 0 && (
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] -mt-2 mb-1">
              {chartSummary.map((c) => {
                const d = c.to - c.from
                const pct = c.from > 0 ? Math.round((d / c.from) * 100) : null
                const good = c.good === 'up' ? d >= 0 : d <= 0
                return (
                  <span key={c.name} className="text-los-text-muted">
                    {c.name}{' '}
                    <span className={`font-mono ${Math.abs(d) < 1 ? 'text-los-text-muted' : good ? 'text-los-green' : 'text-los-red'}`}>
                      {d >= 0 ? '+' : '−'}{fmtK(Math.abs(d))}{pct !== null ? ` / ${d >= 0 ? '+' : '−'}${Math.abs(pct)}%` : ''}
                    </span>
                  </span>
                )
              })}
            </div>
          )}
          <div className="mt-6">
            <MultiLineChart
              data={series.map((d) => ({ label: d.date.slice(5), checking: d.checking, credit: d.credit, warChest: d.warChest }))}
              series={[
                { key: 'checking', name: 'Checking', color: '#3b82f6' },
                { key: 'credit', name: 'Card owed', color: '#8b5cf6' },
                { key: 'warChest', name: 'Net', color: '#22c55e' },
              ]}
              height={200}
              format={fmtK}
            />
          </div>
        </Card>
      </div>

      <Card title="Month by month" sub={`Money in vs business expenses · last ${range.label} + this month · line = net profit (excludes transfers, owner draws, personal)`}>
        <div className="mt-4">
          <StackedForecast
            data={shownMonths.map((m: any) => ({ ...m, other: m.moneyIn - m.smsIn }))}
            series={[
              { key: 'other', name: 'Income', color: '#3b82f6' },
              { key: 'smsIn', name: 'SMS payouts', color: '#f59e0b' },
            ]}
            line={{ key: 'netProfit', name: 'Net profit', color: '#e5e7eb' }}
            height={200}
            format={fmtK}
          />
        </div>
        <div className="overflow-x-auto mt-5">
          <table className="w-full text-xs min-w-[640px]">
            <thead>
              <tr className="text-los-text-muted text-left">
                <th className="font-medium py-1.5 pr-3">Month</th>
                <th className="font-medium py-1.5 px-2 text-right">Money in</th>
                <th className="font-medium py-1.5 px-2 text-right">Expenses</th>
                <th className="font-medium py-1.5 px-2 text-right">Net profit</th>
                <th className="font-medium py-1.5 px-2 text-right">Margin</th>
                <th className="font-medium py-1.5 px-2 text-right">Draws</th>
                <th className="font-medium py-1.5 px-2 text-right">Personal</th>
                <th className="font-medium py-1.5 pl-2 text-right">Cash change</th>
              </tr>
            </thead>
            <tbody>
              {[...shownMonths].reverse().map((m: any, i: number) => (
                <tr key={m.month} className="border-t border-los-border">
                  <td className="py-1.5 pr-3 text-los-text-secondary">{m.label}{i === 0 ? ' (MTD)' : ''}</td>
                  <td className="py-1.5 px-2 text-right font-mono text-los-text">{fmtCurrency(m.moneyIn)}</td>
                  <td className="py-1.5 px-2 text-right font-mono text-los-text">{fmtCurrency(m.expenses)}</td>
                  <td className={`py-1.5 px-2 text-right font-mono ${m.netProfit >= 0 ? 'text-los-green' : 'text-los-red'}`}>{fmtCurrency(m.netProfit)}</td>
                  <td className="py-1.5 px-2 text-right font-mono text-los-text-muted">{m.moneyIn > 0 ? `${m.netMargin.toFixed(0)}%` : '—'}</td>
                  <td className="py-1.5 px-2 text-right font-mono text-los-text-muted">{fmtCurrency(m.ownerDraws)}</td>
                  <td className="py-1.5 px-2 text-right font-mono text-los-text-muted">{fmtCurrency(m.personal)}</td>
                  <td className={`py-1.5 pl-2 text-right font-mono ${m.cashChange >= 0 ? 'text-los-text' : 'text-los-red'}`}>{fmtCurrency(m.cashChange)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Expenses by category" sub="Business spend this month vs 3-month average · excludes transfers, owner draws, personal">
        <ExpenseControls rows={data.expenseRows} />
      </Card>

      <Card title="Recent transactions" sub="Last 30 across checking, savings and card">
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[560px]">
            <thead>
              <tr className="text-los-text-muted text-left">
                <th className="font-medium py-1.5 pr-3">Date</th>
                <th className="font-medium py-1.5 px-2">Counterparty</th>
                <th className="font-medium py-1.5 px-2">Type</th>
                <th className="font-medium py-1.5 px-2">Account</th>
                <th className="font-medium py-1.5 pl-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((t: any) => (
                <tr key={t.id} className="border-t border-los-border">
                  <td className="py-1.5 pr-3 text-los-text-muted whitespace-nowrap">{t.date.slice(5)}</td>
                  <td className="py-1.5 px-2">
                    <p className="text-los-text truncate max-w-[240px]">{t.name}</p>
                    <p className="text-[10px] text-los-text-muted">{t.category}{t.status === 'pending' ? ' · pending' : ''}</p>
                  </td>
                  <td className="py-1.5 px-2 text-los-text-secondary">
                    <span className="inline-flex items-center gap-1 flex-wrap">
                      {TYPE_LABEL[t.type] || t.type}
                      {t.amount <= -1000 && t.type !== 'transfer' && <Chips chips={[{ tone: 'amber', text: 'Large' }]} />}
                      {newNames.has(t.name) && t.amount < 0 && <Chips chips={[{ tone: 'amber', text: 'New merchant' }]} />}
                    </span>
                  </td>
                  <td className="py-1.5 px-2 text-los-text-secondary">{t.account}</td>
                  <td className={`py-1.5 pl-2 text-right font-mono whitespace-nowrap ${t.amount > 0 ? 'text-los-green' : 'text-los-text'}`}>
                    {t.amount > 0 ? '+' : ''}{fmtCents(t.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  )
}
