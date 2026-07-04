import { NextRequest, NextResponse } from 'next/server'
import { dbGetGoals, dbSetGoals } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    return NextResponse.json(await dbGetGoals())
  } catch (error) {
    console.error('goals GET error:', error)
    return NextResponse.json({ error: 'Failed to load goals' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  try {
    await dbSetGoals(await request.json())
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('goals PUT error:', error)
    return NextResponse.json({ error: 'Failed to save goals' }, { status: 500 })
  }
}
