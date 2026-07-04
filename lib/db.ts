import { db, sql } from '@vercel/postgres'
import type {
  Task,
  Goal,
  CRMClient,
  Relationship,
  Doc,
  DailyLog,
  DailyHabits,
} from './types'

// The pg driver returns NUMERIC / BIGINT as strings — coerce back to numbers.
const num = (v: unknown): number => Number(v)
const numOrUndef = (v: unknown): number | undefined =>
  v === null || v === undefined ? undefined : Number(v)

/* ---------------------------------- Tasks --------------------------------- */

function rowToTask(r: any): Task {
  return {
    id: r.id,
    name: r.name,
    col: r.col,
    priority: r.priority,
    starred: r.starred,
    due_date: r.due_date,
    notes: r.notes ?? '',
    created: num(r.created),
    doneAt: r.done_at === null || r.done_at === undefined ? undefined : num(r.done_at),
  }
}

export async function dbGetTasks(): Promise<Task[]> {
  const { rows } = await sql`SELECT * FROM tasks ORDER BY created ASC`
  return rows.map(rowToTask)
}

export async function dbSetTasks(tasks: Task[]): Promise<void> {
  const client = await db.connect()
  try {
    await client.sql`BEGIN`
    await client.sql`DELETE FROM tasks`
    for (const t of tasks) {
      await client.sql`
        INSERT INTO tasks (id, name, col, priority, starred, due_date, notes, created, done_at)
        VALUES (${t.id}, ${t.name}, ${t.col}, ${t.priority}, ${t.starred},
                ${t.due_date}, ${t.notes ?? ''}, ${t.created}, ${t.doneAt ?? null})`
    }
    await client.sql`COMMIT`
  } catch (e) {
    await client.sql`ROLLBACK`
    throw e
  } finally {
    client.release()
  }
}

/* ---------------------------------- Goals --------------------------------- */

function rowToGoal(r: any): Goal {
  return { id: r.id, name: r.name, current: num(r.current), target: num(r.target), notes: r.notes ?? '' }
}

export async function dbGetGoals(): Promise<Goal[]> {
  const { rows } = await sql`SELECT * FROM goals ORDER BY id ASC`
  return rows.map(rowToGoal)
}

export async function dbSetGoals(goals: Goal[]): Promise<void> {
  const client = await db.connect()
  try {
    await client.sql`BEGIN`
    await client.sql`DELETE FROM goals`
    for (const g of goals) {
      await client.sql`
        INSERT INTO goals (id, name, current, target, notes)
        VALUES (${g.id}, ${g.name}, ${g.current}, ${g.target}, ${g.notes ?? ''})`
    }
    await client.sql`COMMIT`
  } catch (e) {
    await client.sql`ROLLBACK`
    throw e
  } finally {
    client.release()
  }
}

/* --------------------------------- Clients -------------------------------- */

function rowToClient(r: any): CRMClient {
  return {
    id: r.id,
    name: r.name,
    company: r.company ?? undefined,
    vertical: r.vertical,
    paymentType: r.payment_type,
    amount: r.amount === null || r.amount === undefined ? null : num(r.amount),
    termDays: numOrUndef(r.term_days),
    outstanding: num(r.outstanding),
    nextPaymentDue: r.next_payment_due,
    nextContact: r.next_contact,
    churnRisk: r.churn_risk,
    adStatus: r.ad_status,
    adHealth: r.ad_health ?? undefined,
    nextAction: r.next_action ?? '',
    notes: r.notes ?? '',
  }
}

export async function dbGetClients(): Promise<CRMClient[]> {
  const { rows } = await sql`SELECT * FROM clients ORDER BY id ASC`
  return rows.map(rowToClient)
}

export async function dbSetClients(clients: CRMClient[]): Promise<void> {
  const client = await db.connect()
  try {
    await client.sql`BEGIN`
    await client.sql`DELETE FROM clients`
    for (const c of clients) {
      await client.sql`
        INSERT INTO clients (id, name, company, vertical, payment_type, amount, term_days,
                             outstanding, next_payment_due, next_contact, churn_risk,
                             ad_status, ad_health, next_action, notes)
        VALUES (${c.id}, ${c.name}, ${c.company ?? null}, ${c.vertical}, ${c.paymentType},
                ${c.amount ?? null}, ${c.termDays ?? null}, ${c.outstanding}, ${c.nextPaymentDue},
                ${c.nextContact}, ${c.churnRisk}, ${c.adStatus}, ${c.adHealth ?? null},
                ${c.nextAction ?? ''}, ${c.notes ?? ''})`
    }
    await client.sql`COMMIT`
  } catch (e) {
    await client.sql`ROLLBACK`
    throw e
  } finally {
    client.release()
  }
}

/* ------------------------------ Relationships ----------------------------- */

function rowToRelationship(r: any): Relationship {
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    channel: r.channel,
    whyContact: r.why_contact,
    freqDays: num(r.freq_days),
    lastContacted: r.last_contacted,
    notes: r.notes ?? '',
  }
}

export async function dbGetRelationships(): Promise<Relationship[]> {
  const { rows } = await sql`SELECT * FROM relationships ORDER BY id ASC`
  return rows.map(rowToRelationship)
}

export async function dbSetRelationships(relationships: Relationship[]): Promise<void> {
  const client = await db.connect()
  try {
    await client.sql`BEGIN`
    await client.sql`DELETE FROM relationships`
    for (const r of relationships) {
      await client.sql`
        INSERT INTO relationships (id, name, role, channel, why_contact, freq_days, last_contacted, notes)
        VALUES (${r.id}, ${r.name}, ${r.role}, ${r.channel}, ${r.whyContact},
                ${r.freqDays}, ${r.lastContacted}, ${r.notes ?? ''})`
    }
    await client.sql`COMMIT`
  } catch (e) {
    await client.sql`ROLLBACK`
    throw e
  } finally {
    client.release()
  }
}

/* ----------------------------------- Docs --------------------------------- */

function rowToDoc(r: any): Doc {
  return { id: r.id, name: r.name, url: r.url, tag: r.tag }
}

export async function dbGetDocs(): Promise<Doc[]> {
  const { rows } = await sql`SELECT * FROM docs ORDER BY id ASC`
  return rows.map(rowToDoc)
}

export async function dbSetDocs(docs: Doc[]): Promise<void> {
  const client = await db.connect()
  try {
    await client.sql`BEGIN`
    await client.sql`DELETE FROM docs`
    for (const d of docs) {
      await client.sql`INSERT INTO docs (id, name, url, tag) VALUES (${d.id}, ${d.name}, ${d.url}, ${d.tag})`
    }
    await client.sql`COMMIT`
  } catch (e) {
    await client.sql`ROLLBACK`
    throw e
  } finally {
    client.release()
  }
}

/* -------------------------------- Daily logs ------------------------------ */

function rowToLog(r: any): DailyLog {
  return {
    date: r.date,
    sleep: numOrUndef(r.sleep),
    feeling: numOrUndef(r.feeling),
    exerciseHours: numOrUndef(r.exercise_hours),
    caloriesBurned: numOrUndef(r.calories_burned),
    stepsTaken: numOrUndef(r.steps_taken),
    caloriesEaten: numOrUndef(r.calories_eaten),
    energy: numOrUndef(r.energy),
    winsToday: r.wins_today ?? undefined,
    challenges: r.challenges ?? undefined,
    tomorrowsFocus: r.tomorrows_focus ?? undefined,
  }
}

export async function dbGetDailyLog(date: string): Promise<DailyLog | null> {
  const { rows } = await sql`SELECT * FROM daily_logs WHERE date = ${date}`
  return rows.length ? rowToLog(rows[0]) : null
}

export async function dbSetDailyLog(date: string, log: DailyLog): Promise<void> {
  await sql`
    INSERT INTO daily_logs (date, sleep, feeling, exercise_hours, calories_burned,
                            steps_taken, calories_eaten, energy, wins_today, challenges, tomorrows_focus)
    VALUES (${date}, ${log.sleep ?? null}, ${log.feeling ?? null}, ${log.exerciseHours ?? null},
            ${log.caloriesBurned ?? null}, ${log.stepsTaken ?? null}, ${log.caloriesEaten ?? null},
            ${log.energy ?? null}, ${log.winsToday ?? null}, ${log.challenges ?? null}, ${log.tomorrowsFocus ?? null})
    ON CONFLICT (date) DO UPDATE SET
      sleep = EXCLUDED.sleep, feeling = EXCLUDED.feeling, exercise_hours = EXCLUDED.exercise_hours,
      calories_burned = EXCLUDED.calories_burned, steps_taken = EXCLUDED.steps_taken,
      calories_eaten = EXCLUDED.calories_eaten, energy = EXCLUDED.energy,
      wins_today = EXCLUDED.wins_today, challenges = EXCLUDED.challenges, tomorrows_focus = EXCLUDED.tomorrows_focus`
}

// Consecutive days (back from today) that have a logged energy value.
export async function dbGetLogStreak(): Promise<number> {
  const { rows } = await sql`SELECT date FROM daily_logs WHERE energy IS NOT NULL`
  const dates = new Set(rows.map((r: any) => r.date))
  let streak = 0
  const today = new Date()
  for (let i = 0; i < 365; i++) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    if (dates.has(d.toISOString().split('T')[0])) streak++
    else break
  }
  return streak
}

/* ------------------------------- Daily habits ----------------------------- */

function rowToHabits(r: any): DailyHabits {
  return { date: r.date, gym: r.gym, eatHealthy: r.eat_healthy, deepWork: r.deep_work, eodDone: r.eod_done }
}

export async function dbGetDailyHabits(date: string): Promise<DailyHabits | null> {
  const { rows } = await sql`SELECT * FROM daily_habits WHERE date = ${date}`
  return rows.length ? rowToHabits(rows[0]) : null
}

export async function dbSetDailyHabits(date: string, habits: DailyHabits): Promise<void> {
  await sql`
    INSERT INTO daily_habits (date, gym, eat_healthy, deep_work, eod_done)
    VALUES (${date}, ${habits.gym}, ${habits.eatHealthy}, ${habits.deepWork}, ${habits.eodDone})
    ON CONFLICT (date) DO UPDATE SET
      gym = EXCLUDED.gym, eat_healthy = EXCLUDED.eat_healthy,
      deep_work = EXCLUDED.deep_work, eod_done = EXCLUDED.eod_done`
}
