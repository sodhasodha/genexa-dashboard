// Client-side data access.
//
// The seven core entities (tasks, goals, clients, relationships, docs, daily
// logs, habits) are persisted in Postgres and reached through the /api/data/*
// routes — these functions are now async. A handful of small, device-local
// bits (client tracker, lifetime-done counter, Slack processed timestamps,
// per-event calendar notes) remain in localStorage.

import { Task, Goal, CRMClient, Relationship, Doc, DailyLog, DailyHabits } from './types'

const KEYS = {
  SLACK_PROCESSED_TS: 'los_slack_processed_ts',
  CALENDAR_NOTE: (eventId: string) => `cal-note-${eventId}`,
  CLIENT_TRACKER: 'los_clients',
  LIFETIME_DONE: 'los_lifetime_done',
}

// --- fetch helpers -----------------------------------------------------------

async function apiGet<T>(url: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(url)
    if (!res.ok) return fallback
    return (await res.json()) as T
  } catch {
    return fallback
  }
}

async function apiPut(url: string, body: unknown): Promise<void> {
  await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// --- Tasks -------------------------------------------------------------------

export function getTasks(): Promise<Task[]> {
  return apiGet<Task[]>('/api/data/tasks', [])
}

export function setTasks(tasks: Task[]): Promise<void> {
  return apiPut('/api/data/tasks', tasks)
}

// --- Goals -------------------------------------------------------------------

export function getGoals(): Promise<Goal[]> {
  return apiGet<Goal[]>('/api/data/goals', [])
}

export function setGoals(goals: Goal[]): Promise<void> {
  return apiPut('/api/data/goals', goals)
}

// --- CRM Clients -------------------------------------------------------------

export function getClients(): Promise<CRMClient[]> {
  return apiGet<CRMClient[]>('/api/data/clients', [])
}

export function setClients(clients: CRMClient[]): Promise<void> {
  return apiPut('/api/data/clients', clients)
}

// --- Relationships -----------------------------------------------------------

export function getRelationships(): Promise<Relationship[]> {
  return apiGet<Relationship[]>('/api/data/relationships', [])
}

export function setRelationships(relationships: Relationship[]): Promise<void> {
  return apiPut('/api/data/relationships', relationships)
}

// --- Docs --------------------------------------------------------------------

export function getDocs(): Promise<Doc[]> {
  return apiGet<Doc[]>('/api/data/docs', [])
}

export function setDocs(docs: Doc[]): Promise<void> {
  return apiPut('/api/data/docs', docs)
}

// --- Daily Logs --------------------------------------------------------------

export function getDailyLog(date: string): Promise<DailyLog | null> {
  return apiGet<DailyLog | null>(`/api/data/logs?date=${encodeURIComponent(date)}`, null)
}

export function setDailyLog(date: string, log: DailyLog): Promise<void> {
  return apiPut('/api/data/logs', { date, log })
}

// --- Daily Habits ------------------------------------------------------------

export function getDailyHabits(date: string): Promise<DailyHabits | null> {
  return apiGet<DailyHabits | null>(`/api/data/habits?date=${encodeURIComponent(date)}`, null)
}

export function setDailyHabits(date: string, habits: DailyHabits): Promise<void> {
  return apiPut('/api/data/habits', { date, habits })
}

// --- Log streak (derived from daily logs) ------------------------------------

export async function getLogStreak(): Promise<number> {
  const { streak } = await apiGet<{ streak: number }>('/api/data/logs/streak', { streak: 0 })
  return streak
}

// --- Slack processed timestamps (device-local) -------------------------------

export function getProcessedSlackTs(): string[] {
  if (typeof window === 'undefined') return []
  const data = localStorage.getItem(KEYS.SLACK_PROCESSED_TS)
  return data ? JSON.parse(data) : []
}

export function addProcessedSlackTs(timestamps: string[]): void {
  if (typeof window === 'undefined') return
  const existing = getProcessedSlackTs()
  const combined = Array.from(new Set([...existing, ...timestamps]))
  localStorage.setItem(KEYS.SLACK_PROCESSED_TS, JSON.stringify(combined))
}

// --- Calendar notes (device-local) -------------------------------------------

export function getCalendarNote(eventId: string): string {
  if (typeof window === 'undefined') return ''
  return localStorage.getItem(KEYS.CALENDAR_NOTE(eventId)) || ''
}

export function setCalendarNote(eventId: string, note: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(KEYS.CALENDAR_NOTE(eventId), note)
}

// --- Client tracker (device-local) -------------------------------------------

export interface ClientTracker {
  active: number
  goal: number
}

export function getClientTracker(): ClientTracker {
  const DEFAULT: ClientTracker = { active: 8, goal: 10 }
  if (typeof window === 'undefined') return DEFAULT
  const data = localStorage.getItem(KEYS.CLIENT_TRACKER)
  return data ? JSON.parse(data) : DEFAULT
}

export function setClientTracker(tracker: ClientTracker): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(KEYS.CLIENT_TRACKER, JSON.stringify(tracker))
}

// --- Lifetime done count (device-local) --------------------------------------

export function getLifetimeDone(): number {
  if (typeof window === 'undefined') return 0
  const data = localStorage.getItem(KEYS.LIFETIME_DONE)
  return data ? parseInt(data, 10) : 0
}

export function setLifetimeDone(count: number): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(KEYS.LIFETIME_DONE, String(count))
}
