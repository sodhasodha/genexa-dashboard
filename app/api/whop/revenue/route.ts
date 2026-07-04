import { NextResponse } from 'next/server'

const WHOP_API_URL = 'https://api.whop.com/api/v2'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

// Sum of successfully-paid Whop payments since the start of the current month (UTC).
export async function GET() {
  try {
    const apiKey = process.env.WHOP_API_KEY

    if (!apiKey) {
      return NextResponse.json(
        { error: 'Whop API key not configured' },
        { status: 500 }
      )
    }

    const now = new Date()
    const startOfMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000
    const DAYS = 30
    const startOfWindow = Math.floor(Date.now() / 1000) - DAYS * 86400

    let mtdRevenue = 0
    let currency = 'usd'
    let page = 1
    let totalPages = 1
    const daily: Record<string, number> = {} // 'YYYY-MM-DD' -> revenue

    // Paginate through payments, summing paid ones from this month.
    // Capped at 50 pages as a safety valve.
    do {
      const response = await fetch(`${WHOP_API_URL}/payments?page=${page}&per=50`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        throw new Error(`Whop API error: ${response.statusText}`)
      }

      const data = await response.json()
      totalPages = data.pagination?.total_page ?? 1

      for (const payment of data.data || []) {
        if (payment.status !== 'paid') continue
        const paidAt = payment.paid_at ?? payment.created_at
        if (typeof paidAt !== 'number') continue
        const amount = payment.final_amount ?? payment.total ?? 0
        if (payment.currency) currency = payment.currency
        if (paidAt >= startOfMonth) mtdRevenue += amount
        if (paidAt >= startOfWindow) {
          const day = new Date(paidAt * 1000).toISOString().slice(0, 10)
          daily[day] = (daily[day] || 0) + amount
        }
      }

      page += 1
    } while (page <= totalPages && page <= 50)

    // Fill a continuous daily series for the last DAYS days (zero-fill gaps).
    const series: { date: string; revenue: number }[] = []
    for (let i = DAYS - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400 * 1000).toISOString().slice(0, 10)
      series.push({ date: d, revenue: Math.round((daily[d] || 0) * 100) / 100 })
    }

    return NextResponse.json({ mtdRevenue, currency, series })
  } catch (error) {
    console.error('Whop revenue error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch Whop revenue' },
      { status: 500 }
    )
  }
}
