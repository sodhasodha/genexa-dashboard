import { NextRequest, NextResponse } from 'next/server'
import { dbGetDailyLog, dbSetDailyLog } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

// GET /api/data/logs?date=YYYY-MM-DD → DailyLog | null
export async function GET(request: NextRequest) {
  try {
    const date = request.nextUrl.searchParams.get('date')
    if (!date) return NextResponse.json({ error: 'date required' }, { status: 400 })
    return NextResponse.json(await dbGetDailyLog(date))
  } catch (error) {
    console.error('logs GET error:', error)
    return NextResponse.json({ error: 'Failed to load log' }, { status: 500 })
  }
}

// PUT /api/data/logs  body: { date, log }
export async function PUT(request: NextRequest) {
  try {
    const { date, log } = await request.json()
    if (!date) return NextResponse.json({ error: 'date required' }, { status: 400 })
    await dbSetDailyLog(date, log)
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('logs PUT error:', error)
    return NextResponse.json({ error: 'Failed to save log' }, { status: 500 })
  }
}
