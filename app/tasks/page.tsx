'use client'

import { useState, useEffect, useRef } from 'react'
import Modal, { Field } from '@/components/Modal'
import { getTasks, setTasks, getProcessedSlackTs, addProcessedSlackTs } from '@/lib/storage'
import { Task, TaskOperation } from '@/lib/types'

const COLUMNS = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'week', label: 'This Week' },
  { id: 'today', label: 'Today' },
  { id: 'waiting', label: 'Waiting On' },
  { id: 'done', label: 'Done' },
]

// Map Slack task-parser enums onto our Task shape.
const COL_MAP: Record<string, Task['col']> = {
  BACKLOG: 'backlog',
  THIS_WEEK: 'week',
  TODAY: 'today',
  WAITING_ON: 'waiting',
  DONE: 'done',
}
const PRI_MAP: Record<string, Task['priority']> = { NORMAL: 'normal', WARM: 'warm', HOT: 'hot' }

// Apply parsed Slack operations (add/complete/delete/move) to the task list.
// complete/delete/move match an existing task by name (exact, then substring).
function applyOperations(current: Task[], ops: TaskOperation[]): Task[] {
  const result = [...current]
  const findIdx = (name: string) => {
    const lc = name.toLowerCase().trim()
    let i = result.findIndex((t) => t.name.toLowerCase().trim() === lc)
    if (i === -1) i = result.findIndex((t) => t.name.toLowerCase().includes(lc))
    return i
  }
  for (const op of ops) {
    if (!op.task) continue
    if (op.action === 'add') {
      result.push({
        id: `slack-${op.ts || Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: op.task,
        col: COL_MAP[op.column || 'THIS_WEEK'] || 'week',
        priority: PRI_MAP[op.priority || 'NORMAL'] || 'normal',
        starred: false,
        due_date: op.due_date ?? null,
        notes: '',
        created: Date.now(),
      })
    } else if (op.action === 'complete') {
      const i = findIdx(op.task)
      if (i >= 0) result[i] = { ...result[i], col: 'done', doneAt: Date.now() }
    } else if (op.action === 'delete') {
      const i = findIdx(op.task)
      if (i >= 0) result.splice(i, 1)
    } else if (op.action === 'move') {
      const i = findIdx(op.task)
      if (i >= 0) result[i] = { ...result[i], col: COL_MAP[op.column || 'THIS_WEEK'] || result[i].col }
    }
  }
  return result
}

export default function TasksPage() {
  const [tasks, setTasksState] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [draggedTask, setDraggedTask] = useState<Task | null>(null)
  const [slackStatus, setSlackStatus] = useState('')
  // Latest tasks, readable from the polling closure without stale state.
  const tasksRef = useRef<Task[]>([])

  useEffect(() => {
    tasksRef.current = tasks
  }, [tasks])

  const syncSlack = async () => {
    try {
      const processedTs = getProcessedSlackTs()
      const res = await fetch('/api/slack/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ processedTs }),
      })
      if (!res.ok) return
      const data = await res.json()
      const ops: TaskOperation[] = Array.isArray(data.operations) ? data.operations : []
      if (ops.length > 0) {
        const updated = applyOperations(tasksRef.current, ops)
        tasksRef.current = updated
        setTasksState(updated)
        await setTasks(updated)
        setSlackStatus(`Synced ${ops.length} update${ops.length > 1 ? 's' : ''} from Slack`)
      }
      if (Array.isArray(data.newProcessedTs) && data.newProcessedTs.length > 0) {
        addProcessedSlackTs(data.newProcessedTs)
      }
    } catch (e) {
      console.error('Slack sync failed:', e)
    }
  }

  useEffect(() => {
    ;(async () => {
      const loaded = await getTasks()
      tasksRef.current = loaded
      setTasksState(loaded)
      setLoading(false)
      syncSlack() // pull once on mount
    })()
    const id = setInterval(syncSlack, 60000) // then poll every 60s
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const tasksByColumn = (colId: string) => {
    return tasks.filter((t) => t.col === (colId as any))
  }

  const handleDragStart = (task: Task) => {
    setDraggedTask(task)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
  }

  const handleDrop = (colId: string) => {
    if (!draggedTask) return

    const updated = tasks.map((t) =>
      t.id === draggedTask.id ? { ...t, col: colId as any } : t
    )
    setTasksState(updated)
    setTasks(updated)
    setDraggedTask(null)
  }

  const toggleStar = (taskId: string) => {
    const updated = tasks.map((t) =>
      t.id === taskId ? { ...t, starred: !t.starred } : t
    )
    setTasksState(updated)
    setTasks(updated)
  }

  const deleteTask = (taskId: string) => {
    const updated = tasks.filter((t) => t.id !== taskId)
    setTasksState(updated)
    tasksRef.current = updated
    setTasks(updated)
  }

  // --- Add / Edit task modal ---
  const emptyDraft = (): Task => ({
    id: '',
    name: '',
    col: 'today',
    priority: 'normal',
    starred: false,
    due_date: null,
    notes: '',
    created: Date.now(),
  })
  const [taskModalOpen, setTaskModalOpen] = useState(false)
  const [draft, setDraft] = useState<Task>(emptyDraft())
  const [isEditing, setIsEditing] = useState(false)

  const openAdd = () => {
    setDraft({ ...emptyDraft(), id: `task-${Date.now()}` })
    setIsEditing(false)
    setTaskModalOpen(true)
  }
  const openEdit = (t: Task) => {
    setDraft({ ...t })
    setIsEditing(true)
    setTaskModalOpen(true)
  }
  const saveTask = async () => {
    if (!draft.name.trim()) return
    const exists = tasks.some((t) => t.id === draft.id)
    const updated = exists ? tasks.map((t) => (t.id === draft.id ? draft : t)) : [...tasks, draft]
    setTasksState(updated)
    tasksRef.current = updated
    setTaskModalOpen(false)
    await setTasks(updated)
  }

  if (loading) return <div className="p-8 text-los-text-muted">Loading…</div>

  return (
    <div className="min-h-screen">
      <div className="px-4 sm:px-6 py-5 flex flex-col h-[calc(100dvh-3rem)] md:h-screen">
        <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-los-text tracking-tight">Tasks</h1>
            {slackStatus && <span className="text-xs text-los-text-muted">{slackStatus}</span>}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={syncSlack}
              className="los-btn los-btn-ghost"
            >
              ⟳ Sync Slack
            </button>
            <button onClick={openAdd} className="los-btn los-btn-primary">
              + Add Task
            </button>
          </div>
        </div>

        {/* Kanban Board */}
        <div className="flex gap-4 flex-1 min-h-0 overflow-x-auto pb-2">
          {COLUMNS.map((col) => (
            <div
              key={col.id}
              onDragOver={handleDragOver}
              onDrop={() => handleDrop(col.id)}
              className="los-card p-4 flex flex-col w-[280px] shrink-0"
            >
              <h2 className="los-label mb-3 flex items-center justify-between">
                {col.label}
                <span className="text-los-text-muted bg-los-surface-2 px-1.5 py-0.5 rounded">{tasksByColumn(col.id).length}</span>
              </h2>
              <div className="space-y-2.5 flex-1 overflow-y-auto pr-0.5">
                {tasksByColumn(col.id).map((task) => (
                  <div
                    key={task.id}
                    draggable
                    onDragStart={() => handleDragStart(task)}
                    onClick={() => openEdit(task)}
                    className="rounded-lg p-3 bg-los-surface-2 border border-los-border cursor-pointer hover:border-los-border-hover transition"
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <p className="text-sm font-medium text-los-text flex-1">{task.name}</p>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleStar(task.id)
                        }}
                        className="text-lg"
                      >
                        {task.starred ? '⭐' : '☆'}
                      </button>
                    </div>

                    {task.priority !== 'normal' && (
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                        task.priority === 'hot'
                          ? 'bg-red-500/15 text-red-400'
                          : 'bg-amber-500/15 text-amber-400'
                      }`}>
                        {task.priority.toUpperCase()}
                      </span>
                    )}

                    {task.due_date && (
                      <div className="mt-2 text-xs text-los-text-muted">
                        Due: {new Date(task.due_date).toLocaleDateString()}
                      </div>
                    )}

                    {task.notes && (
                      <p className="mt-2 text-xs text-los-text-muted italic">{task.notes}</p>
                    )}

                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteTask(task.id)
                      }}
                      className="text-xs text-los-text-muted hover:text-los-red mt-2"
                    >
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <Modal
        open={taskModalOpen}
        onClose={() => setTaskModalOpen(false)}
        title={isEditing ? 'Edit Task' : 'Add Task'}
        footer={
          <>
            {isEditing && (
              <button
                onClick={() => {
                  deleteTask(draft.id)
                  setTaskModalOpen(false)
                }}
                className="los-btn los-btn-ghost text-los-red mr-auto"
              >
                Delete
              </button>
            )}
            <button onClick={() => setTaskModalOpen(false)} className="los-btn los-btn-ghost">
              Cancel
            </button>
            <button onClick={saveTask} className="los-btn los-btn-primary">
              Save
            </button>
          </>
        }
      >
        <Field label="Task">
          <input
            className="los-input"
            autoFocus
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="What needs doing?"
          />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Column">
            <select
              className="los-select"
              value={draft.col}
              onChange={(e) => setDraft({ ...draft, col: e.target.value as Task['col'] })}
            >
              {COLUMNS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority">
            <select
              className="los-select"
              value={draft.priority}
              onChange={(e) => setDraft({ ...draft, priority: e.target.value as Task['priority'] })}
            >
              <option value="normal">Normal</option>
              <option value="warm">Warm</option>
              <option value="hot">Hot</option>
            </select>
          </Field>
        </div>
        <Field label="Due date">
          <input
            type="date"
            className="los-input"
            value={draft.due_date || ''}
            onChange={(e) => setDraft({ ...draft, due_date: e.target.value || null })}
          />
        </Field>
        <Field label="Notes">
          <textarea
            className="los-textarea"
            value={draft.notes}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          />
        </Field>
      </Modal>
    </div>
  )
}
