import { NextRequest, NextResponse } from 'next/server'
import { dbGetDocs, dbSetDocs } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

export async function GET() {
  try {
    return NextResponse.json(await dbGetDocs())
  } catch (error) {
    console.error('docs GET error:', error)
    return NextResponse.json({ error: 'Failed to load docs' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  try {
    await dbSetDocs(await request.json())
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('docs PUT error:', error)
    return NextResponse.json({ error: 'Failed to save docs' }, { status: 500 })
  }
}
