import { NextRequest, NextResponse } from 'next/server'
import { dbGetAllDailyLogs } from '@/lib/db'
import type { DailyLog } from '@/lib/types'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

const dayStr = (offsetDays: number) => new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10)
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

// Each input normalized to 0–1 against a daily goal, then weighted (weights sum to 1).
const WEIGHTS = { sleep: 0.2, steps: 0.15, exercise: 0.15, eaten: 0.15, energy: 0.15, burned: 0.1, feeling: 0.1 }
const LABELS: Record<string, string> = {
  sleep: 'sleep', steps: 'steps', exercise: 'exercise', eaten: 'calorie intake', energy: 'energy', burned: 'calories burned', feeling: 'mood',
}
const MESSAGES: Record<string, string> = {
  sleep: 'Improve sleep to raise your score',
  steps: 'Hit your step goal to raise your score',
  exercise: 'Exercise more to raise your score',
  eaten: 'Watch your calorie intake to raise your score',
  energy: 'Boost your energy to raise your score',
  burned: 'Burn more calories to raise your score',
  feeling: 'Lift your mood to raise your score',
}

function components(log: DailyLog | undefined) {
  return {
    sleep: clamp01((log?.sleep ?? 0) / 8),
    steps: clamp01((log?.stepsTaken ?? 0) / 10000),
    exercise: clamp01((log?.exerciseHours ?? 0) / 1),
    // Calorie intake: on-target under ~2200, degrading past it.
    eaten: log?.caloriesEaten != null ? clamp01(1 - Math.max(0, log.caloriesEaten - 2200) / 1100) : 0,
    energy: clamp01((log?.energy ?? 0) / 10),
    burned: clamp01((log?.caloriesBurned ?? 0) / 2500),
    feeling: clamp01((log?.feeling ?? 0) / 10),
  }
}
const scoreFrom = (c: Record<string, number>, hasData: boolean) =>
  hasData ? Math.round(Object.entries(WEIGHTS).reduce((s, [k, w]) => s + w * (c as any)[k], 0) * 100) : 0

// GET /api/score/series?days=N  — 7-day rolling average, not a same-day spike.
export async function GET(request: NextRequest) {
  try {
    const days = Math.min(Math.max(Number(request.nextUrl.searchParams.get('days')) || 30, 1), 400)
    const logs = await dbGetAllDailyLogs()
    const logByDate = new Map(logs.map((l) => [l.date, l]))

    const dailyScore = (d: string) => scoreFrom(components(logByDate.get(d)), logByDate.has(d))

    // Rolling 7-day average of the raw daily score.
    const rolling = (d: string) => {
      const base = new Date(d + 'T00:00:00Z').getTime()
      let sum = 0
      for (let k = 0; k < 7; k++) sum += dailyScore(new Date(base - k * 86400000).toISOString().slice(0, 10))
      return Math.round(sum / 7)
    }

    const series: { date: string; score: number }[] = []
    for (let i = days - 1; i >= 0; i--) {
      const d = dayStr(i)
      series.push({ date: d, score: rolling(d) })
    }

    // Weakest input = lowest component averaged over the trailing 7 days that have data.
    const recent = Array.from({ length: 7 }, (_, k) => logByDate.get(dayStr(k))).filter(Boolean) as DailyLog[]
    const avgC: Record<string, number> = {}
    for (const key of Object.keys(WEIGHTS)) {
      const vals = recent.map((l) => (components(l) as any)[key])
      avgC[key] = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0
    }
    const weakestKey = Object.keys(WEIGHTS).reduce((a, b) => (avgC[a] <= avgC[b] ? a : b))

    return NextResponse.json({
      series,
      current: series[series.length - 1].score,
      weakest: {
        key: weakestKey,
        label: LABELS[weakestKey],
        message: MESSAGES[weakestKey],
        value: Math.round((avgC[weakestKey] || 0) * 100),
      },
    })
  } catch (error) {
    console.error('score series error:', error)
    return NextResponse.json({ error: 'Failed to build score series' }, { status: 500 })
  }
}
