'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { MorningCheckInModal, EodLogModal } from '@/components/CheckInModals'
import { Sparkline, TrendPill, LineChart } from '@/components/Charts'
import {
  getClientTracker,
  getLogStreak,
  getTasks,
  getClients,
  getDailyHabits,
  setDailyHabits,
} from '@/lib/storage'
import { Task, CRMClient } from '@/lib/types'

const HABITS: { key: 'gym' | 'eatHealthy' | 'deepWork' | 'eodDone'; label: string }[] = [
  { key: 'gym', label: 'Gym' },
  { key: 'eatHealthy', label: 'Eat Healthy' },
  { key: 'deepWork', label: 'Deep Work' },
  { key: 'eodDone', label: 'EOD Done' },
]
type HabitState = { gym: boolean; eatHealthy: boolean; deepWork: boolean; eodDone: boolean }

const fmtCurrency = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const fmtK = (n: number) => (Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(0)}`)

export default function HomePage() {
  const today = new Date().toISOString().split('T')[0]

  const [checkingBalance, setCheckingBalance] = useState(0)
  const [creditBalance, setCreditBalance] = useState(0)
  const [whopMTD, setWhopMTD] = useState<number | null>(null)
  const [revSeries, setRevSeries] = useState<{ date: string; revenue: number }[]>([])
  const [balanceTrend, setBalanceTrend] = useState<number[]>([])
  const [financeLoading, setFinanceLoading] = useState(true)
  const [meetings, setMeetings] = useState<any[]>([])
  const [meetingsLoading, setMeetingsLoading] = useState(true)
  const [calendarEvents, setCalendarEvents] = useState<any[]>([])
  const [calendarLoading, setCalendarLoading] = useState(true)
  const [starredTasks, setStarredTasks] = useState<Task[]>([])
  const [habits, setHabits] = useState<HabitState>({ gym: false, eatHealthy: false, deepWork: false, eodDone: false })
  const [activeClients, setActiveClients] = useState(0)
  const [clientGoal, setClientGoal] = useState(10)
  const [logStreak, setLogStreak] = useState(0)

  const [briefingOpen, setBriefingOpen] = useState(false)
  const [briefingText, setBriefingText] = useState('')
  const [briefingLoading, setBriefingLoading] = useState(false)
  const [morningOpen, setMorningOpen] = useState(false)
  const [eodOpen, setEodOpen] = useState(false)
  const [selectedEvent, setSelectedEvent] = useState<any | null>(null)

  const refreshStreak = async () => setLogStreak(await getLogStreak())

  const loadFinance = async () => {
    setFinanceLoading(true)
    try {
      const [mercuryRes, whopRes, txRes] = await Promise.allSettled([
        fetch('/api/mercury/accounts').then((r) => r.json()),
        fetch('/api/whop/revenue').then((r) => r.json()),
        fetch('/api/mercury/transactions').then((r) => r.json()),
      ])
      let checking = 0
      if (mercuryRes.status === 'fulfilled' && mercuryRes.value) {
        checking = mercuryRes.value.checkingBalance ?? 0
        setCheckingBalance(checking)
        setCreditBalance(mercuryRes.value.creditBalance ?? 0)
      }
      if (whopRes.status === 'fulfilled' && whopRes.value) {
        if (typeof whopRes.value.mtdRevenue === 'number') setWhopMTD(whopRes.value.mtdRevenue)
        if (Array.isArray(whopRes.value.series)) setRevSeries(whopRes.value.series)
      }
      // Reconstruct a balance trend from recent transactions (ends at current balance).
      if (txRes.status === 'fulfilled' && Array.isArray(txRes.value?.transactions)) {
        const txs = [...txRes.value.transactions].sort(
          (a, b) => new Date(a.postedAt || a.createdAt).getTime() - new Date(b.postedAt || b.createdAt).getTime()
        )
        const total = txs.reduce((s, t) => s + (t.amount || 0), 0)
        let bal = checking - total
        const trend = [bal]
        for (const t of txs) {
          bal += t.amount || 0
          trend.push(bal)
        }
        setBalanceTrend(trend.length > 1 ? trend : [checking, checking])
      }
    } catch (e) {
      console.error('finance load', e)
    } finally {
      setFinanceLoading(false)
    }
  }

  const loadMeetings = async () => {
    setMeetingsLoading(true)
    try {
      const d = await fetch('/api/meetings').then((r) => r.json())
      if (Array.isArray(d.meetings)) setMeetings(d.meetings)
    } finally {
      setMeetingsLoading(false)
    }
  }
  const loadCalendar = async () => {
    setCalendarLoading(true)
    try {
      const d = await fetch('/api/calendar').then((r) => r.json())
      if (Array.isArray(d.events)) setCalendarEvents(d.events)
    } finally {
      setCalendarLoading(false)
    }
  }

  const toggleHabit = (key: keyof HabitState) => {
    const next = { ...habits, [key]: !habits[key] }
    setHabits(next)
    setDailyHabits(today, { date: today, ...next })
  }

  const runBriefing = async () => {
    setBriefingOpen(true)
    setBriefingLoading(true)
    setBriefingText('')
    try {
      const [tasks, clients] = await Promise.all([getTasks(), getClients()])
      let transactions: any[] = []
      try {
        transactions = (await fetch('/api/mercury/transactions').then((r) => r.json())).transactions || []
      } catch {}
      const res = await fetch('/api/briefing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: { balance: checkingBalance, transactions, calendar: calendarEvents, meetings, tasks, clients },
        }),
      })
      if (!res.body) return setBriefingText('No response from briefing service.')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let acc = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        acc += decoder.decode(value, { stream: true })
        setBriefingText(acc)
      }
    } catch (e) {
      setBriefingText('Failed to generate briefing.')
    } finally {
      setBriefingLoading(false)
    }
  }

  useEffect(() => {
    const clientTracker = getClientTracker()
    setClientGoal(clientTracker.goal || 10)

    ;(async () => {
      const [streak, tasks, todayHabits, clients] = await Promise.all([
        getLogStreak(),
        getTasks(),
        getDailyHabits(today),
        getClients(),
      ])
      setLogStreak(streak)
      setStarredTasks(tasks.filter((t) => t.starred && t.col !== 'done'))
      // Live active-client count from the CRM table.
      setActiveClients((clients as CRMClient[]).filter((c) => c.adStatus === 'Active').length)
      if (todayHabits) {
        setHabits({
          gym: todayHabits.gym,
          eatHealthy: todayHabits.eatHealthy,
          deepWork: todayHabits.deepWork,
          eodDone: todayHabits.eodDone,
        })
      }
    })()

    loadFinance()
    loadMeetings()
    loadCalendar()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const clientsRemaining = clientGoal - activeClients
  const habitsDone = HABITS.filter((h) => habits[h.key]).length
  const revLast7 = revSeries.slice(-7).reduce((s, d) => s + d.revenue, 0)
  const revPrev7 = revSeries.slice(-14, -7).reduce((s, d) => s + d.revenue, 0)
  const revTrend = revPrev7 > 0 ? ((revLast7 - revPrev7) / revPrev7) * 100 : 0

  const fmtEventTime = (ev: any) =>
    ev.start?.dateTime
      ? new Date(ev.start.dateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      : 'All day'

  return (
    <div className="px-6 py-5 max-w-[1400px] mx-auto flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-los-text tracking-tight">Good morning, Aryan</h1>
          <p className="text-xs text-los-text-muted mt-0.5">
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setMorningOpen(true)} className="los-btn los-btn-ghost">Morning Check-in</button>
          <button onClick={() => setEodOpen(true)} className="los-btn los-btn-ghost">EOD Log</button>
          <button onClick={runBriefing} className="los-btn los-btn-primary">⚡ Daily Briefing</button>
        </div>
      </div>

      {/* Metric row — dense, with sparklines/trends */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="los-card p-4">
          <div className="flex items-start justify-between">
            <p className="los-label">Checking</p>
          </div>
          <p className="los-metric-number mt-1">{fmtCurrency(checkingBalance)}</p>
          <div className="mt-2 h-7">
            {balanceTrend.length > 1 && <Sparkline data={balanceTrend} width={140} height={28} />}
          </div>
        </div>
        <div className="los-card p-4">
          <div className="flex items-start justify-between">
            <p className="los-label">MTD Revenue</p>
            {revPrev7 > 0 && <TrendPill pct={revTrend} />}
          </div>
          <p className="los-metric-number mt-1">{whopMTD === null ? '—' : fmtCurrency(whopMTD)}</p>
          <div className="mt-2 h-7">
            {revSeries.length > 1 && <Sparkline data={revSeries.slice(-14).map((d) => d.revenue)} width={140} height={28} color="#22c55e" />}
          </div>
        </div>
        <div className="los-card p-4">
          <div className="flex items-start justify-between">
            <p className="los-label">Active Clients</p>
            <span className="text-[11px] text-los-text-muted">live · CRM</span>
          </div>
          <p className="los-metric-number mt-1">
            {activeClients}
            <span className="text-los-text-muted text-base"> / {clientGoal}</span>
          </p>
          <div className="mt-3 h-1.5 rounded-full bg-los-surface-2 overflow-hidden">
            <div className="h-full bg-los-accent rounded-full" style={{ width: `${Math.min((activeClients / clientGoal) * 100, 100)}%` }} />
          </div>
          <p className="text-[11px] text-los-text-muted mt-1.5">
            {clientsRemaining > 0 ? `${clientsRemaining} to goal` : 'Goal reached'}
          </p>
        </div>
        <div className="los-card p-4">
          <p className="los-label">Log Streak</p>
          <p className="los-metric-number mt-1">🔥 {logStreak}d</p>
          <p className="text-[11px] text-los-text-muted mt-2">{habitsDone}/{HABITS.length} habits today</p>
        </div>
      </div>

      {/* Finance Pulse (revenue chart) + Meeting Brief */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2 los-card p-4 flex flex-col">
          <div className="flex justify-between items-center mb-3">
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-semibold text-los-text">Finance Pulse</h2>
              <span className="text-[11px] text-los-text-muted">Whop revenue · 30d</span>
            </div>
            <button onClick={loadFinance} className="text-[11px] text-los-accent hover:underline disabled:opacity-50" disabled={financeLoading}>
              {financeLoading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          <LineChart
            data={revSeries.map((d) => ({ label: d.date.slice(5), value: d.revenue }))}
            height={170}
            format={(v) => fmtK(v)}
            color="#22c55e"
          />
          <div className="grid grid-cols-3 gap-3 mt-4">
            {[
              ['Checking', fmtCurrency(checkingBalance), 'text-los-text'],
              ['Credit Owed', fmtCurrency(creditBalance), 'text-los-amber'],
              ['MTD Revenue', whopMTD === null ? '—' : fmtCurrency(whopMTD), 'text-los-green'],
            ].map(([label, value, cls]) => (
              <div key={label} className="rounded-lg bg-los-surface-2 px-3 py-2.5">
                <p className="los-label mb-1">{label}</p>
                <p className={`font-mono font-semibold text-base ${cls}`}>{value}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Meeting Brief */}
        <div className="los-card p-4 flex flex-col">
          <div className="flex justify-between items-center mb-3">
            <h2 className="text-sm font-semibold text-los-text">Meeting Brief</h2>
            <button onClick={loadMeetings} className="text-[11px] text-los-accent hover:underline disabled:opacity-50" disabled={meetingsLoading}>
              {meetingsLoading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          {meetingsLoading ? (
            <p className="text-xs text-los-text-muted">Loading…</p>
          ) : meetings.length === 0 ? (
            <p className="text-xs text-los-text-muted">No recent meetings</p>
          ) : (
            <div className="space-y-2 flex-1 overflow-y-auto max-h-[260px]">
              {meetings.map((m) => (
                <a key={m.id} href={m.url} target="_blank" rel="noopener noreferrer" className="block rounded-lg bg-los-surface-2 p-2.5 hover:bg-los-surface-3 transition">
                  <p className="text-xs font-medium text-los-text truncate">{m.title}</p>
                  <p className="text-[11px] text-los-text-muted mt-0.5">
                    {new Date(m.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    {m.attendees?.length ? ` · ${m.attendees.join(', ')}` : ''}
                  </p>
                </a>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Habits · Calendar · Key Actions */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="los-card p-4 flex flex-col">
          <h2 className="text-sm font-semibold text-los-text mb-3">Daily Habits</h2>
          <div className="space-y-2 mb-3">
            {HABITS.map((h) => (
              <label key={h.key} className="flex items-center gap-2.5 cursor-pointer">
                <input type="checkbox" className="w-4 h-4 rounded accent-los-accent" checked={habits[h.key]} onChange={() => toggleHabit(h.key)} />
                <span className="text-xs text-los-text">{h.label}</span>
              </label>
            ))}
          </div>
          <div className="mt-auto pt-2.5 border-t border-los-border">
            <p className="los-metric-number text-los-accent text-center text-lg">{habitsDone} / {HABITS.length}</p>
          </div>
        </div>

        <div className="los-card p-4 flex flex-col">
          <div className="flex justify-between items-center mb-3">
            <h2 className="text-sm font-semibold text-los-text">Calendar</h2>
            <button onClick={loadCalendar} className="text-[11px] text-los-accent hover:underline disabled:opacity-50" disabled={calendarLoading}>
              {calendarLoading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          {calendarLoading ? (
            <p className="text-xs text-los-text-muted">Loading…</p>
          ) : calendarEvents.length === 0 ? (
            <p className="text-xs text-los-text-muted">No events today or tomorrow</p>
          ) : (
            <div className="space-y-2 flex-1 overflow-y-auto max-h-[200px]">
              {calendarEvents.map((ev) => (
                <button key={ev.id} onClick={() => setSelectedEvent(ev)} className="w-full text-left rounded-lg bg-los-surface-2 p-2.5 hover:bg-los-surface-3 transition">
                  <p className="text-xs font-medium text-los-text truncate">{ev.summary || '(no title)'}</p>
                  <p className="text-[11px] text-los-text-muted mt-0.5">
                    {new Date(ev.start?.dateTime || ev.start?.date).toLocaleDateString('en-US', { weekday: 'short' })} · {fmtEventTime(ev)}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="los-card p-4 flex flex-col">
          <h2 className="text-sm font-semibold text-los-text mb-3">Key Actions</h2>
          <div className="space-y-1.5 flex-1 overflow-y-auto max-h-[200px]">
            {starredTasks.length === 0 ? (
              <p className="text-xs text-los-text-muted">No starred tasks</p>
            ) : (
              starredTasks.map((t) => (
                <div key={t.id} className="flex items-center gap-2 text-xs text-los-text">
                  <span className="text-los-amber">★</span>
                  <span className="truncate">{t.name}</span>
                </div>
              ))
            )}
          </div>
          <Link href="/tasks" className="text-[11px] text-los-accent hover:underline mt-auto pt-2.5 border-t border-los-border">
            All tasks →
          </Link>
        </div>
      </div>

      {/* Briefing modal */}
      {briefingOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setBriefingOpen(false)}>
          <div className="los-card w-full max-w-2xl max-h-[80vh] flex flex-col p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-3">
              <h2 className="text-sm font-semibold text-los-text">
                ⚡ Daily Briefing {briefingLoading && <span className="text-xs text-los-text-muted">(generating…)</span>}
              </h2>
              <button onClick={() => setBriefingOpen(false)} className="text-los-text-muted hover:text-los-text">✕</button>
            </div>
            <div className="overflow-y-auto flex-1">
              {briefingText ? (
                <pre className="whitespace-pre-wrap font-sans text-xs text-los-text leading-relaxed">{briefingText}</pre>
              ) : (
                <p className="text-xs text-los-text-muted">Gathering context and generating your briefing…</p>
              )}
            </div>
          </div>
        </div>
      )}

      <MorningCheckInModal open={morningOpen} onClose={() => setMorningOpen(false)} onSaved={refreshStreak} />
      <EodLogModal open={eodOpen} onClose={() => setEodOpen(false)} onSaved={refreshStreak} />

      {/* Calendar drawer */}
      {selectedEvent && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={() => setSelectedEvent(null)}>
          <div className="w-full max-w-md h-full bg-los-surface border-l border-los-border shadow-2xl p-6 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start mb-5 gap-4">
              <h2 className="text-base font-semibold text-los-text">{selectedEvent.summary || '(no title)'}</h2>
              <button onClick={() => setSelectedEvent(null)} className="text-los-text-muted hover:text-los-text">✕</button>
            </div>
            <div className="space-y-4">
              <div>
                <p className="los-label mb-1">When</p>
                <p className="text-sm text-los-text">
                  {new Date(selectedEvent.start?.dateTime || selectedEvent.start?.date).toLocaleString('en-US', {
                    weekday: 'long', month: 'short', day: 'numeric',
                    ...(selectedEvent.start?.dateTime ? { hour: 'numeric', minute: '2-digit' } : {}),
                  })}
                  {selectedEvent.end?.dateTime && ` – ${new Date(selectedEvent.end.dateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`}
                </p>
              </div>
              {selectedEvent.location && (
                <div><p className="los-label mb-1">Location</p><p className="text-sm text-los-text">{selectedEvent.location}</p></div>
              )}
              {Array.isArray(selectedEvent.attendees) && selectedEvent.attendees.length > 0 && (
                <div>
                  <p className="los-label mb-1">Attendees</p>
                  <div className="space-y-1">
                    {selectedEvent.attendees.map((a: any, i: number) => (
                      <p key={i} className="text-sm text-los-text">{a.displayName || a.email}</p>
                    ))}
                  </div>
                </div>
              )}
              {selectedEvent.hangoutLink && (
                <a href={selectedEvent.hangoutLink} target="_blank" rel="noopener noreferrer" className="los-btn los-btn-primary inline-block">Join call</a>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
