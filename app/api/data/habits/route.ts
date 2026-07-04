import { NextRequest, NextResponse } from 'next/server'
import { dbGetDailyHabits, dbSetDailyHabits } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

// GET /api/data/habits?date=YYYY-MM-DD → DailyHabits | null
export async function GET(request: NextRequest) {
  try {
    const date = request.nextUrl.searchParams.get('date')
    if (!date) return NextResponse.json({ error: 'date required' }, { status: 400 })
    return NextResponse.json(await dbGetDailyHabits(date))
  } catch (error) {
    console.error('habits GET error:', error)
    return NextResponse.json({ error: 'Failed to load habits' }, { status: 500 })
  }
}

// PUT /api/data/habits  body: { date, habits }
export async function PUT(request: NextRequest) {
  try {
    const { date, habits } = await request.json()
    if (!date) return NextResponse.json({ error: 'date required' }, { status: 400 })
    await dbSetDailyHabits(date, habits)
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('habits PUT error:', error)
    return NextResponse.json({ error: 'Failed to save habits' }, { status: 500 })
  }
}
