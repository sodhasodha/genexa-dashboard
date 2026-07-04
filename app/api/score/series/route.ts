import { NextRequest, NextResponse } from 'next/server'
import { dbGetAllDailyHabits, dbGetAllDailyLogs } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

const dayStr = (offsetDays: number) => new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10)

// Weighted components. Each contributes a normalized 0–1 value.
const WEIGHTS = { gym: 0.2, eat: 0.15, deep: 0.2, sleep: 0.25, steps: 0.2 }
const LABELS: Record<string, string> = { gym: 'gym streak', eat: 'eating healthy', deep: 'deep work', sleep: 'sleep', steps: 'steps' }
const MESSAGES: Record<string, string> = {
  gym: 'Keep your gym streak going to raise your score',
  eat: 'Stay consistent eating healthy to raise your score',
  deep: 'Log more deep work to raise your score',
  sleep: 'Improve sleep to raise your score',
  steps: 'Hit your step goal to raise your score',
}

// GET /api/score/series?days=N
export async function GET(request: NextRequest) {
  try {
    const days = Math.min(Math.max(Number(request.nextUrl.searchParams.get('days')) || 30, 1), 400)
    const [habits, logs] = await Promise.all([dbGetAllDailyHabits(), dbGetAllDailyLogs()])

    const gymSet = new Set(habits.filter((h) => h.gym).map((h) => h.date))
    const eatSet = new Set(habits.filter((h) => h.eatHealthy).map((h) => h.date))
    const deepSet = new Set(habits.filter((h) => h.deepWork).map((h) => h.date))
    const logByDate = new Map(logs.map((l) => [l.date, l]))

    const streak = (set: Set<string>, dateStr: string) => {
      let n = 0
      const base = new Date(dateStr + 'T00:00:00Z').getTime()
      while (set.has(new Date(base - n * 86400000).toISOString().slice(0, 10))) n++
      return n
    }

    // Component normalized values for a given day.
    const components = (d: string) => {
      const log = logByDate.get(d)
      return {
        gym: Math.min(streak(gymSet, d) / 7, 1),
        eat: Math.min(streak(eatSet, d) / 7, 1),
        deep: Math.min(streak(deepSet, d) / 7, 1),
        sleep: Math.min((log?.sleep ?? 0) / 8, 1),
        steps: Math.min((log?.stepsTaken ?? 0) / 10000, 1),
      }
    }
    const scoreOf = (c: Record<string, number>) =>
      Math.round(Object.entries(WEIGHTS).reduce((s, [k, w]) => s + w * (c as any)[k], 0) * 100)

    const series: { date: string; score: number }[] = []
    for (let i = days - 1; i >= 0; i--) {
      const d = dayStr(i)
      series.push({ date: d, score: scoreOf(components(d)) })
    }

    // Weakest input today (drives the dynamic message).
    const todayC = components(dayStr(0))
    const weakestKey = (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).reduce((a, b) =>
      todayC[a] <= todayC[b] ? a : b
    )
    const current = series[series.length - 1].score

    return NextResponse.json({
      series,
      current,
      weakest: {
        key: weakestKey,
        label: LABELS[weakestKey],
        message: MESSAGES[weakestKey],
        value: Math.round(todayC[weakestKey] * 100),
      },
    })
  } catch (error) {
    console.error('score series error:', error)
    return NextResponse.json({ error: 'Failed to build score series' }, { status: 500 })
  }
}
