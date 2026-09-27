import { NextRequest, NextResponse } from 'next/server'
import { unstable_cache } from 'next/cache'
import { fetchCommasTransactions } from '@/lib/commas'
import { eodStatus, loadEodRows } from '@/lib/toolbox/eod'
import { buildToolboxClients, WindowKey } from '@/lib/toolbox/clients'
import { fetchRoster } from '@/lib/toolbox/sheet'

export const dynamic = 'force-dynamic'

const WINDOWS: WindowKey[] = ['7d', '30d', 'mtd']
const commas = unstable_cache(fetchCommasTransactions, ['toolbox-commas-v1'], { revalidate: 15 * 60, tags: ['toolbox'] })
const roster = unstable_cache(fetchRoster, ['toolbox-roster-v1'], { revalidate: 15 * 60, tags: ['toolbox'] })

// GET /api/toolbox/clients?window=7d|30d|mtd
export async function GET(request: NextRequest) {
  try {
    const w = (request.nextUrl.searchParams.get('window') || '7d') as WindowKey
    if (!WINDOWS.includes(w)) return NextResponse.json({ error: `Unknown window "${w}"` }, { status: 400 })
    const errors: string[] = []
    const [txs, sheet, rows, status] = await Promise.all([
      commas().catch((e) => {
        errors.push(`Commas: ${(e as Error).message}`)
        return []
      }),
      roster().catch((e) => {
        errors.push(`Retainer Clients sheet: ${(e as Error).message}`)
        return []
      }),
      loadEodRows(),
      eodStatus(),
    ])
    return NextResponse.json({ ...buildToolboxClients(rows, txs, sheet, w), eod: status, errors, generatedAt: new Date().toISOString() })
  } catch (error) {
    console.error('toolbox clients error:', error)
    return NextResponse.json({ error: 'Failed to build Toolbox clients' }, { status: 500 })
  }
}
