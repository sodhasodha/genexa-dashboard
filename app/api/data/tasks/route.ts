import { NextRequest, NextResponse } from 'next/server'
import { dbGetTasks, dbSetTasks } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

export async function GET() {
  try {
    return NextResponse.json(await dbGetTasks())
  } catch (error) {
    console.error('tasks GET error:', error)
    return NextResponse.json({ error: 'Failed to load tasks' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  try {
    await dbSetTasks(await request.json())
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('tasks PUT error:', error)
    return NextResponse.json({ error: 'Failed to save tasks' }, { status: 500 })
  }
}
