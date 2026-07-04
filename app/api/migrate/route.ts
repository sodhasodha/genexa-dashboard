import { NextResponse } from 'next/server'
import { migrate } from '@/lib/db/migrate'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

// POST /api/migrate — create tables and seed initial data (idempotent).
export async function POST() {
  try {
    const result = await migrate()
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    console.error('Migration error:', error)
    return NextResponse.json(
      { ok: false, error: (error as Error).message },
      { status: 500 }
    )
  }
}
