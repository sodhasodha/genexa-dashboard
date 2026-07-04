'use client'

import { useState, useEffect } from 'react'
import NavBar from '@/components/NavBar'
import { getTasks, setTasks } from '@/lib/storage'
import { Task } from '@/lib/types'

const COLUMNS = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'week', label: 'This Week' },
  { id: 'today', label: 'Today' },
  { id: 'waiting', label: 'Waiting On' },
  { id: 'done', label: 'Done' },
]

export default function TasksPage() {
  const [tasks, setTasksState] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [draggedTask, setDraggedTask] = useState<Task | null>(null)

  useEffect(() => {
    ;(async () => {
      const loaded = await getTasks()
      setTasksState(loaded)
      setLoading(false)
    })()
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
          <h1 className="text-2xl font-bold text-los-text">Tasks</h1>
          <button className="px-4 py-2 bg-los-accent text-white rounded-lg hover:bg-blue-600">
            + Add Task
          </button>
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
