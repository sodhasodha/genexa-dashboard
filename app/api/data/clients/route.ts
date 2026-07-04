import { NextRequest, NextResponse } from 'next/server'
import { dbGetClients, dbSetClients } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    return NextResponse.json(await dbGetClients())
  } catch (error) {
    console.error('clients GET error:', error)
    return NextResponse.json({ error: 'Failed to load clients' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  try {
    await dbSetClients(await request.json())
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('clients PUT error:', error)
    return NextResponse.json({ error: 'Failed to save clients' }, { status: 500 })
  }
}
