'use client'

import { useState, useEffect } from 'react'
import NavBar from '@/components/NavBar'
import { getGoals, setGoals } from '@/lib/storage'
import { Goal } from '@/lib/types'

export default function GoalsPage() {
  const [goals, setGoalsState] = useState<Goal[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ;(async () => {
      const loaded = await getGoals()
      if (loaded.length === 0) {
        // Pre-seed with revenue goal
        const defaultGoals: Goal[] = [
          {
            id: '1',
            name: 'Monthly Revenue',
            current: 12000,
            target: 18000,
            notes: 'Current: $12k, Target: $18k',
          },
        ]
        setGoalsState(defaultGoals)
        await setGoals(defaultGoals)
      } else {
        setGoalsState(loaded)
      }
      setLoading(false)
    })()
  }, [])

  const getBarColor = (percentage: number) => {
    if (percentage >= 100) return 'bg-los-green'
    if (percentage >= 60) return 'bg-los-accent'
    return 'bg-los-amber'
  }

  if (loading) return <div>Loading...</div>

  return (
    <div className="min-h-screen bg-los-bg">
      <NavBar />

      <div className="mt-60px p-6" style={{ marginTop: '60px' }}>
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-los-text">Goals</h1>
          <button className="px-4 py-2 bg-los-accent text-white rounded-lg hover:bg-blue-600">
            + Add Goal
          </button>
        </div>

        <div className="space-y-4 max-w-4xl">
          {goals.map((goal) => {
            const percentage = (goal.current / goal.target) * 100
            return (
              <div key={goal.id} className="los-card p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold text-los-text">{goal.name}</h2>
                  <button className="text-los-text-muted hover:text-los-text">⋯</button>
                </div>

                <div className="grid grid-cols-2 gap-4 mb-4 text-sm">
                  <div>
                    <p className="los-label mb-1">Current</p>
                    <p className="text-2xl font-bold text-los-text font-mono">
                      ${(goal.current / 1000).toFixed(1)}k
                    </p>
                  </div>
                  <div>
                    <p className="los-label mb-1">Target</p>
                    <p className="text-2xl font-bold text-los-text font-mono">
                      ${(goal.target / 1000).toFixed(1)}k
                    </p>
                  </div>
                </div>

                <div className="mb-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-los-text-muted">Progress</span>
                    <span className="text-sm font-semibold text-los-text">{Math.round(percentage)}%</span>
                  </div>
                  <div className="relative h-8 bg-los-surface-2 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${getBarColor(percentage)} rounded-full transition-all duration-500 animate-shimmer`}
                      style={{ width: `${Math.min(percentage, 100)}%` }}
                    />
                  </div>
                </div>

                {goal.notes && (
                  <p className="text-sm text-los-text-muted italic">{goal.notes}</p>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
