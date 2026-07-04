import { NextRequest, NextResponse } from 'next/server'

const CORTANA_API_URL = 'https://app.usecortana.ai/api/v1'
// Genexa Scaling — used when no businessId is supplied and no env default is set.
const DEFAULT_BUSINESS_ID = '893e8bff-93f9-41b2-b85b-0e98b5bafb7d'

export const dynamic = 'force-dynamic'

// GET /api/cortana/attribution?businessId=&startDate=&endDate=
// Returns a top-line ROAS/CPA summary plus a per-source attribution breakdown.
export async function GET(request: NextRequest) {
  try {
    const apiKey = process.env.CORTANA_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'Cortana API key not configured' }, { status: 500 })
    }

    const sp = request.nextUrl.searchParams
    const businessId =
      sp.get('businessId') || process.env.CORTANA_DEFAULT_BUSINESS_ID || DEFAULT_BUSINESS_ID

    // Default window: trailing 30 days. Cortana requires full ISO datetimes.
    const now = new Date()
    const startDate = sp.get('startDate') || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const endDate = sp.get('endDate') || now.toISOString()

    const url =
      `${CORTANA_API_URL}/businesses/${businessId}/attribution` +
      `?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`Cortana API error ${response.status}: ${text.slice(0, 200)}`)
    }

    const json = await response.json()
    const rows: any[] = json?.data?.data || []

    // Per-source breakdown (only the fields a dashboard needs).
    const sources = rows.map((r) => ({
      source: r.dimension,
      spent: r.spent || 0,
      leads: r.leads || 0,
      conversions: r.totalConversions || 0,
      revenue: r.totalLTV || 0, // Cortana's actual-revenue (LTV) view
      directRevenue: r.totalRevenue || 0,
      roas: r.roas,
      costPerLead: r.costPerLead,
      costPerConversion: r.costPerConversion,
    }))

    // Blended top-line summary across all sources.
    let spent = 0
    let revenue = 0
    let directRevenue = 0
    let leads = 0
    let conversions = 0
    for (const s of sources) {
      spent += s.spent
      revenue += s.revenue
      directRevenue += s.directRevenue
      leads += s.leads
      conversions += s.conversions
    }

    const summary = {
      spent,
      revenue,
      directRevenue,
      leads,
      conversions,
      roas: spent > 0 ? revenue / spent : null,
      costPerLead: leads > 0 ? spent / leads : null,
      costPerConversion: conversions > 0 ? spent / conversions : null,
    }

    return NextResponse.json({ businessId, startDate, endDate, summary, sources })
  } catch (error) {
    console.error('Cortana attribution error:', error)
    return NextResponse.json({ error: 'Failed to fetch Cortana attribution' }, { status: 500 })
  }
}
