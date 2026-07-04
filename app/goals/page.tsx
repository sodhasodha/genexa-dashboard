'use client'

import { useState, useEffect } from 'react'
import Modal, { Field } from '@/components/Modal'
import { getGoals, setGoals } from '@/lib/storage'
import { Goal } from '@/lib/types'

type TypeKey = 'revenue' | 'profit' | 'wellbeing'
const TYPES: { key: TypeKey; label: string; unit: '$' | 'score'; defTarget: number; color: string }[] = [
  { key: 'revenue', label: 'Revenue', unit: '$', defTarget: 18000, color: '#22c55e' },
  { key: 'profit', label: 'Profit', unit: '$', defTarget: 8000, color: '#3b82f6' },
  { key: 'wellbeing', label: 'Wellbeing Score', unit: 'score', defTarget: 80, color: '#8b5cf6' },
]

// Trailing `n` months as 'YYYY-MM', newest first. Auto-rolls with the calendar.
function lastMonths(n: number): string[] {
  const out: string[] = []
  const now = new Date()
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  return out
}
const monthLabel = (m: string) => {
  const [y, mo] = m.split('-').map(Number)
  return new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}
const fmtVal = (v: number, unit: '$' | 'score') => (unit === '$' ? `$${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`)

export default function GoalsPage() {
  const [goals, setGoalsState] = useState<Goal[]>([])
  const [whopMTD, setWhopMTD] = useState(0)
  const [scoreNow, setScoreNow] = useState(0)
  const [loading, setLoading] = useState(true)

  const months = lastMonths(6)
  const currentMonth = months[0]

  useEffect(() => {
    ;(async () => {
      const [loaded] = await Promise.all([getGoals()])
      setGoalsState(loaded)
      setLoading(false)
    })()
    fetch('/api/whop/revenue').then((r) => r.json()).then((d) => typeof d.mtdRevenue === 'number' && setWhopMTD(d.mtdRevenue)).catch(() => {})
    fetch('/api/score/series?days=7').then((r) => r.json()).then((d) => typeof d.current === 'number' && setScoreNow(d.current)).catch(() => {})
  }, [])

  const cell = (month: string, type: TypeKey) => {
    const def = TYPES.find((t) => t.key === type)!
    const g = goals.find((x) => x.id === `${month}:${type}`)
    const target = g?.target ?? def.defTarget
    let current = g?.current ?? 0
    if (month === currentMonth) {
      if (type === 'revenue') current = whopMTD
      if (type === 'wellbeing') current = scoreNow
    }
    return { target, current, def }
  }

  // Edit modal
  const [modalOpen, setModalOpen] = useState(false)
  const [edit, setEdit] = useState<{ month: string; type: TypeKey; current: number; target: number }>({ month: '', type: 'revenue', current: 0, target: 0 })
  const openEdit = (month: string, type: TypeKey) => {
    const c = cell(month, type)
    setEdit({ month, type, current: c.current, target: c.target })
    setModalOpen(true)
  }
  const save = async () => {
    const id = `${edit.month}:${edit.type}`
    const label = TYPES.find((t) => t.key === edit.type)!.label
    const others = goals.filter((g) => g.id !== id)
    const updated = [...others, { id, name: `${monthLabel(edit.month)} — ${label}`, current: edit.current, target: edit.target, notes: '' }]
    setGoalsState(updated)
    setModalOpen(false)
    await setGoals(updated)
  }

  if (loading) return <div className="p-8 text-los-text-muted">Loading…</div>

  return (
    <div className="min-h-screen">
      <div className="px-4 sm:px-6 py-5 max-w-[1400px] mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-semibold text-los-text tracking-tight">Goals</h1>
            <p className="text-xs text-los-text-muted mt-0.5">Last 6 months · revenue · profit · wellbeing</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {months.map((month) => (
            <div key={month} className={`los-card p-4 ${month === currentMonth ? 'border-los-accent/40' : ''}`}>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-los-text">{monthLabel(month)}</h2>
                {month === currentMonth && <span className="text-[10px] text-los-accent bg-los-accent-soft px-2 py-0.5 rounded">Current</span>}
              </div>
              <div className="space-y-3">
                {TYPES.map((t) => {
                  const c = cell(month, t.key)
                  const pct = c.target > 0 ? Math.min((c.current / c.target) * 100, 100) : 0
                  return (
                    <button key={t.key} onClick={() => openEdit(month, t.key)} className="w-full text-left group">
                      <div className="flex items-baseline justify-between mb-1">
                        <span className="los-label group-hover:text-los-text-secondary transition">{t.label}</span>
                        <span className="font-mono text-xs text-los-text">
                          {fmtVal(c.current, t.unit)} <span className="text-los-text-muted">/ {fmtVal(c.target, t.unit)}</span>
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-los-surface-2 overflow-hidden">
                        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: t.color }} />
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={`${monthLabel(edit.month)} — ${TYPES.find((t) => t.key === edit.type)?.label}`}
        footer={
          <>
            <button onClick={() => setModalOpen(false)} className="los-btn los-btn-ghost">Cancel</button>
            <button onClick={save} className="los-btn los-btn-primary">Save</button>
          </>
        }
      >
        {edit.month === currentMonth && edit.type !== 'profit' && (
          <p className="text-[11px] text-los-text-muted mb-3">
            Current value for this month is live ({edit.type === 'revenue' ? 'Whop MTD revenue' : 'personal score'}); set the target below.
          </p>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Current">
            <input type="number" className="los-input" value={edit.current} onChange={(e) => setEdit({ ...edit, current: Number(e.target.value) })} />
          </Field>
          <Field label="Target">
            <input type="number" className="los-input" value={edit.target} onChange={(e) => setEdit({ ...edit, target: Number(e.target.value) })} />
          </Field>
        </div>
      </Modal>
    </div>
  )
}
