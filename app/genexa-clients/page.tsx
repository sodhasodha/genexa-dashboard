'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { Sparkline } from '@/components/Charts'
import { Chip, Tone } from '@/components/finance/Chip'
import type { AccountState, ClinicReport, ClinicsResponse, Kpi, KpiKey, Status, WindowKey } from '@/lib/clinics/types'

const WINDOWS: { key: WindowKey; label: string }[] = [
  { key: 'mtd', label: 'Month to date' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
]
const WINDOW_STORE = 'clinics-window-v2' // v2: default moved to MTD

// Core KPIs first, then the extras.
const COLUMNS: KpiKey[] = [
  'confirmedPerWeek',
  'cpl',
  'bookingRate',
  'confirmationRate',
  'closeRate',
  'spendPerDay',
  'costPerConfirmed',
  'ctr',
  'clickToLead',
  'pickupRate',
  'leadToSale',
  'roas',
  'revenue',
  'hoursSinceLead',
  'hoursSinceSpend',
]
const CORE = new Set<KpiKey>(['cpl', 'bookingRate', 'confirmationRate', 'closeRate', 'spendPerDay'])

const TONE: Record<Status, Tone> = { green: 'green', amber: 'amber', red: 'red', grey: 'muted' }
const PILL: Record<Status, string> = { green: 'At KPI', amber: 'Close', red: 'Off KPI', grey: 'No data' }
const RANK: Record<Status, number> = { red: 0, amber: 1, green: 2, grey: 3 }

const fmtMoney = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

type SortKey = 'worst' | 'name' | 'pod' | KpiKey
type Sort = { key: SortKey; dir: 1 | -1 }

function sortClinics(list: ClinicReport[], sort: Sort): ClinicReport[] {
  const out = [...list]
  out.sort((a, b) => {
    if (sort.key === 'worst') return (b.worst - a.worst) * sort.dir
    if (sort.key === 'name' || sort.key === 'pod') return a[sort.key].localeCompare(b[sort.key]) * sort.dir || a.name.localeCompare(b.name)
    const ka = a.kpis[sort.key]
    const kb = b.kpis[sort.key]
    // dir 1 = worst first: status, then value (nulls last).
    const r = RANK[ka.status] - RANK[kb.status]
    if (r) return r * sort.dir
    return ((ka.value ?? 0) - (kb.value ?? 0)) * sort.dir
  })
  return out
}

function StatusPill({ status }: { status: Status }) {
  return <Chip tone={TONE[status]}>{PILL[status]}</Chip>
}

const ACCOUNT_TONE: Record<AccountState, Tone> = {
  active: 'green',
  disabled: 'red',
  payment_issue: 'red',
  closed: 'red',
  no_active_campaigns: 'amber',
  campaign_paused: 'amber',
  not_delivering: 'amber',
}

// One chip per bound ad account — says why a clinic is at $0 instead of a bare "Off KPI".
function Accounts({ c }: { c: ClinicReport }) {
  if (!c.raw.bound) return <Chip tone="muted">Not bound</Chip>
  return (
    <span className="flex flex-col items-start gap-0.5">
      {c.raw.accounts.map((a) => (
        <Chip key={a.accountId} tone={ACCOUNT_TONE[a.state]} title={`${a.name} (act_${a.accountId}) — ${a.detail}`}>
          {a.label}
          {c.raw.accounts.length > 1 ? ` · ${a.name}` : ''}
        </Chip>
      ))}
    </span>
  )
}

function Dot({ ok, label, title }: { ok: boolean; label: string; title: string }) {
  return (
    <span className="whitespace-nowrap" title={title}>
      <span className={ok ? 'text-los-green' : 'text-los-red'}>{ok ? '●' : '○'}</span> {label}
    </span>
  )
}
const clock = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '—')

// Is each source feeding this clinic, and when did we last pull it?
function Health({ c }: { c: ClinicReport }) {
  const h = c.health
  return (
    <div className="flex flex-col gap-0.5 text-[10px] text-los-text-secondary">
      <Dot ok={h.meta} label="Meta" title={h.meta ? 'Cortana returned ad data for a bound campaign' : 'No ad data from Cortana for any bound campaign in the last 60 days'} />
      <Dot ok={h.crm} label="GHL" title={h.crm ? `Last CRM event in Cortana: ${new Date(h.lastEventAt!).toLocaleString('en-US')}` : 'No CRM events in Cortana in the last 9 weeks'} />
      <Dot ok={h.revenue} label="Revenue" title={h.revenue ? 'Closes are being logged in Cortana' : 'No closes logged in Cortana in the last 9 weeks — revenue not tracked'} />
      <span className="text-los-text-muted whitespace-nowrap">Synced {clock(h.syncedAt)}</span>
    </div>
  )
}

function KpiCell({ k }: { k: Kpi }) {
  return (
    <td className="py-2 px-2 align-top whitespace-nowrap" title={k.note}>
      <div className={`font-mono text-xs ${k.status === 'grey' ? 'text-los-text-muted' : 'text-los-text'}`}>
        {k.error ? <span className="text-los-red">Data error</span> : k.display}
        {k.note && k.status !== 'grey' && <span className="text-los-text-muted">*</span>}
      </div>
      <div className="mt-0.5">{k.error ? <Chip tone="red">Over 100%</Chip> : <StatusPill status={k.status} />}</div>
    </td>
  )
}

// Change vs the prior period. `lowerIsBetter` flips the colour (CPL).
function Trend({ now, before, lowerIsBetter }: { now: number | null; before: number | null | undefined; lowerIsBetter?: boolean }) {
  if (now === null || before === null || before === undefined) return <span className="text-los-text-muted">No prior data</span>
  if (before === 0) return <span className="text-los-text-muted">{now === 0 ? 'Flat' : 'Prior period was 0'}</span>
  const change = ((now - before) / before) * 100
  if (Math.abs(change) < 0.5) return <span className="text-los-text-muted">Flat</span>
  const good = lowerIsBetter ? change < 0 : change > 0
  return (
    <span className={good ? 'text-los-green' : 'text-los-red'}>
      {change > 0 ? '▲' : '▼'} {Math.abs(change).toFixed(Math.abs(change) < 10 ? 1 : 0)}%
    </span>
  )
}

// Every card prints the active window; `trend` compares against the prior period.
function Stat({ label, value, sub, color, window, trend, prevLabel }: { label: string; value: string; sub?: string; color?: string; window: string; trend?: React.ReactNode; prevLabel?: string }) {
  return (
    <div className="los-card p-4 min-w-0">
      <p className="los-label">{label}</p>
      <p className="los-metric-number mt-1 truncate" style={color ? { color } : undefined}>
        {value}
      </p>
      {sub && (
        <p className="text-[11px] text-los-text-muted mt-1 truncate" title={sub}>
          {sub}
        </p>
      )}
      {trend && (
        <p className="text-[11px] mt-1 truncate">
          {trend} <span className="text-los-text-muted">vs {prevLabel}</span>
        </p>
      )}
      <p className="text-[10px] text-los-text-muted mt-1 truncate">{window}</p>
    </div>
  )
}

function Funnel({ c }: { c: ClinicReport }) {
  return (
    <div className="flex items-stretch gap-1.5 flex-wrap">
      {c.funnel.map((s, i) => (
        <Fragment key={s.label}>
          {i > 0 && <span className="self-center text-los-text-muted text-xs">→</span>}
          <div className="rounded-lg bg-los-surface-2 px-3 py-2 min-w-[72px]">
            <p className="los-label leading-tight">{s.label}</p>
            <p className="font-mono text-base font-semibold text-los-text">{s.value === null ? '—' : s.value}</p>
            <p className={`text-[10px] ${s.error ? 'text-los-red' : 'text-los-text-muted'}`}>
              {s.value === null ? 'Not tracked' : i === 0 ? ' ' : s.error ? 'Data error: over 100%' : s.pct === null ? `Not tracked ÷ ${s.of}` : `${Math.round(s.pct)}% of ${s.of}`}
            </p>
          </div>
        </Fragment>
      ))}
    </div>
  )
}

function Detail({ c, label, prevLabel }: { c: ClinicReport; label: string; prevLabel: string }) {
  const spend = c.daily.map((d) => d.spend)
  const leads = c.daily.map((d) => d.leads)
  const greys = COLUMNS.map((k) => c.kpis[k]).filter((k) => k.status === 'grey')
  const flagged = COLUMNS.map((k) => c.kpis[k]).filter((k) => k.status !== 'grey' && k.note)
  const bad = c.problem.startsWith('On ') ? 'text-los-green' : 'text-los-amber'
  return (
    <div className="flex flex-col gap-4 py-3 px-1">
      <p className={`text-sm font-medium ${bad}`}>{c.problem}</p>
      <p className="text-[11px] text-los-text-muted">
        {label}
        {c.prev && (
          <>
            {' · '}Spend {fmtMoney(c.raw.spend)} (<Trend now={c.raw.spend} before={c.prev.spend} />) · Leads {c.raw.leads} (<Trend now={c.raw.leads} before={c.prev.leads} />) · Confirmed{' '}
            {Math.max(c.raw.confirmed, c.raw.shown)} (<Trend now={Math.max(c.raw.confirmed, c.raw.shown)} before={c.prev.confirmed} />) vs {prevLabel}
          </>
        )}
      </p>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 flex flex-col gap-2">
          <p className="los-label">Funnel</p>
          <Funnel c={c} />
        </div>
        <div className="flex flex-col gap-2">
          <p className="los-label">Daily spend & leads</p>
          {c.daily.length > 1 ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <span className="text-[11px] text-los-text-muted w-12">Spend</span>
                <Sparkline data={spend} width={180} height={28} color="#3b82f6" />
                <span className="font-mono text-[11px] text-los-text">{fmtMoney(spend.reduce((a, b) => a + b, 0))}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[11px] text-los-text-muted w-12">Leads</span>
                <Sparkline data={leads} width={180} height={28} color="#22c55e" />
                <span className="font-mono text-[11px] text-los-text">{leads.reduce((a, b) => a + b, 0)}</span>
              </div>
              <p className="text-[10px] text-los-text-muted">
                {c.daily[0].date} → {c.daily[c.daily.length - 1].date}
              </p>
            </div>
          ) : (
            <p className="text-xs text-los-text-muted">No daily data</p>
          )}
        </div>
      </div>
      {(c.notes.length > 0 || flagged.length > 0 || greys.length > 0 || c.slack) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-[11px]">
          <div className="flex flex-col gap-1">
            <p className="los-label">Notes</p>
            {c.notes.map((n) => (
              <p key={n} className="text-los-amber">• {n}</p>
            ))}
            {flagged.map((k) => (
              <p key={k.key} className="text-los-text-secondary">
                • {k.label}: {k.note}
              </p>
            ))}
            {c.slack && (
              <p className="text-los-text-secondary">
                • Slack booking posts:{' '}
                {c.slack.connected ? `${c.slack.allBookings} patients booked · ${c.slack.confirmedPatients} confirmed` : c.slack.error || 'not connected'}
              </p>
            )}
            {!c.notes.length && !flagged.length && !c.slack && <p className="text-los-text-muted">None</p>}
          </div>
          {greys.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="los-label">Missing data</p>
              {greys.map((k) => (
                <p key={k.key} className="text-los-text-muted">
                  • {k.label}: {k.note}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function GenexaClientsPage() {
  const [win, setWin] = useState<WindowKey>('mtd')
  const [data, setData] = useState<ClinicsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<Sort>({ key: 'worst', dir: 1 })
  const [open, setOpen] = useState<string | null>(null)
  const [mock, setMock] = useState(false)

  const load = async (w: WindowKey, fresh = false) => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ window: w, ...(mock ? { mock: '1' } : {}), ...(fresh ? { fresh: '1' } : {}) })
      const res = await fetch(`/api/clinics/kpis?${qs}`)
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
    try {
      const saved = localStorage.getItem(WINDOW_STORE) as WindowKey | null
      if (saved && WINDOWS.some((w) => w.key === saved)) setWin(saved)
    } catch {}
    setMock(new URLSearchParams(window.location.search).get('mock') === '1')
  }, [])
  useEffect(() => {
    load(win)
  }, [win, mock])
  const pickWindow = (w: WindowKey) => {
    setWin(w)
    try {
      localStorage.setItem(WINDOW_STORE, w)
    } catch {}
  }

  const clinics = useMemo(() => (data ? sortClinics(data.clinics.filter((c) => c.live), sort) : []), [data, sort])
  const notLive = useMemo(() => (data ? data.clinics.filter((c) => !c.live).sort((a, b) => a.name.localeCompare(b.name)) : []), [data])
  const clickSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }))
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === 1 ? ' ↓' : ' ↑') : '')
  const s = data?.summary

  return (
    <div className="px-4 sm:px-6 py-5 max-w-[1400px] mx-auto flex flex-col gap-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-los-text tracking-tight flex items-center gap-2">
            Genexa Clients {data?.mock && <Chip tone="amber">Mock data</Chip>}
          </h1>
          <p className="text-xs text-los-text-muted mt-0.5">
            Cortana {data?.sources.cortana ?? '…'} · Slack bookings {data?.sources.slack ?? '…'}
            {data?.generatedAt ? ` · updated ${new Date(data.generatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}
          </p>
        </div>
        <button onClick={() => load(win, true)} disabled={loading} className="los-btn los-btn-ghost">
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <div className="flex items-center gap-0.5 bg-los-surface-2 rounded-lg p-0.5 self-start max-w-full overflow-x-auto">
        {WINDOWS.map((w) => (
          <button
            key={w.key}
            onClick={() => pickWindow(w.key)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition ${win === w.key ? 'bg-los-accent text-white' : 'text-los-text-muted hover:text-los-text'}`}
          >
            {w.label}
          </button>
        ))}
      </div>

      {error && <div className="los-card p-3 text-xs text-los-red">Couldn&apos;t load clinic KPIs: {error}</div>}
      {!data && loading && <div className="los-card p-8 text-center text-xs text-los-text-muted">Loading clinic KPIs…</div>}

      {data && s && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
            <Stat
              label="Clinics at KPI"
              value={`${s.atKpi} of ${s.total}`}
              sub="≥3 confirmed/wk + 4 of 5 core green"
              color={s.total > 0 && s.atKpi === s.total ? '#22c55e' : s.total > 0 && s.atKpi / s.total >= 0.5 ? '#f59e0b' : '#ef4444'}
              window={data.label}
            />
            <Stat label="Total spend" value={fmtMoney(s.spend)} sub={`${fmtMoney(s.spend / data.days)}/day`} window={data.label} trend={<Trend now={s.spend} before={s.prev.spend} />} prevLabel={data.prevLabel} />
            <Stat label="Total leads" value={String(s.leads)} window={data.label} trend={<Trend now={s.leads} before={s.prev.leads} />} prevLabel={data.prevLabel} />
            <Stat
              label="Confirmed appts"
              value={String(s.confirmed)}
              sub={`${(s.confirmed / (data.days / 7)).toFixed(1)}/wk across book`}
              window={data.label}
              trend={<Trend now={s.confirmed} before={s.prev.confirmed} />}
              prevLabel={data.prevLabel}
            />
            <Stat
              label="Blended CPL"
              value={s.cpl === null ? '—' : `$${s.cpl.toFixed(2)}`}
              sub="Target ≤$25"
              color={s.cpl === null ? undefined : s.cpl <= 25 ? '#22c55e' : s.cpl <= 30 ? '#f59e0b' : '#ef4444'}
              window={data.label}
              trend={<Trend now={s.cpl} before={s.prev.cpl} lowerIsBetter />}
              prevLabel={data.prevLabel}
            />
            <Stat
              label="Blended ROAS"
              value={s.roasHidden ? 'Hidden' : s.roas === null ? '—' : `${s.roas.toFixed(1)}x`}
              sub={s.roasHidden ?? `${s.revenueTracked} clinics tracking closes`}
              color={s.roasHidden || s.roas === null ? undefined : s.roas >= 3 ? '#22c55e' : s.roas >= 2.4 ? '#f59e0b' : '#ef4444'}
              window={data.label}
            />
          </div>

          <p className="los-label">
            Live · {clinics.length} clinics · {data.label}
          </p>
          <div className="los-card p-0 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-[1500px]">
                <thead>
                  <tr className="text-los-text-muted text-left border-b border-los-border">
                    <th className="sticky left-0 z-10 bg-los-surface font-medium py-2 pl-4 pr-2 cursor-pointer select-none" onClick={() => clickSort('name')}>
                      Clinic{arrow('name')}
                    </th>
                    <th className="font-medium py-2 px-2 cursor-pointer select-none" onClick={() => clickSort('pod')}>
                      Pod{arrow('pod')}
                    </th>
                    <th className="font-medium py-2 px-2 cursor-pointer select-none" onClick={() => clickSort('worst')}>
                      Status{arrow('worst')}
                      <span className="block text-[10px] font-normal">KPI · ad account</span>
                    </th>
                    <th className="font-medium py-2 px-2">
                      Data health
                      <span className="block text-[10px] font-normal">sources · last sync</span>
                    </th>
                    {COLUMNS.map((key) => {
                      const k = data.clinics[0]?.kpis[key]
                      return (
                        <th key={key} className="font-medium py-2 px-2 cursor-pointer select-none whitespace-nowrap" onClick={() => clickSort(key)}>
                          <span className={CORE.has(key) ? 'text-los-text-secondary' : ''}>
                            {k?.label ?? key}
                            {arrow(key)}
                          </span>
                          <span className="block text-[10px] font-normal">{k?.targetLabel}</span>
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                <tbody>
                  {clinics.map((c) => (
                    <Fragment key={c.businessId}>
                      <tr onClick={() => setOpen(open === c.businessId ? null : c.businessId)} className="border-t border-los-border cursor-pointer hover:bg-los-surface-2/50 transition">
                        <td className="sticky left-0 z-10 bg-los-surface py-2 pl-4 pr-2 align-top min-w-[150px] max-w-[190px]">
                          <p className="text-los-text font-medium leading-tight">
                            <span className="text-los-text-muted mr-1">{open === c.businessId ? '▾' : '▸'}</span>
                            {c.name}
                          </p>
                        </td>
                        <td className="py-2 px-2 align-top text-los-text-secondary whitespace-nowrap">{c.pod}</td>
                        <td className="py-2 px-2 align-top whitespace-nowrap">
                          {c.raw.dataError ? (
                            <Chip tone="red" title={c.raw.dataError}>
                              Data error: duplicate source
                            </Chip>
                          ) : c.raw.error ? (
                            <Chip tone="muted">No data</Chip>
                          ) : c.atKpi ? (
                            <Chip tone="green">At KPI</Chip>
                          ) : c.raw.spend > 0 ? (
                            <Chip tone="red">Off KPI</Chip>
                          ) : null}
                          {!c.raw.error && !c.raw.dataError && <p className="text-[10px] text-los-text-muted my-0.5">{c.coreGreen}/5 core</p>}
                          <Accounts c={c} />
                        </td>
                        <td className="py-2 px-2 align-top">
                          <Health c={c} />
                        </td>
                        {COLUMNS.map((key) => (
                          <KpiCell key={key} k={c.kpis[key]} />
                        ))}
                      </tr>
                      {open === c.businessId && (
                        <tr className="bg-los-surface-3">
                          <td colSpan={COLUMNS.length + 4} className="px-4">
                            <div className="sticky left-4 w-[calc(100vw-4.5rem)] md:w-[calc(100vw-14rem-5.5rem)] max-w-[1300px]">
                              <Detail c={c} label={data.label} prevLabel={data.prevLabel} />
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
          {notLive.length > 0 && (
            <>
              <p className="los-label">Not launched / no ad account bound · {notLive.length}</p>
              <div className="los-card p-0 overflow-hidden">
                <table className="w-full text-xs">
                  <tbody>
                    {notLive.map((c) => (
                      <tr key={c.businessId} className="border-t first:border-t-0 border-los-border">
                        <td className="py-2 pl-4 pr-2 text-los-text font-medium">{c.name}</td>
                        <td className="py-2 px-2 text-los-text-secondary whitespace-nowrap">{c.pod}</td>
                        <td className="py-2 px-2 whitespace-nowrap">
                          {c.raw.bound ? <Chip tone="muted">Not launched</Chip> : null}
                          <Accounts c={c} />
                        </td>
                        <td className="py-2 px-2 pr-4 text-los-text-muted">
                          {c.raw.bound ? 'Bound, but no spend, leads or CRM activity in the last 60 days' : 'No ad account binding — add it in lib/clinics/bindings.ts'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <p className="text-[10px] text-los-text-muted">
            Tap a clinic for its funnel, daily trend and biggest problem. * = value has a note (hover). Grey = source not connected or event not tracked, never zero. Account disabled / payment issue / closed come from Cortana's account list as of the date in lib/clinics/bindings.ts; campaign states are live. Slack
            booking posts cross-check confirmations; pickups aren&apos;t posted in Slack. Every number is for {data.label} (UTC days) unless it says otherwise; trends compare against {data.prevLabel}. Last lead / last spend are day-level over a 60-day lookback. Rates: booked ÷ leads, confirmed ÷ booked, showed ÷ booked, closed ÷ showed. Data refreshes every 15 min. Targets live in
            lib/clinics/config.ts.
          </p>
        </>
      )}
    </div>
  )
}
