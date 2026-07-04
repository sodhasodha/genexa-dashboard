'use client'

import { useState, useEffect } from 'react'
import Modal, { Field } from '@/components/Modal'
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

  // --- Add / Edit goal modal ---
  const emptyGoal = (): Goal => ({ id: '', name: '', current: 0, target: 0, notes: '' })
  const [goalModalOpen, setGoalModalOpen] = useState(false)
  const [gDraft, setGDraft] = useState<Goal>(emptyGoal())
  const [gEditing, setGEditing] = useState(false)

  const openAddGoal = () => {
    setGDraft({ ...emptyGoal(), id: `goal-${Date.now()}` })
    setGEditing(false)
    setGoalModalOpen(true)
  }
  const openEditGoal = (g: Goal) => {
    setGDraft({ ...g })
    setGEditing(true)
    setGoalModalOpen(true)
  }
  const saveGoal = async () => {
    if (!gDraft.name.trim()) return
    const exists = goals.some((g) => g.id === gDraft.id)
    const updated = exists ? goals.map((g) => (g.id === gDraft.id ? gDraft : g)) : [...goals, gDraft]
    setGoalsState(updated)
    setGoalModalOpen(false)
    await setGoals(updated)
  }
  const deleteGoal = async (id: string) => {
    const updated = goals.filter((g) => g.id !== id)
    setGoalsState(updated)
    setGoalModalOpen(false)
    await setGoals(updated)
  }

  if (loading) return <div className="p-8 text-los-text-muted">Loading…</div>

  return (
    <div className="min-h-screen">
      <div className="px-6 py-5 max-w-[1400px] mx-auto">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-semibold text-los-text tracking-tight">Goals</h1>
          <button onClick={openAddGoal} className="los-btn los-btn-primary">
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
                  <button
                    onClick={() => openEditGoal(goal)}
                    className="text-los-text-muted hover:text-los-text text-lg leading-none"
                  >
                    ⋯
                  </button>
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

      <Modal
        open={goalModalOpen}
        onClose={() => setGoalModalOpen(false)}
        title={gEditing ? 'Edit Goal' : 'Add Goal'}
        footer={
          <>
            {gEditing && (
              <button
                onClick={() => deleteGoal(gDraft.id)}
                className="los-btn los-btn-ghost text-los-red mr-auto"
              >
                Delete
              </button>
            )}
            <button onClick={() => setGoalModalOpen(false)} className="los-btn los-btn-ghost">
              Cancel
            </button>
            <button onClick={saveGoal} className="los-btn los-btn-primary">
              Save
            </button>
          </>
        }
      >
        <Field label="Goal name">
          <input
            className="los-input"
            autoFocus
            value={gDraft.name}
            onChange={(e) => setGDraft({ ...gDraft, name: e.target.value })}
            placeholder="e.g. Monthly Revenue"
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Current ($)">
            <input
              type="number"
              className="los-input"
              value={gDraft.current}
              onChange={(e) => setGDraft({ ...gDraft, current: Number(e.target.value) })}
            />
          </Field>
          <Field label="Target ($)">
            <input
              type="number"
              className="los-input"
              value={gDraft.target}
              onChange={(e) => setGDraft({ ...gDraft, target: Number(e.target.value) })}
            />
          </Field>
        </div>
        <Field label="Notes">
          <textarea
            className="los-textarea"
            value={gDraft.notes}
            onChange={(e) => setGDraft({ ...gDraft, notes: e.target.value })}
            placeholder="Sub-goals, milestones, context"
          />
        </Field>
      </Modal>
    </div>
  )
}
