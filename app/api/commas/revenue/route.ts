import { NextResponse } from 'next/server'

// Commas (Jacob's SMS business) runs on the Fanbasis public API.
const COMMAS_API_URL = 'https://www.fanbasis.com/public-api'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

// Gross Commas revenue (amount minus refunds) since the start of the current month (UTC),
// plus a 30-day daily series. Transactions come back newest-first.
export async function GET() {
  try {
    const apiKey = process.env.COMMAS_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'Commas API key not configured' }, { status: 500 })
    }

    const now = new Date()
    const startOfMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    const DAYS = 30
    const startOfWindow = Date.now() - DAYS * 86400000
    const cutoff = Math.min(startOfMonth, startOfWindow)

    let mtdRevenue = 0
    let mtdNet = 0
    const daily: Record<string, number> = {} // 'YYYY-MM-DD' -> revenue
    let page = 1
    let done = false

    // Walk pages until we pass the cutoff. Capped at 20 pages as a safety valve.
    while (!done && page <= 20) {
      const response = await fetch(`${COMMAS_API_URL}/checkout-sessions/transactions?per_page=100&page=${page}`, {
        headers: { 'x-api-key': apiKey, Accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`Commas API error: ${response.statusText}`)

      const data = (await response.json()).data || {}
      const txs = data.transactions || []

      for (const t of txs) {
        const ts = new Date(t.transaction_date).getTime()
        if (!ts) continue
        if (ts < cutoff) {
          done = true
          break
        }
        const refunded = (t.refunds || []).reduce((s: number, r: any) => s + (Number(r.amount) || 0), 0)
        const amount = (Number(t.amount) || 0) - refunded
        if (ts >= startOfMonth) {
          mtdRevenue += amount
          mtdNet += (Number(t.net_amount) || 0) - refunded
        }
        if (ts >= startOfWindow) {
          const day = new Date(ts).toISOString().slice(0, 10)
          daily[day] = (daily[day] || 0) + amount
        }
      }

      if (!data.pagination?.has_more || txs.length === 0) done = true
      page += 1
    }

    const series: { date: string; revenue: number }[] = []
    for (let i = DAYS - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
      series.push({ date: d, revenue: Math.round((daily[d] || 0) * 100) / 100 })
    }

    return NextResponse.json({
      mtdRevenue: Math.round(mtdRevenue * 100) / 100,
      mtdNet: Math.round(mtdNet * 100) / 100,
      series,
    })
  } catch (error) {
    console.error('Commas revenue error:', error)
    return NextResponse.json({ error: 'Failed to fetch Commas revenue' }, { status: 500 })
  }
}
