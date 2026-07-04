import { NextRequest, NextResponse } from 'next/server'
import { fixieFetch } from '@/lib/fixieFetch'

const MERCURY_API_URL = 'https://api.mercury.com/api/v1'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

// GET /api/finance/series?days=N
// Daily checking + credit-card balance over the last N days. Checking is
// reconstructed backwards from the current balance using transaction history;
// credit is held at its current value (Mercury exposes no credit history).
export async function GET(request: NextRequest) {
  try {
    const apiKey = process.env.MERCURY_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'Mercury API key not configured' }, { status: 500 })

    const days = Math.min(Math.max(Number(request.nextUrl.searchParams.get('days')) || 30, 1), 400)
    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }

    // Current balances
    const accRes = await fixieFetch(`${MERCURY_API_URL}/accounts`, { headers })
    const accounts = accRes.ok ? (await accRes.json()).accounts || [] : []
    const currentChecking = accounts.reduce((s: number, a: any) => s + (a.availableBalance || 0), 0)

    let currentCredit = 0
    try {
      const credRes = await fixieFetch(`${MERCURY_API_URL}/credit`, { headers })
      if (credRes.ok) {
        const cd = await credRes.json()
        currentCredit = -(cd.accounts || []).reduce((s: number, a: any) => s + (a.currentBalance || 0), 0)
      }
    } catch {}

    // Transactions across the window
    const start = new Date(Date.now() - days * 86400000).toISOString()
    const end = new Date().toISOString()
    const params = new URLSearchParams({ start, end, limit: '500' })
    params.append('status[]', 'sent')
    params.append('status[]', 'pending')
    const txRes = await fixieFetch(`${MERCURY_API_URL}/transactions?${params}`, { headers })
    const txs = txRes.ok ? (await txRes.json()).transactions || [] : []

    // Net change per day
    const netByDay: Record<string, number> = {}
    for (const t of txs) {
      const day = (t.postedAt || t.createdAt || '').slice(0, 10)
      if (day) netByDay[day] = (netByDay[day] || 0) + (t.amount || 0)
    }

    // Walk forward from the reconstructed start balance to today's known balance.
    const totalNet = Object.values(netByDay).reduce((s, n) => s + n, 0)
    let bal = currentChecking - totalNet
    const series: { date: string; checking: number; credit: number }[] = []
    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
      bal += netByDay[day] || 0
      series.push({ date: day, checking: Math.round(bal), credit: Math.round(currentCredit) })
    }

    return NextResponse.json({ series, checking: currentChecking, credit: currentCredit })
  } catch (error) {
    console.error('finance series error:', error)
    return NextResponse.json({ error: 'Failed to build finance series' }, { status: 500 })
  }
}
