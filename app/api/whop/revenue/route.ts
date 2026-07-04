import { NextResponse } from 'next/server'

const WHOP_API_URL = 'https://api.whop.com/api/v2'

export const dynamic = 'force-dynamic'

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

    let mtdRevenue = 0
    let currency = 'usd'
    let page = 1
    let totalPages = 1

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
        if (typeof paidAt === 'number' && paidAt >= startOfMonth) {
          mtdRevenue += payment.final_amount ?? payment.total ?? 0
          if (payment.currency) currency = payment.currency
        }
      }

      page += 1
    } while (page <= totalPages && page <= 50)

    return NextResponse.json({ mtdRevenue, currency })
  } catch (error) {
    console.error('Whop revenue error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch Whop revenue' },
      { status: 500 }
    )
  }
}
