import { NextResponse } from 'next/server'
import { discoverNewFiles, processEodFile } from '@/lib/toolbox/eod'
import { snapshotRoster } from '@/lib/toolbox/sheet'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const PER_RUN = 6 // screenshots per call (each is one Claude vision request)

// Import the day's SMS sender results:
//  1. new EOD screenshots from #sms-senders-eod-as (primary — read with Claude)
//  2. a snapshot of tonight's leads on the Retainer Clients sheet (fallback; ignored for any date
//     that also has a screenshot)
// Runs on Toolbox Clients page load (POST) and nightly via Vercel cron (GET, see vercel.json).
async function sync() {
  const shots = await discoverNewFiles()
  const processed = []
  for (const id of shots.fileIds.slice(0, PER_RUN)) processed.push(await processEodFile(id))
  const failed = processed.filter((p) => p.error)
  const sheet = await snapshotRoster().catch((e) => ({ saved: 0, error: (e as Error).message }))
  return {
    processed,
    pending: Math.max(0, shots.fileIds.length - PER_RUN),
    sheet,
    error: shots.error ?? (failed.length ? `${failed.length} screenshot${failed.length > 1 ? 's' : ''} couldn't be read: ${failed[0].error}` : undefined),
  }
}

export async function POST() {
  try {
    return NextResponse.json(await sync())
  } catch (error) {
    console.error('toolbox sync error:', error)
    return NextResponse.json({ error: (error as Error).message }, { status: 500 })
  }
}
export const GET = POST
