'use client'

import { useState, useEffect } from 'react'
import { getDailyLog, getDailyHabits } from '@/lib/storage'

export default function HealthPage() {
  const [loading, setLoading] = useState(true)
  const [yesterdayLog, setYesterdayLog] = useState<any>(null)
  const [yesterdayHabits, setYesterdayHabits] = useState<any>(null)

  useEffect(() => {
    // Get yesterday's data
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayStr = yesterday.toISOString().split('T')[0]

    ;(async () => {
      const [log, habits] = await Promise.all([
        getDailyLog(yesterdayStr),
        getDailyHabits(yesterdayStr),
      ])
      setYesterdayLog(log)
      setYesterdayHabits(habits)
      setLoading(false)
    })()
  }, [])

  if (loading) return <div>Loading...</div>

  // Calculate ring percentages
  const sleepPercentage = yesterdayLog?.sleep ? (yesterdayLog.sleep / 9) * 100 : 0
  const calBalance = (yesterdayLog?.caloriesBurned || 0) - (yesterdayLog?.caloriesEaten || 0)
  const activityPercentage = yesterdayHabits?.gym ? 100 : 5

  const getSleepColor = (hours: number) => {
    if (hours >= 7) return '#16A34A'
    if (hours >= 6) return '#D97706'
    return '#DC2626'
  }

  const RingChart = ({
    percentage,
    color,
    label,
    value,
  }: {
    percentage: number
    color: string
    label: string
    value: string | number
  }) => {
    const circumference = 2 * Math.PI * 45
    const offset = circumference - (percentage / 100) * circumference

    return (
      <div className="flex flex-col items-center gap-4">
        <svg width="120" height="120">
          <circle
            cx="60"
            cy="60"
            r="45"
            fill="none"
            stroke="rgba(0,0,0,0.08)"
            strokeWidth="8"
          />
          <circle
            cx="60"
            cy="60"
            r="45"
            fill="none"
            stroke={color}
            strokeWidth="8"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            style={{ transition: 'stroke-dashoffset 0.5s ease' }}
          />
          <text
            x="60"
            y="60"
            textAnchor="middle"
            dominantBaseline="central"
            fill="#0F0F0F"
            fontSize="20"
            fontWeight="bold"
            fontFamily="JetBrains Mono"
          >
            {value}
          </text>
        </svg>
        <p className="text-center text-sm text-los-text-muted">{label}</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen text-los-text">
      <div className="px-6 py-5 max-w-[1400px] mx-auto">
        <h1 className="text-xl font-semibold text-los-text tracking-tight mb-6">Health Hub</h1>

        {/* Yesterday's Summary Rings */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-12">
          <RingChart
            percentage={sleepPercentage}
            color={getSleepColor(yesterdayLog?.sleep || 0)}
            label="Recovery Score"
            value={`${yesterdayLog?.sleep || 0}h`}
          />
          <RingChart
            percentage={Math.min(Math.abs(calBalance) / 500 * 100, 100)}
            color={calBalance > 0 ? '#16A34A' : '#DC2626'}
            label="Caloric Balance"
            value={`${calBalance > 0 ? '+' : ''}${calBalance}`}
          />
          <RingChart
            percentage={activityPercentage}
            color={activityPercentage > 50 ? '#16A34A' : '#DC2626'}
            label="Activity"
            value={yesterdayHabits?.gym ? '✓' : '✗'}
          />
        </div>

        {/* Yesterday's Metrics */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-12">
          {[
            { label: 'Steps', value: yesterdayLog?.stepsTaken || 0 },
            { label: 'Cal Burned', value: yesterdayLog?.caloriesBurned || 0 },
            { label: 'Cal Eaten', value: yesterdayLog?.caloriesEaten || 0 },
            { label: 'Sleep', value: `${yesterdayLog?.sleep || 0}h` },
            { label: 'Exercise', value: yesterdayHabits?.gym ? '✓' : '✗' },
          ].map((metric, idx) => (
            <div key={idx} className="los-card p-4 text-center">
              <p className="los-label mb-1">{metric.label}</p>
              <p className="los-metric-number text-los-text">{metric.value}</p>
            </div>
          ))}
        </div>

        {/* Weekly Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: 'Avg Steps', value: '8,234' },
            { label: 'Avg Sleep', value: '7.2h' },
            { label: 'Avg Burned', value: '2,100' },
            { label: 'Exercise Days', value: '5/7' },
          ].map((stat, idx) => (
            <div key={idx} className="los-card p-4">
              <p className="los-label mb-2">{stat.label}</p>
              <p className="los-metric-number text-los-text">{stat.value}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
