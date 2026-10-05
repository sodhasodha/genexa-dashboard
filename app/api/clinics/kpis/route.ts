import { NextRequest, NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import { cortanaSource, unboundRaw } from '@/lib/clinics/cortana'
import { fetchSlackBookings } from '@/lib/clinics/slack'
import { MOCK_ROSTER, mockSlackBookings, mockSource } from '@/lib/clinics/mock'
import { fetchRoster } from '@/lib/clinics/roster'
import { buildReport, flagDuplicates, makeWindow, prevWindow, summarise, windowLabel } from '@/lib/clinics/kpis'
import type { ClinicRaw, ClinicSource, ClinicsResponse, SlackBookings, WindowKey } from '@/lib/clinics/types'

export const dynamic = 'force-dynamic'

const WINDOWS: WindowKey[] = ['7d', '30d', 'mtd']

async function build(windowKey: WindowKey, mock: boolean): Promise<ClinicsResponse> {
  const window = makeWindow(windowKey)
  const prev = prevWindow(window)
  const source: ClinicSource = mock ? mockSource : cortanaSource
  const CLINICS = mock ? MOCK_ROSTER : await fetchRoster()
  const failAll = (e: unknown) => {
    const cur = CLINICS.map((): ClinicRaw => ({ ...unboundRaw(), bound: true, error: (e as Error).message }))
    return { cur, prev: cur }
  }
  const [{ cur: raws, prev: prevRaws }, slack] = await Promise.all([
    source.fetchAll(CLINICS, window, prev).catch(failAll),
    mock ? Promise.resolve(mockSlackBookings()) : fetchSlackBookings(window, CLINICS).catch(() => ({}) as Record<string, SlackBookings>),
  ])

  flagDuplicates(CLINICS, raws)
  flagDuplicates(CLINICS, prevRaws)
  const clinics = CLINICS.map((c, i) => buildReport(c, raws[i], slack[c.name] ?? null, window, prevRaws[i])).sort((a, b) => b.worst - a.worst)
  const failed = raws.filter((r) => r.error).length
  const dupes = raws.filter((r) => r.dataError).length
  const slackStates = Object.values(slack)
  return {
    window: windowKey,
    start: window.start.toISOString(),
    end: window.end.toISOString(),
    days: window.days,
    label: windowLabel(window),
    prevLabel: windowLabel(prev, false),
    generatedAt: new Date().toISOString(),
    mock,
    sources: {
      cortana: mock ? 'mock' : failed === 0 ? (dupes ? `live · ${dupes} data errors` : 'live') : failed === CLINICS.length ? 'error' : `live · ${failed} failed`,
      slack: mock
        ? 'mock'
        : slackStates.length && slackStates.every((p) => p.connected)
          ? 'live'
          : slackStates.some((p) => p.connected)
            ? 'partial'
            : 'not connected',
    },
    summary: summarise(clinics),
    clinics,
  }
}

// Upstream calls are cached 15 min each (see cortana.ts / slack.ts); the report itself is cheap to build.

// GET /api/clinics/kpis?window=7d|30d|mtd[&mock=1][&fresh=1]
export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams
    const w = (sp.get('window') || 'mtd') as WindowKey
    if (!WINDOWS.includes(w)) return NextResponse.json({ error: `Unknown window "${w}"` }, { status: 400 })
    const mock = sp.get('mock') === '1'
    if (mock) return NextResponse.json(await build(w, true))
    if (sp.get('fresh') === '1') revalidateTag('clinic-kpis') // Refresh button: drop the cache, rebuild
    return NextResponse.json(await build(w, false))
  } catch (error) {
    console.error('clinic kpis error:', error)
    return NextResponse.json({ error: 'Failed to build clinic KPIs' }, { status: 500 })
  }
}
