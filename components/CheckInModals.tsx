'use client'

import { useState, useEffect } from 'react'
import Modal, { Field } from './Modal'
import { getDailyLog, setDailyLog } from '@/lib/storage'

const todayStr = () => new Date().toISOString().split('T')[0]

interface BaseProps {
  open: boolean
  onClose: () => void
  onSaved?: () => void
}

// Morning Check-in — sleep + feeling, merged into today's daily log.
export function MorningCheckInModal({ open, onClose, onSaved }: BaseProps) {
  const [sleep, setSleep] = useState('')
  const [feeling, setFeeling] = useState('5')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    getDailyLog(todayStr()).then((l) => {
      setSleep(l?.sleep != null ? String(l.sleep) : '')
      setFeeling(l?.feeling != null ? String(l.feeling) : '5')
    })
  }, [open])

  const save = async () => {
    setSaving(true)
    const today = todayStr()
    const existing = (await getDailyLog(today)) || { date: today }
    await setDailyLog(today, {
      ...existing,
      date: today,
      sleep: sleep === '' ? undefined : Number(sleep),
      feeling: Number(feeling),
    })
    setSaving(false)
    onSaved?.()
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Morning Check-in"
      footer={
        <>
          <button onClick={onClose} className="los-btn los-btn-ghost">Cancel</button>
          <button onClick={save} disabled={saving} className="los-btn los-btn-primary">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <Field label="Hours slept">
        <input
          type="number"
          step="0.5"
          className="los-input"
          value={sleep}
          onChange={(e) => setSleep(e.target.value)}
          placeholder="e.g. 7.5"
        />
      </Field>
      <Field label={`Feeling — ${feeling} / 10`}>
        <input
          type="range"
          min={1}
          max={10}
          value={feeling}
          onChange={(e) => setFeeling(e.target.value)}
          className="w-full accent-los-accent"
        />
      </Field>
    </Modal>
  )
}

// EOD Log — exercise/nutrition/energy + reflections, merged into today's daily log.
export function EodLogModal({ open, onClose, onSaved }: BaseProps) {
  const [form, setForm] = useState({
    exerciseHours: '',
    caloriesBurned: '',
    stepsTaken: '',
    caloriesEaten: '',
    energy: '5',
    winsToday: '',
    challenges: '',
    tomorrowsFocus: '',
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    getDailyLog(todayStr()).then((l) => {
      setForm({
        exerciseHours: l?.exerciseHours != null ? String(l.exerciseHours) : '',
        caloriesBurned: l?.caloriesBurned != null ? String(l.caloriesBurned) : '',
        stepsTaken: l?.stepsTaken != null ? String(l.stepsTaken) : '',
        caloriesEaten: l?.caloriesEaten != null ? String(l.caloriesEaten) : '',
        energy: l?.energy != null ? String(l.energy) : '5',
        winsToday: l?.winsToday ?? '',
        challenges: l?.challenges ?? '',
        tomorrowsFocus: l?.tomorrowsFocus ?? '',
      })
    })
  }, [open])

  const numOrUndef = (v: string) => (v === '' ? undefined : Number(v))

  const save = async () => {
    setSaving(true)
    const today = todayStr()
    const existing = (await getDailyLog(today)) || { date: today }
    await setDailyLog(today, {
      ...existing,
      date: today,
      exerciseHours: numOrUndef(form.exerciseHours),
      caloriesBurned: numOrUndef(form.caloriesBurned),
      stepsTaken: numOrUndef(form.stepsTaken),
      caloriesEaten: numOrUndef(form.caloriesEaten),
      energy: Number(form.energy),
      winsToday: form.winsToday || undefined,
      challenges: form.challenges || undefined,
      tomorrowsFocus: form.tomorrowsFocus || undefined,
    })
    setSaving(false)
    onSaved?.()
    onClose()
  }

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }))

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="EOD Log"
      footer={
        <>
          <button onClick={onClose} className="los-btn los-btn-ghost">Cancel</button>
          <button onClick={save} disabled={saving} className="los-btn los-btn-primary">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Hours exercised">
          <input type="number" step="0.5" className="los-input" value={form.exerciseHours} onChange={(e) => set('exerciseHours', e.target.value)} />
        </Field>
        <Field label="Calories burned">
          <input type="number" className="los-input" value={form.caloriesBurned} onChange={(e) => set('caloriesBurned', e.target.value)} />
        </Field>
        <Field label="Steps taken">
          <input type="number" className="los-input" value={form.stepsTaken} onChange={(e) => set('stepsTaken', e.target.value)} />
        </Field>
        <Field label="Calories eaten">
          <input type="number" className="los-input" value={form.caloriesEaten} onChange={(e) => set('caloriesEaten', e.target.value)} />
        </Field>
      </div>
      <Field label={`Energy — ${form.energy} / 10`}>
        <input type="range" min={1} max={10} value={form.energy} onChange={(e) => set('energy', e.target.value)} className="w-full accent-los-accent" />
      </Field>
      <Field label="Wins today">
        <textarea className="los-textarea" value={form.winsToday} onChange={(e) => set('winsToday', e.target.value)} />
      </Field>
      <Field label="Challenges">
        <textarea className="los-textarea" value={form.challenges} onChange={(e) => set('challenges', e.target.value)} />
      </Field>
      <Field label="Tomorrow's focus">
        <textarea className="los-textarea" value={form.tomorrowsFocus} onChange={(e) => set('tomorrowsFocus', e.target.value)} />
      </Field>
    </Modal>
  )
}
