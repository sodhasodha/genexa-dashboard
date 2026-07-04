import { NextResponse } from 'next/server'
import { dbGetLogStreak } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

// GET /api/data/logs/streak → { streak: number }
export async function GET() {
  try {
    return NextResponse.json({ streak: await dbGetLogStreak() })
  } catch (error) {
    console.error('streak GET error:', error)
    return NextResponse.json({ streak: 0 })
  }
}
