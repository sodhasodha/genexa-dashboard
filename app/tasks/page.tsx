'use client'

import { useState, useEffect, useRef } from 'react'
import NavBar from '@/components/NavBar'
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
    setTasks(updated)
  }

  if (loading) return <div>Loading...</div>

  return (
    <div className="min-h-screen bg-los-bg">
      <NavBar />

      <div className="mt-60px p-6 h-screen-minus-60" style={{ height: 'calc(100vh - 60px)' }}>
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-los-text">Tasks</h1>
            {slackStatus && <span className="text-xs text-los-text-muted">{slackStatus}</span>}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={syncSlack}
              className="px-3 py-2 text-sm bg-los-surface border border-los-border text-los-text rounded-lg hover:bg-los-surface-2"
            >
              ⟳ Sync Slack
            </button>
            <button className="px-4 py-2 bg-los-accent text-white rounded-lg hover:bg-blue-600">
              + Add Task
            </button>
          </div>
        </div>

        {/* Kanban Board */}
        <div className="grid grid-cols-5 gap-4 h-full overflow-x-auto">
          {COLUMNS.map((col) => (
            <div
              key={col.id}
              onDragOver={handleDragOver}
              onDrop={() => handleDrop(col.id)}
              className="los-card p-4 flex flex-col min-w-[280px] bg-los-surface-2"
            >
              <h2 className="los-label mb-4">{col.label}</h2>
              <div className="space-y-3 flex-1 overflow-y-auto">
                {tasksByColumn(col.id).map((task) => (
                  <div
                    key={task.id}
                    draggable
                    onDragStart={() => handleDragStart(task)}
                    className="los-card p-3 bg-white cursor-move hover:shadow-los-card-hover"
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <p className="text-sm font-medium text-los-text flex-1">{task.name}</p>
                      <button
                        onClick={() => toggleStar(task.id)}
                        className="text-lg"
                      >
                        {task.starred ? '⭐' : '☆'}
                      </button>
                    </div>

                    {task.priority !== 'normal' && (
                      <span className={`text-xs font-semibold px-2 py-1 rounded ${
                        task.priority === 'hot'
                          ? 'bg-red-100 text-los-red'
                          : 'bg-amber-100 text-los-amber'
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
                      onClick={() => deleteTask(task.id)}
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
    </div>
  )
}
