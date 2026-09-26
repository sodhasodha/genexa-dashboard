import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@vercel/postgres'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

// Manual finance overrides, e.g. expense status set by Aryan ("expense:<merchantKey>" → "Cancel").
async function ensureTable() {
  await sql`CREATE TABLE IF NOT EXISTS finance_overrides (
    key     TEXT PRIMARY KEY,
    value   TEXT   NOT NULL,
    updated BIGINT NOT NULL DEFAULT 0
  )`
}

export async function GET() {
  try {
    await ensureTable()
    const { rows } = await sql`SELECT key, value FROM finance_overrides`
    return NextResponse.json(Object.fromEntries(rows.map((r) => [r.key, r.value])))
  } catch (error) {
    console.error('finance overrides GET error:', error)
    return NextResponse.json({ error: 'Failed to load overrides' }, { status: 500 })
  }
}

// PUT { key, value } — value null/'' clears the override.
export async function PUT(request: NextRequest) {
  try {
    const { key, value } = await request.json()
    if (typeof key !== 'string' || !key) return NextResponse.json({ error: 'key required' }, { status: 400 })
    await ensureTable()
    if (!value) await sql`DELETE FROM finance_overrides WHERE key = ${key}`
    else
      await sql`INSERT INTO finance_overrides (key, value, updated) VALUES (${key}, ${String(value)}, ${Date.now()})
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated = EXCLUDED.updated`
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('finance overrides PUT error:', error)
    return NextResponse.json({ error: 'Failed to save override' }, { status: 500 })
  }
}
