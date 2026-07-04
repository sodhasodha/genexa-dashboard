'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { MorningCheckInModal, EodLogModal } from '@/components/CheckInModals'
import { Sparkline, TrendPill, LineChart, MultiLineChart, TimeRange } from '@/components/Charts'
import { getClientTracker, getTasks, getClients, getDailyHabits, setDailyHabits } from '@/lib/storage'
import { Task, CRMClient } from '@/lib/types'

const HABITS: { key: 'gym' | 'eatHealthy' | 'deepWork' | 'eodDone'; label: string }[] = [
  { key: 'gym', label: 'Gym' },
  { key: 'eatHealthy', label: 'Eat Healthy' },
  { key: 'deepWork', label: 'Deep Work' },
  { key: 'eodDone', label: 'EOD Done' },
]
type HabitState = { gym: boolean; eatHealthy: boolean; deepWork: boolean; eodDone: boolean }

const fmtCurrency = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const fmtK = (n: number) => (Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(0)}`)

const FINANCE_SERIES = [
  { key: 'checking', name: 'Checking', color: '#3b82f6' },
  { key: 'credit', name: 'Credit Card', color: '#8b5cf6' },
]

export default function HomePage() {
  const today = new Date().toISOString().split('T')[0]

  const [checkingBalance, setCheckingBalance] = useState(0)
  const [creditBalance, setCreditBalance] = useState(0)
  const [whopMTD, setWhopMTD] = useState<number | null>(null)
  const [revSeries, setRevSeries] = useState<number[]>([])
  const [financeRange, setFinanceRange] = useState(30)
  const [financeSeries, setFinanceSeries] = useState<{ date: string; checking: number; credit: number }[]>([])
  const [financeLoading, setFinanceLoading] = useState(true)
  const [scoreRange, setScoreRange] = useState(30)
  const [scoreSeries, setScoreSeries] = useState<{ date: string; score: number }[]>([])
  const [scoreNow, setScoreNow] = useState(0)
  const [weakest, setWeakest] = useState<{ label: string; message: string; value: number } | null>(null)
  const [meetings, setMeetings] = useState<any[]>([])
  const [meetingsLoading, setMeetingsLoading] = useState(true)
  const [calendarEvents, setCalendarEvents] = useState<any[]>([])
  const [calendarLoading, setCalendarLoading] = useState(true)
  const [starredTasks, setStarredTasks] = useState<Task[]>([])
  const [habits, setHabits] = useState<HabitState>({ gym: false, eatHealthy: false, deepWork: false, eodDone: false })
  const [activeClients, setActiveClients] = useState(0)
  const [clientGoal, setClientGoal] = useState(10)

  const [briefingOpen, setBriefingOpen] = useState(false)
  const [briefingText, setBriefingText] = useState('')
  const [briefingLoading, setBriefingLoading] = useState(false)
  const [morningOpen, setMorningOpen] = useState(false)
  const [eodOpen, setEodOpen] = useState(false)
  const [selectedEvent, setSelectedEvent] = useState<any | null>(null)

  const refreshStreak = async () => {
    loadScore(scoreRange)
  }

  const loadBalances = async () => {
    setFinanceLoading(true)
    try {
      const [mercuryRes, whopRes] = await Promise.allSettled([
        fetch('/api/mercury/accounts').then((r) => r.json()),
        fetch('/api/whop/revenue').then((r) => r.json()),
      ])
      if (mercuryRes.status === 'fulfilled' && mercuryRes.value) {
        setCheckingBalance(mercuryRes.value.checkingBalance ?? 0)
        setCreditBalance(mercuryRes.value.creditBalance ?? 0)
      }
      if (whopRes.status === 'fulfilled' && whopRes.value) {
        if (typeof whopRes.value.mtdRevenue === 'number') setWhopMTD(whopRes.value.mtdRevenue)
        if (Array.isArray(whopRes.value.series)) setRevSeries(whopRes.value.series.map((d: any) => d.revenue))
      }
    } finally {
      setFinanceLoading(false)
    }
  }

  const loadFinanceSeries = async (days: number) => {
    try {
      const d = await fetch(`/api/finance/series?days=${days}`).then((r) => r.json())
      if (Array.isArray(d.series)) setFinanceSeries(d.series)
    } catch (e) {
      console.error('finance series', e)
    }
  }

  const loadScore = async (days: number) => {
    try {
      const d = await fetch(`/api/score/series?days=${days}`).then((r) => r.json())
      if (Array.isArray(d.series)) setScoreSeries(d.series)
      if (typeof d.current === 'number') setScoreNow(d.current)
      if (d.weakest) setWeakest(d.weakest)
    } catch (e) {
      console.error('score', e)
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
    setDailyHabits(today, { date: today, ...next }).then(() => loadScore(scoreRange))
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
        body: JSON.stringify({ context: { balance: checkingBalance, transactions, calendar: calendarEvents, meetings, tasks, clients } }),
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
    } catch {
      setBriefingText('Failed to generate briefing.')
    } finally {
      setBriefingLoading(false)
    }
  }

  useEffect(() => {
    setClientGoal(getClientTracker().goal || 10)
    ;(async () => {
      const [tasks, todayHabits, clients] = await Promise.all([getTasks(), getDailyHabits(today), getClients()])
      setStarredTasks(tasks.filter((t) => t.starred && t.col !== 'done'))
      setActiveClients((clients as CRMClient[]).filter((c) => c.adStatus === 'Active').length)
      if (todayHabits) setHabits({ gym: todayHabits.gym, eatHealthy: todayHabits.eatHealthy, deepWork: todayHabits.deepWork, eodDone: todayHabits.eodDone })
    })()
    loadBalances()
    loadMeetings()
    loadCalendar()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    setFinanceLoading(true)
    loadFinanceSeries(financeRange).finally(() => setFinanceLoading(false))
  }, [financeRange])
  useEffect(() => {
    loadScore(scoreRange)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoreRange])

  const clientsRemaining = clientGoal - activeClients
  const habitsDone = HABITS.filter((h) => habits[h.key]).length
  const revLast7 = revSeries.slice(-7).reduce((s, v) => s + v, 0)
  const revPrev7 = revSeries.slice(-14, -7).reduce((s, v) => s + v, 0)
  const revTrend = revPrev7 > 0 ? ((revLast7 - revPrev7) / revPrev7) * 100 : 0

  // Meeting Brief: last 3 days only, action items grouped by meeting.
  const cutoff = Date.now() - 3 * 86400000
  const recentMeetings = meetings.filter((m) => new Date(m.date).getTime() >= cutoff)

  const fmtEventTime = (ev: any) =>
    ev.start?.dateTime ? new Date(ev.start.dateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : 'All day'

  return (
    <div className="px-6 py-5 max-w-[1400px] mx-auto flex flex-col gap-4">
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

      {/* Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="los-card p-4">
          <p className="los-label">Checking</p>
          <p className="los-metric-number mt-1">{fmtCurrency(checkingBalance)}</p>
          <div className="mt-2 h-7">{financeSeries.length > 1 && <Sparkline data={financeSeries.map((d) => d.checking)} width={140} height={28} />}</div>
        </div>
        <div className="los-card p-4">
          <div className="flex items-start justify-between">
            <p className="los-label">MTD Revenue</p>
            {revPrev7 > 0 && <TrendPill pct={revTrend} />}
          </div>
          <p className="los-metric-number mt-1">{whopMTD === null ? '—' : fmtCurrency(whopMTD)}</p>
          <div className="mt-2 h-7">{revSeries.length > 1 && <Sparkline data={revSeries.slice(-14)} width={140} height={28} color="#22c55e" />}</div>
        </div>
        <div className="los-card p-4">
          <div className="flex items-start justify-between">
            <p className="los-label">Active Clients</p>
            <span className="text-[11px] text-los-text-muted">live · CRM</span>
          </div>
          <p className="los-metric-number mt-1">{activeClients}<span className="text-los-text-muted text-base"> / {clientGoal}</span></p>
          <div className="mt-3 h-1.5 rounded-full bg-los-surface-2 overflow-hidden">
            <div className="h-full bg-los-accent rounded-full" style={{ width: `${Math.min((activeClients / clientGoal) * 100, 100)}%` }} />
          </div>
          <p className="text-[11px] text-los-text-muted mt-1.5">{clientsRemaining > 0 ? `${clientsRemaining} to goal` : 'Goal reached'}</p>
        </div>
        <div className="los-card p-4">
          <p className="los-label">Personal Score</p>
          <p className="los-metric-number mt-1" style={{ color: '#8b5cf6' }}>{scoreNow}<span className="text-los-text-muted text-base">/100</span></p>
          <div className="mt-2 h-7">{scoreSeries.length > 1 && <Sparkline data={scoreSeries.map((d) => d.score)} width={140} height={28} color="#8b5cf6" />}</div>
        </div>
      </div>

      {/* Finance dual-line chart + Meeting Brief */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2 los-card p-4 flex flex-col">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-sm font-semibold text-los-text">Finance</h2>
            <div className="flex items-center gap-2">
              {financeLoading && <span className="text-[11px] text-los-text-muted">…</span>}
              <TimeRange value={financeRange} onChange={setFinanceRange} />
            </div>
          </div>
          <MultiLineChart data={financeSeries.map((d) => ({ label: d.date.slice(5), checking: d.checking, credit: d.credit }))} series={FINANCE_SERIES} height={180} format={(v) => fmtK(v)} />
          <div className="grid grid-cols-3 gap-3 mt-4">
            {[
              ['Checking', fmtCurrency(checkingBalance), 'text-los-text'],
              ['Credit Owed', fmtCurrency(creditBalance), '', '#8b5cf6'],
              ['MTD Revenue', whopMTD === null ? '—' : fmtCurrency(whopMTD), 'text-los-green'],
            ].map(([label, value, cls, color]) => (
              <div key={label as string} className="rounded-lg bg-los-surface-2 px-3 py-2.5">
                <p className="los-label mb-1">{label}</p>
                <p className={`font-mono font-semibold text-base ${cls}`} style={color ? { color: color as string } : undefined}>{value}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Meeting Brief — last 3 days, action items grouped */}
        <div className="los-card p-4 flex flex-col">
          <div className="flex justify-between items-center mb-3">
            <div>
              <h2 className="text-sm font-semibold text-los-text">Meeting Brief</h2>
              <p className="text-[11px] text-los-text-muted">Action items · last 3 days</p>
            </div>
            <button onClick={loadMeetings} className="text-[11px] text-los-accent hover:underline disabled:opacity-50" disabled={meetingsLoading}>
              {meetingsLoading ? '…' : 'Refresh'}
            </button>
          </div>
          {meetingsLoading ? (
            <p className="text-xs text-los-text-muted">Loading…</p>
          ) : recentMeetings.length === 0 ? (
            <p className="text-xs text-los-text-muted">No meetings in the last 3 days</p>
          ) : (
            <div className="space-y-3 flex-1 overflow-y-auto max-h-[300px]">
              {recentMeetings.map((m) => (
                <div key={m.id}>
                  <a href={m.url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-los-text hover:text-los-accent transition block truncate">
                    {m.title}
                  </a>
                  <p className="text-[10px] text-los-text-muted mb-1">
                    {new Date(m.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </p>
                  {Array.isArray(m.actionItems) && m.actionItems.length > 0 ? (
                    <ul className="space-y-1">
                      {m.actionItems.map((a: any, i: number) => (
                        <li key={i} className="text-[11px] text-los-text-secondary flex gap-1.5">
                          <span className="text-los-accent">•</span>
                          <span>{typeof a === 'string' ? a : a.description || a.text || JSON.stringify(a)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[11px] text-los-text-muted italic">No action items</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Personal Score chart + Daily Habits */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2 los-card p-4 flex flex-col">
          <div className="flex justify-between items-center mb-2">
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-semibold text-los-text">Personal Score</h2>
              <span className="text-[11px] text-los-text-muted">gym · food · deep work · sleep · steps</span>
            </div>
            <TimeRange value={scoreRange} onChange={setScoreRange} />
          </div>
          <LineChart data={scoreSeries.map((d) => ({ label: d.date.slice(5), value: d.score }))} height={170} format={(v) => `${Math.round(v)}`} color="#8b5cf6" />
          {weakest && (
            <div className="mt-3 flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2">
              <span className="w-4 h-4 rounded-full bg-los-red/20 text-los-red flex items-center justify-center text-[10px] font-bold shrink-0">i</span>
              <p className="text-xs text-los-text-secondary">
                {weakest.message} <span className="text-los-text-muted">({weakest.label} is your weakest input at {weakest.value}%)</span>
              </p>
            </div>
          )}
        </div>

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
      </div>

      {/* Calendar + Key Actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="los-card p-4 flex flex-col">
          <div className="flex justify-between items-center mb-3">
            <h2 className="text-sm font-semibold text-los-text">Calendar</h2>
            <button onClick={loadCalendar} className="text-[11px] text-los-accent hover:underline disabled:opacity-50" disabled={calendarLoading}>
              {calendarLoading ? '…' : 'Refresh'}
            </button>
          </div>
          {calendarLoading ? (
            <p className="text-xs text-los-text-muted">Loading…</p>
          ) : calendarEvents.length === 0 ? (
            <p className="text-xs text-los-text-muted">No events today or tomorrow</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {calendarEvents.map((ev) => (
                <button key={ev.id} onClick={() => setSelectedEvent(ev)} className="text-left rounded-lg bg-los-surface-2 p-2.5 hover:bg-los-surface-3 transition">
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
          <div className="space-y-1.5 flex-1 overflow-y-auto max-h-[160px]">
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
          <Link href="/tasks" className="text-[11px] text-los-accent hover:underline mt-auto pt-2.5 border-t border-los-border">All tasks →</Link>
        </div>
      </div>

      {/* Briefing modal */}
      {briefingOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setBriefingOpen(false)}>
          <div className="los-card w-full max-w-2xl max-h-[80vh] flex flex-col p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-3">
              <h2 className="text-sm font-semibold text-los-text">⚡ Daily Briefing {briefingLoading && <span className="text-xs text-los-text-muted">(generating…)</span>}</h2>
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
              {selectedEvent.location && (<div><p className="los-label mb-1">Location</p><p className="text-sm text-los-text">{selectedEvent.location}</p></div>)}
              {Array.isArray(selectedEvent.attendees) && selectedEvent.attendees.length > 0 && (
                <div>
                  <p className="los-label mb-1">Attendees</p>
                  <div className="space-y-1">{selectedEvent.attendees.map((a: any, i: number) => (<p key={i} className="text-sm text-los-text">{a.displayName || a.email}</p>))}</div>
                </div>
              )}
              {selectedEvent.hangoutLink && (<a href={selectedEvent.hangoutLink} target="_blank" rel="noopener noreferrer" className="los-btn los-btn-primary inline-block">Join call</a>)}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
