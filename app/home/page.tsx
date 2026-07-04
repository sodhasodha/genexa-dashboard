'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import NavBar from '@/components/NavBar'
import MetricCard from '@/components/MetricCard'
import { MorningCheckInModal, EodLogModal } from '@/components/CheckInModals'
import {
  getGoals,
  getClientTracker,
  getLogStreak,
  getTasks,
  getClients,
  getDailyHabits,
  setDailyHabits,
} from '@/lib/storage'
import { Task } from '@/lib/types'

const HABITS: { key: 'gym' | 'eatHealthy' | 'deepWork' | 'eodDone'; label: string }[] = [
  { key: 'gym', label: 'Gym' },
  { key: 'eatHealthy', label: 'Eat Healthy' },
  { key: 'deepWork', label: 'Deep Work' },
  { key: 'eodDone', label: 'EOD Done' },
]

type HabitState = { gym: boolean; eatHealthy: boolean; deepWork: boolean; eodDone: boolean }

export default function HomePage() {
  const today = new Date().toISOString().split('T')[0]

  const [checkingBalance, setCheckingBalance] = useState<number>(0)
  const [creditBalance, setCreditBalance] = useState<number>(0)
  const [whopMTD, setWhopMTD] = useState<number | null>(null)
  const [financeLoading, setFinanceLoading] = useState<boolean>(true)
  const [meetings, setMeetings] = useState<any[]>([])
  const [meetingsLoading, setMeetingsLoading] = useState<boolean>(true)
  const [calendarEvents, setCalendarEvents] = useState<any[]>([])
  const [calendarLoading, setCalendarLoading] = useState<boolean>(true)
  const [starredTasks, setStarredTasks] = useState<Task[]>([])
  const [habits, setHabits] = useState<HabitState>({ gym: false, eatHealthy: false, deepWork: false, eodDone: false })
  const [monthlyRevenue, setMonthlyRevenue] = useState<number>(0)
  const [revenueTarget, setRevenueTarget] = useState<number>(18000)
  const [activeClients, setActiveClients] = useState<number>(0)
  const [clientGoal, setClientGoal] = useState<number>(10)
  const [logStreak, setLogStreak] = useState<number>(0)

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
      const [mercuryRes, whopRes] = await Promise.allSettled([
        fetch('/api/mercury/accounts').then((r) => r.json()),
        fetch('/api/whop/revenue').then((r) => r.json()),
      ])
      if (mercuryRes.status === 'fulfilled' && mercuryRes.value) {
        setCheckingBalance(mercuryRes.value.checkingBalance ?? 0)
        setCreditBalance(mercuryRes.value.creditBalance ?? 0)
      }
      if (whopRes.status === 'fulfilled' && typeof whopRes.value?.mtdRevenue === 'number') {
        setWhopMTD(whopRes.value.mtdRevenue)
      }
    } catch (error) {
      console.error('Failed to load finance data:', error)
    } finally {
      setFinanceLoading(false)
    }
  }

  const loadMeetings = async () => {
    setMeetingsLoading(true)
    try {
      const data = await fetch('/api/meetings').then((r) => r.json())
      if (Array.isArray(data.meetings)) setMeetings(data.meetings)
    } catch (error) {
      console.error('Failed to load meetings:', error)
    } finally {
      setMeetingsLoading(false)
    }
  }

  const loadCalendar = async () => {
    setCalendarLoading(true)
    try {
      const data = await fetch('/api/calendar').then((r) => r.json())
      if (Array.isArray(data.events)) setCalendarEvents(data.events)
    } catch (error) {
      console.error('Failed to load calendar:', error)
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
        const t = await fetch('/api/mercury/transactions').then((r) => r.json())
        transactions = t.transactions || []
      } catch {
        /* transactions are optional context */
      }

      const res = await fetch('/api/briefing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: {
            balance: checkingBalance,
            transactions,
            calendar: calendarEvents,
            meetings,
            tasks,
            clients,
          },
        }),
      })

      if (!res.body) {
        setBriefingText('No response from briefing service.')
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let acc = ''
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        acc += decoder.decode(value, { stream: true })
        setBriefingText(acc)
      }
    } catch (error) {
      console.error('Briefing error:', error)
      setBriefingText('Failed to generate briefing.')
    } finally {
      setBriefingLoading(false)
    }
  }

  useEffect(() => {
    // Client tracker stays device-local; everything else comes from the API layer.
    const clientTracker = getClientTracker()
    setActiveClients(clientTracker.active)
    setClientGoal(clientTracker.goal)

    ;(async () => {
      const [goals, streak, tasks, todayHabits] = await Promise.all([
        getGoals(),
        getLogStreak(),
        getTasks(),
        getDailyHabits(today),
      ])
      const revenueGoal = goals.find((g) => g.name.toLowerCase().includes('revenue'))
      if (revenueGoal) {
        setMonthlyRevenue(revenueGoal.current)
        setRevenueTarget(revenueGoal.target)
      }
      setLogStreak(streak)
      setStarredTasks(tasks.filter((t) => t.starred && t.col !== 'done'))
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

  const revenuePercent = ((monthlyRevenue / revenueTarget) * 100).toFixed(0)
  const clientsRemaining = clientGoal - activeClients
  const habitsDone = HABITS.filter((h) => habits[h.key]).length

  const fmtCurrency = (n: number) =>
    n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

  const fmtEventTime = (ev: any) => {
    const dt = ev.start?.dateTime || ev.start?.date
    if (!dt) return ''
    const d = new Date(dt)
    return ev.start?.dateTime
      ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      : 'All day'
  }

  return (
    <div className="min-h-screen bg-los-bg">
      <NavBar />

      {/* Content scrolls naturally below the fixed 60px navbar */}
      <div className="pt-[60px] max-w-[1400px] mx-auto flex flex-col gap-6 px-6 py-6">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-los-text">Good morning, Aryan</h1>
            <p className="text-sm text-los-text-muted mt-1">
              {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setMorningOpen(true)}
              className="px-4 py-2 text-sm font-medium text-los-text bg-los-surface rounded-lg hover:bg-los-surface-2 transition border border-los-border"
            >
              Morning Check-in
            </button>
            <button
              onClick={() => setEodOpen(true)}
              className="px-4 py-2 text-sm font-medium text-los-text bg-los-surface rounded-lg hover:bg-los-surface-2 transition border border-los-border"
            >
              EOD Log
            </button>
            <button
              onClick={runBriefing}
              className="px-4 py-2 text-sm font-medium text-white bg-los-accent rounded-lg hover:bg-blue-600 transition"
            >
              ⚡ Daily Briefing
            </button>
          </div>
        </div>

        {/* Metric cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard label="Checking Balance" value={fmtCurrency(checkingBalance)} subtitle="Mercury available" />
          <MetricCard
            label="Monthly Revenue"
            value={`$${(monthlyRevenue / 1000).toFixed(0)}k`}
            subtitle={`${revenuePercent}% of $${(revenueTarget / 1000).toFixed(0)}k`}
            color={parseFloat(revenuePercent) >= 100 ? 'green' : parseFloat(revenuePercent) >= 60 ? 'blue' : 'red'}
          />
          <MetricCard
            label="Active Clients"
            value={`${activeClients} / ${clientGoal}`}
            subtitle={clientsRemaining > 0 ? `${clientsRemaining} to go` : 'Goal reached!'}
            color={clientsRemaining <= 0 ? 'green' : 'muted'}
          />
          <MetricCard label="Log Streak" value={`${logStreak}d`} subtitle="Days" color="green" />
        </div>

        {/* Main content: Finance Pulse (2/3) + Meeting Brief (1/3) */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Finance Pulse */}
          <div className="lg:col-span-2 los-card p-6 flex flex-col min-h-[240px]">
            <div className="flex justify-between items-center mb-5">
              <h2 className="los-label">Finance Pulse</h2>
              <button
                onClick={loadFinance}
                className="text-xs text-los-accent hover:underline disabled:opacity-50"
                disabled={financeLoading}
              >
                {financeLoading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 flex-1">
              <div className="flex flex-col justify-center rounded-lg bg-los-surface-2 p-4">
                <p className="text-xs text-los-text-muted mb-2">Checking Balance</p>
                <p className="los-metric-number text-los-text">{fmtCurrency(checkingBalance)}</p>
                <p className="text-xs text-los-text-muted mt-1">Mercury</p>
              </div>

              <div className="flex flex-col justify-center rounded-lg bg-los-surface-2 p-4">
                <p className="text-xs text-los-text-muted mb-2">Credit Card Balance</p>
                <p className="los-metric-number text-los-text">{fmtCurrency(creditBalance)}</p>
                <p className="text-xs text-los-text-muted mt-1">Mercury IO owed</p>
              </div>

              <div className="flex flex-col justify-center rounded-lg bg-los-surface-2 p-4">
                <p className="text-xs text-los-text-muted mb-2">Whop MTD Revenue</p>
                <p className="los-metric-number text-los-green">
                  {whopMTD === null ? '—' : fmtCurrency(whopMTD)}
                </p>
                <p className="text-xs text-los-text-muted mt-1">Month to date</p>
              </div>
            </div>
          </div>

          {/* Meeting Brief */}
          <div className="los-card p-6 flex flex-col min-h-[240px]">
            <div className="flex justify-between items-center mb-5">
              <h2 className="los-label">Meeting Brief</h2>
              <button
                onClick={loadMeetings}
                className="text-xs text-los-accent hover:underline disabled:opacity-50"
                disabled={meetingsLoading}
              >
                {meetingsLoading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
            {meetingsLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <p className="text-center text-los-text-muted text-sm">Loading meetings...</p>
              </div>
            ) : meetings.length === 0 ? (
              <div className="flex-1 flex items-center justify-center">
                <p className="text-center text-los-text-muted text-sm">No recent meetings</p>
              </div>
            ) : (
              <div className="space-y-3 flex-1 overflow-y-auto">
                {meetings.map((m) => (
                  <a
                    key={m.id}
                    href={m.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block rounded-lg bg-los-surface-2 p-3 hover:bg-los-surface transition"
                  >
                    <p className="text-sm font-medium text-los-text truncate">{m.title}</p>
                    <p className="text-xs text-los-text-muted mt-1">
                      {new Date(m.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      {m.attendees?.length ? ` · ${m.attendees.join(', ')}` : ''}
                    </p>
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Bottom content: Daily Habits, Calendar, Key Actions */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Daily Habits */}
          <div className="los-card p-6 flex flex-col min-h-[220px]">
            <h2 className="los-label mb-4">Daily Habits</h2>
            <div className="space-y-3 mb-4">
              {HABITS.map((h) => (
                <label key={h.key} className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    className="w-5 h-5 rounded"
                    checked={habits[h.key]}
                    onChange={() => toggleHabit(h.key)}
                  />
                  <span className="text-sm text-los-text">{h.label}</span>
                </label>
              ))}
            </div>
            <div className="mt-auto pt-3 border-t border-los-border">
              <p className="los-metric-number text-los-accent text-center">{habitsDone} / {HABITS.length}</p>
            </div>
          </div>

          {/* Calendar */}
          <div className="los-card p-6 flex flex-col min-h-[220px]">
            <div className="flex justify-between items-center mb-4">
              <h2 className="los-label">Calendar</h2>
              <button
                onClick={loadCalendar}
                className="text-xs text-los-accent hover:underline disabled:opacity-50"
                disabled={calendarLoading}
              >
                {calendarLoading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
            {calendarLoading ? (
              <p className="text-sm text-los-text-muted">Loading events...</p>
            ) : calendarEvents.length === 0 ? (
              <p className="text-sm text-los-text-muted">No events today or tomorrow</p>
            ) : (
              <div className="space-y-3 flex-1 overflow-y-auto">
                {calendarEvents.map((ev) => (
                  <button
                    key={ev.id}
                    onClick={() => setSelectedEvent(ev)}
                    className="w-full text-left rounded-lg bg-los-surface-2 p-3 hover:bg-los-surface transition"
                  >
                    <p className="text-sm font-medium text-los-text truncate">{ev.summary || '(no title)'}</p>
                    <p className="text-xs text-los-text-muted mt-1">
                      {new Date(ev.start?.dateTime || ev.start?.date).toLocaleDateString('en-US', {
                        weekday: 'short',
                      })}{' '}
                      · {fmtEventTime(ev)}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Key Actions */}
          <div className="los-card p-6 flex flex-col min-h-[220px]">
            <h2 className="los-label mb-4">Key Actions</h2>
            <div className="space-y-2 flex-1 overflow-y-auto">
              {starredTasks.length === 0 ? (
                <p className="text-sm text-los-text-muted">No starred tasks</p>
              ) : (
                starredTasks.map((t) => (
                  <div key={t.id} className="flex items-center gap-2 text-sm text-los-text">
                    <span className="text-los-amber">★</span>
                    <span className="truncate">{t.name}</span>
                  </div>
                ))
              )}
            </div>
            <Link href="/tasks" className="text-xs text-los-accent hover:underline mt-auto pt-3 border-t border-los-border">
              All tasks →
            </Link>
          </div>
        </div>
      </div>

      {/* Daily Briefing modal */}
      {briefingOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setBriefingOpen(false)}
        >
          <div
            className="los-card w-full max-w-2xl max-h-[80vh] flex flex-col p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold text-los-text">
                ⚡ Daily Briefing {briefingLoading && <span className="text-xs text-los-text-muted">(generating…)</span>}
              </h2>
              <button onClick={() => setBriefingOpen(false)} className="text-los-text-muted hover:text-los-text">
                ✕
              </button>
            </div>
            <div className="overflow-y-auto flex-1">
              {briefingText ? (
                <pre className="whitespace-pre-wrap font-sans text-sm text-los-text leading-relaxed">{briefingText}</pre>
              ) : (
                <p className="text-sm text-los-text-muted">Gathering context and generating your briefing…</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Morning Check-in / EOD Log */}
      <MorningCheckInModal open={morningOpen} onClose={() => setMorningOpen(false)} onSaved={refreshStreak} />
      <EodLogModal open={eodOpen} onClose={() => setEodOpen(false)} onSaved={refreshStreak} />

      {/* Calendar event drawer */}
      {selectedEvent && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={() => setSelectedEvent(null)}>
          <div
            className="w-full max-w-md h-full bg-white shadow-2xl p-8 overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-start mb-6 gap-4">
              <h2 className="text-xl font-semibold text-los-text">{selectedEvent.summary || '(no title)'}</h2>
              <button onClick={() => setSelectedEvent(null)} className="text-los-text-muted hover:text-los-text text-lg leading-none">
                ✕
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <p className="los-label mb-1">When</p>
                <p className="text-sm text-los-text">
                  {new Date(selectedEvent.start?.dateTime || selectedEvent.start?.date).toLocaleString('en-US', {
                    weekday: 'long', month: 'short', day: 'numeric',
                    ...(selectedEvent.start?.dateTime ? { hour: 'numeric', minute: '2-digit' } : {}),
                  })}
                  {selectedEvent.end?.dateTime &&
                    ` – ${new Date(selectedEvent.end.dateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`}
                </p>
              </div>
              {selectedEvent.location && (
                <div>
                  <p className="los-label mb-1">Location</p>
                  <p className="text-sm text-los-text">{selectedEvent.location}</p>
                </div>
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
                <a
                  href={selectedEvent.hangoutLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="los-btn los-btn-primary inline-block"
                >
                  Join call
                </a>
              )}
              {selectedEvent.description && (
                <div>
                  <p className="los-label mb-1">Details</p>
                  <p className="text-sm text-los-text-muted whitespace-pre-wrap">{selectedEvent.description}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
