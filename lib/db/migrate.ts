import { sql } from '@vercel/postgres'
import type { CRMClient, Relationship } from '../types'
import { dbSetClients, dbSetRelationships } from '../db'

// DDL kept in sync with lib/db/schema.sql. Executed statement-by-statement so
// it works over the pooled connection (which runs one statement per query).
const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS tasks (
     id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', col TEXT NOT NULL DEFAULT 'backlog',
     priority TEXT NOT NULL DEFAULT 'normal', starred BOOLEAN NOT NULL DEFAULT false,
     due_date TEXT, notes TEXT NOT NULL DEFAULT '', created BIGINT NOT NULL DEFAULT 0, done_at BIGINT)`,
  `CREATE TABLE IF NOT EXISTS goals (
     id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', current NUMERIC NOT NULL DEFAULT 0,
     target NUMERIC NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS clients (
     id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', company TEXT, vertical TEXT NOT NULL DEFAULT 'Genexa',
     payment_type TEXT NOT NULL DEFAULT 'Recurring', amount NUMERIC, term_days INTEGER,
     outstanding NUMERIC NOT NULL DEFAULT 0, next_payment_due TEXT, next_contact TEXT,
     churn_risk TEXT NOT NULL DEFAULT 'Low', ad_status TEXT NOT NULL DEFAULT 'Active', ad_health TEXT,
     next_action TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS relationships (
     id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '',
     channel TEXT NOT NULL DEFAULT '', why_contact TEXT NOT NULL DEFAULT '', freq_days INTEGER NOT NULL DEFAULT 0,
     last_contacted TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS docs (
     id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', tag TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS daily_logs (
     date TEXT PRIMARY KEY, sleep NUMERIC, feeling NUMERIC, exercise_hours NUMERIC, calories_burned NUMERIC,
     steps_taken NUMERIC, calories_eaten NUMERIC, energy NUMERIC, wins_today TEXT, challenges TEXT, tomorrows_focus TEXT)`,
  `CREATE TABLE IF NOT EXISTS daily_habits (
     date TEXT PRIMARY KEY, gym BOOLEAN NOT NULL DEFAULT false, eat_healthy BOOLEAN NOT NULL DEFAULT false,
     deep_work BOOLEAN NOT NULL DEFAULT false, eod_done BOOLEAN NOT NULL DEFAULT false)`,
]

export const SEED_CLIENTS: CRMClient[] = [
  { id: 'c1', name: 'Dr Gabriel', company: 'Multivita', vertical: 'Genexa', paymentType: 'Payment Plan', amount: 3000, termDays: 30, churnRisk: 'Medium', adStatus: 'Active', adHealth: 'Great', outstanding: 3000, nextPaymentDue: '', nextContact: '', nextAction: '', notes: '' },
  { id: 'c2', name: 'Dr Darren', company: 'Pivotal Health Florida', vertical: 'Genexa', paymentType: 'Payment Plan', amount: 2000, termDays: 30, churnRisk: 'Medium', adStatus: 'Active', adHealth: 'Working on it', outstanding: 2000, nextPaymentDue: '', nextContact: '', nextAction: '', notes: '' },
  { id: 'c3', name: 'Dr Chris Calapai', company: 'CC Medical', vertical: 'Genexa', paymentType: 'Paid in Full', amount: 2000, termDays: 60, churnRisk: 'Medium', adStatus: 'Payment Error', adHealth: 'Working on it', outstanding: 2000, nextPaymentDue: '', nextContact: '', nextAction: '', notes: '' },
  { id: 'c4', name: 'Dr Paul and Marc', company: 'Alt Health Healing', vertical: 'Genexa', paymentType: 'Payment Plan', amount: 4000, termDays: 30, churnRisk: 'High', adStatus: 'Active', adHealth: 'Working on it', outstanding: 0, nextPaymentDue: '', nextContact: '', nextAction: '', notes: '' },
  { id: 'c5', name: 'Dr Russell Smith', company: 'TBC', vertical: 'Genexa', paymentType: 'Payment Plan', amount: 5000, termDays: 30, churnRisk: 'Low', adStatus: 'Active', adHealth: 'Great', outstanding: 5000, nextPaymentDue: '', nextContact: '', nextAction: '', notes: '' },
  { id: 'c6', name: 'Dr Tarick', company: 'TBC', vertical: 'Genexa', paymentType: 'Recurring', amount: 399, termDays: 30, churnRisk: 'Low', adStatus: 'Active', adHealth: 'Great', outstanding: 399, nextPaymentDue: '', nextContact: '', nextAction: '', notes: '' },
  { id: 'c7', name: 'Naveen', company: 'Consulting', vertical: 'Consulting', paymentType: 'Recurring', amount: null, termDays: null, churnRisk: 'Low', adStatus: 'N/A', adHealth: 'N/A', outstanding: 0, nextPaymentDue: '', nextContact: '', nextAction: '', notes: '' },
  { id: 'c8', name: 'Franklyn', company: 'Consulting', vertical: 'Consulting', paymentType: 'Recurring', amount: null, termDays: null, churnRisk: 'Low', adStatus: 'N/A', adHealth: 'N/A', outstanding: 0, nextPaymentDue: '', nextContact: '', nextAction: '', notes: '' },
  { id: 'c9', name: 'Scott', company: 'Groundwork Scaling', vertical: 'Groundwork', paymentType: 'Recurring', amount: 1500, termDays: 30, churnRisk: 'Low', adStatus: 'Active', adHealth: 'Great', outstanding: 1500, nextPaymentDue: '', nextContact: '', nextAction: '', notes: '' },
  { id: 'c10', name: 'Jacob Ray', company: 'Toolbox Growth', vertical: 'Toolbox', paymentType: 'Recurring', amount: null, termDays: null, churnRisk: 'Low', adStatus: 'N/A', adHealth: 'N/A', outstanding: 0, nextPaymentDue: '', nextContact: '', nextAction: '', notes: '' },
]

export const SEED_RELATIONSHIPS: Relationship[] = [
  { id: 'r1', name: 'Cameron England', role: 'Mentor', channel: 'Slack', whyContact: 'Monthly mentorship and licensing check-in', freqDays: 30, lastContacted: new Date().toISOString().slice(0, 10), notes: '' },
  { id: 'r2', name: 'Jacob', role: 'Employee', channel: 'Slack', whyContact: 'Business performance and profit split review', freqDays: 14, lastContacted: new Date().toISOString().slice(0, 10), notes: '' },
]

// Idempotent: creates tables if missing and seeds clients/relationships only
// when their tables are empty (so it never clobbers existing data on re-run).
export async function migrate(): Promise<{ created: boolean; seededClients: number; seededRelationships: number }> {
  for (const stmt of DDL) {
    await sql.query(stmt)
  }

  let seededClients = 0
  let seededRelationships = 0

  const { rows: cCount } = await sql`SELECT COUNT(*)::int AS n FROM clients`
  if (cCount[0].n === 0) {
    await dbSetClients(SEED_CLIENTS)
    seededClients = SEED_CLIENTS.length
  }

  const { rows: rCount } = await sql`SELECT COUNT(*)::int AS n FROM relationships`
  if (rCount[0].n === 0) {
    await dbSetRelationships(SEED_RELATIONSHIPS)
    seededRelationships = SEED_RELATIONSHIPS.length
  }

  return { created: true, seededClients, seededRelationships }
}
