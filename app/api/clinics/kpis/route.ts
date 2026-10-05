import { NextRequest, NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import { cortanaSource } from '@/lib/clinics/cortana'
import { fetchSlackBookings } from '@/lib/clinics/slack'
import { MOCK_ROSTER, mockSlackBookings, mockSource } from '@/lib/clinics/mock'
import { fetchRoster } from '@/lib/clinics/roster'
import { buildReport, makeWindow, summarise } from '@/lib/clinics/kpis'
import type { ClinicRaw, ClinicSource, ClinicsResponse, SlackBookings, WindowKey } from '@/lib/clinics/types'

export const dynamic = 'force-dynamic'

const WINDOWS: WindowKey[] = ['7d', '30d', 'mtd']

async function build(windowKey: WindowKey, mock: boolean): Promise<ClinicsResponse> {
  const window = makeWindow(windowKey)
  const source: ClinicSource = mock ? mockSource : cortanaSource
  const CLINICS = mock ? MOCK_ROSTER : await fetchRoster()
  const [raws, slack] = await Promise.all([
    Promise.all(
      CLINICS.map((c) =>
        source.fetchClinic(c, window).catch(
          (e): ClinicRaw => ({
            error: (e as Error).message,
            spend: 0,
            impressions: 0,
            linkClicks: 0,
            leads: 0,
            leadsFrom: 'cortana',
            booked: 0,
            confirmed: 0,
            shown: 0,
            purchases: 0,
            revenue: 0,
            tracked: { lead: false, booked: false, confirmed: false, shown: false, purchase: false },
            daily: [],
            lastLeadDate: null,
            lastSpendDate: null,
            excludedCampaigns: 0,
          })
        )
      )
    ),
    mock ? Promise.resolve(mockSlackBookings()) : fetchSlackBookings(window, CLINICS).catch(() => ({}) as Record<string, SlackBookings>),
  ])

  const clinics = CLINICS.map((c, i) => buildReport(c, raws[i], slack[c.name] ?? null, window)).sort((a, b) => b.worst - a.worst)
  const failed = raws.filter((r) => r.error).length
  const slackStates = Object.values(slack)
  return {
    window: windowKey,
    start: window.start.toISOString(),
    end: window.end.toISOString(),
    days: window.days,
    generatedAt: new Date().toISOString(),
    mock,
    sources: {
      cortana: mock ? 'mock' : failed === 0 ? 'live' : failed === CLINICS.length ? 'error' : `live · ${failed} failed`,
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
    const w = (sp.get('window') || '7d') as WindowKey
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
