import { NextRequest, NextResponse } from 'next/server'
import { dbGetRelationships, dbSetRelationships } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    return NextResponse.json(await dbGetRelationships())
  } catch (error) {
    console.error('relationships GET error:', error)
    return NextResponse.json({ error: 'Failed to load relationships' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  try {
    await dbSetRelationships(await request.json())
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('relationships PUT error:', error)
    return NextResponse.json({ error: 'Failed to save relationships' }, { status: 500 })
  }
}
