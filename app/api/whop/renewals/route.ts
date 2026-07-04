import { NextResponse } from 'next/server'

const WHOP_API_URL = 'https://api.whop.com/api/v2'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

// Active Whop memberships with an upcoming renewal date, keyed by member email.
// Clients can be matched to these to sync their next-payment date.
export async function GET() {
  try {
    const apiKey = process.env.WHOP_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'Whop API key not configured' }, { status: 500 })

    const renewals: { email: string; renewalDate: string; membershipId: string }[] = []
    let page = 1
    let totalPages = 1
    do {
      const res = await fetch(`${WHOP_API_URL}/memberships?page=${page}&per=50`, {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      })
      if (!res.ok) throw new Error(`Whop API error: ${res.statusText}`)
      const data = await res.json()
      totalPages = data.pagination?.total_page ?? 1
      for (const m of data.data || []) {
        if (m.valid && typeof m.renewal_period_end === 'number' && m.email) {
          renewals.push({
            email: m.email,
            renewalDate: new Date(m.renewal_period_end * 1000).toISOString().slice(0, 10),
            membershipId: m.id,
          })
        }
      }
      page += 1
    } while (page <= totalPages && page <= 50)

    return NextResponse.json({ renewals })
  } catch (error) {
    console.error('Whop renewals error:', error)
    return NextResponse.json({ error: 'Failed to fetch Whop renewals' }, { status: 500 })
  }
}
