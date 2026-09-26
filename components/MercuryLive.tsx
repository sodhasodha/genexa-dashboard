'use client'

import { useEffect, useState } from 'react'
import { MultiLineChart, StackedForecast, TimeRange } from '@/components/Charts'
import { monthLabel } from '@/lib/forecast'

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

function Tile({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="los-card p-4">
      <p className="los-label">{label}</p>
      <p className="los-metric-number mt-1" style={color ? { color } : undefined}>{value}</p>
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
  const [range, setRange] = useState(180)
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
    fetch(`/api/finance/series?days=${range}`)
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
  const catMax = Math.max(...data.topCategories.map((c: any) => c.amount), 1)

  return (
    <>
      <div className="flex items-center justify-between -mb-1">
        <p className="los-label">Live from Mercury · {new Date(data.asOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</p>
        <button onClick={load} disabled={loading} className="text-[11px] text-los-accent hover:underline disabled:opacity-50">
          {loading ? '…' : 'Refresh'}
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <Tile label="Checking" value={fmtCurrency(b.checking)} sub={b.savings ? `Savings ${fmtCurrency(b.savings)}` : 'Available'} />
        <Tile label="Card Balance" value={fmtCurrency(b.creditOwed)} sub={b.creditPending ? `+${fmtCurrency(b.creditPending)} pending` : 'Owed'} color="#8b5cf6" />
        <Tile label="Net Position" value={fmtCurrency(b.netPosition)} sub="Cash − card" color="#3b82f6" />
        <Tile
          label="Runway"
          value={data.burn.runwayMonths === null ? 'Profitable' : `${data.burn.runwayMonths.toFixed(1)} mo`}
          sub={data.burn.runwayMonths === null ? `Burn ${fmtK(data.burn.monthly)}/mo covered` : `Net burn ${fmtK(data.burn.net)}/mo`}
          color={data.burn.runwayMonths !== null && data.burn.runwayMonths < 6 ? '#ef4444' : '#22c55e'}
        />
        <Tile label="Net Profit MTD" value={fmtCurrency(cur.netProfit)} sub={`In ${fmtK(cur.moneyIn)} · out ${fmtK(cur.expenses)}`} color={cur.netProfit >= 0 ? '#22c55e' : '#ef4444'} />
        <Tile label="Draws + Personal" value={fmtCurrency(cur.ownerDraws + cur.personal)} sub="This month, not in profit" />
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
        <Card title="Balances" sub="Checking vs card owed · reconstructed from transactions" right={<TimeRange value={range} onChange={setRange} />} className="lg:col-span-2">
          <div className="mt-4">
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

      <Card title="Month by month" sub="Money in vs business expenses · line = net profit (excludes transfers, owner draws, personal)">
        <div className="mt-4">
          <StackedForecast
            data={monthly.map((m: any) => ({ ...m, other: m.moneyIn - m.smsIn }))}
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
              {[...monthly].reverse().map((m: any, i: number) => (
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card title="Top expenses" sub="This month, by merchant">
          {data.topMerchants.length === 0 ? (
            <p className="text-xs text-los-text-muted">No spend yet this month</p>
          ) : (
            <table className="w-full text-xs">
              <tbody>
                {data.topMerchants.map((m: any) => (
                  <tr key={m.name} className="border-t border-los-border first:border-t-0">
                    <td className="py-1.5 pr-3">
                      <p className="text-los-text truncate max-w-[220px]">{m.name}</p>
                      <p className="text-[10px] text-los-text-muted">{m.category}{m.count > 1 ? ` · ${m.count} txns` : ''}</p>
                    </td>
                    <td className="py-1.5 text-right font-mono text-los-text">{fmtCurrency(m.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="By category" sub="This month">
          <div className="space-y-2.5">
            {data.topCategories.map((c: any) => (
              <div key={c.category}>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-los-text-secondary">{c.category}</span>
                  <span className="font-mono text-los-text">{fmtCurrency(c.amount)}</span>
                </div>
                <div className="h-1.5 rounded-full bg-los-surface-2 overflow-hidden">
                  <div className="h-full rounded-full bg-los-red" style={{ width: `${(Math.max(c.amount, 0) / catMax) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

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
                  <td className="py-1.5 px-2 text-los-text-secondary">{TYPE_LABEL[t.type] || t.type}</td>
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
