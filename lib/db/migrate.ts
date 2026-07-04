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
     payment_type TEXT NOT NULL DEFAULT 'Recurring', amount NUMERIC NOT NULL DEFAULT 0, term INTEGER,
     outstanding NUMERIC NOT NULL DEFAULT 0, next_payment_due TEXT, next_contact_date TEXT,
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
  { id: '1', name: 'Dr Gabriel', company: 'Multivita', vertical: 'Genexa', paymentType: 'Payment Plan', amount: 3000, outstanding: 0, nextPaymentDue: null, nextContactDate: null, churnRisk: 'Medium', adStatus: 'Active', nextAction: '', notes: '' },
  { id: '2', name: 'Dr Darren', company: 'Pivotal Health Florida', vertical: 'Genexa', paymentType: 'Payment Plan', amount: 2000, outstanding: 0, nextPaymentDue: null, nextContactDate: null, churnRisk: 'Medium', adStatus: 'Active', nextAction: '', notes: '' },
  { id: '3', name: 'Dr Chris Calapai', company: 'CC Medical', vertical: 'Genexa', paymentType: 'Paid in Full', amount: 2000, outstanding: 0, nextPaymentDue: null, nextContactDate: null, churnRisk: 'Low', adStatus: 'Payment Error', nextAction: '', notes: '' },
  { id: '4', name: 'Dr Paul and Marc', company: 'Alt Health Healing', vertical: 'Genexa', paymentType: 'Payment Plan', amount: 4000, outstanding: 0, nextPaymentDue: null, nextContactDate: null, churnRisk: 'High', adStatus: 'Active', nextAction: '', notes: '' },
  { id: '5', name: 'Dr Russell Smith', company: 'Genexa', vertical: 'Genexa', paymentType: 'Recurring', amount: 5000, outstanding: 0, nextPaymentDue: null, nextContactDate: null, churnRisk: 'Low', adStatus: 'Active', adHealth: 'Great', nextAction: '', notes: '' },
  { id: '6', name: 'Dr Tarick', company: 'Genexa', vertical: 'Genexa', paymentType: 'Recurring', amount: 399, outstanding: 0, nextPaymentDue: null, nextContactDate: null, churnRisk: 'Low', adStatus: 'Active', nextAction: '', notes: '' },
  { id: '7', name: 'Naveen', company: '', vertical: 'Consulting', paymentType: 'Recurring', amount: 0, outstanding: 0, nextPaymentDue: null, nextContactDate: null, churnRisk: 'Low', adStatus: 'Inactive', nextAction: '', notes: '' },
  { id: '8', name: 'Franklyn', company: '', vertical: 'Consulting', paymentType: 'Recurring', amount: 0, outstanding: 0, nextPaymentDue: null, nextContactDate: null, churnRisk: 'Low', adStatus: 'Inactive', nextAction: '', notes: '' },
  { id: '9', name: 'Scott', company: 'Groundwork Scaling', vertical: 'Groundwork', paymentType: 'Recurring', amount: 1500, outstanding: 0, nextPaymentDue: null, nextContactDate: null, churnRisk: 'Low', adStatus: 'Active', nextAction: '', notes: '' },
  { id: '10', name: 'Jacob Ray', company: '', vertical: 'Toolbox Growth', paymentType: 'Recurring', amount: 0, outstanding: 0, nextPaymentDue: null, nextContactDate: null, churnRisk: 'Low', adStatus: 'Inactive', nextAction: '', notes: '' },
]

export const SEED_RELATIONSHIPS: Relationship[] = [
  { id: '1', name: 'Cameron England', role: 'contact', channel: 'WhatsApp', whyContact: 'Keep in touch', freqDays: 14, lastContacted: new Date().toISOString().split('T')[0], notes: '' },
  { id: '2', name: 'Jacob', role: 'contact', channel: 'Email', whyContact: 'Keep in touch', freqDays: 7, lastContacted: new Date().toISOString().split('T')[0], notes: '' },
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
