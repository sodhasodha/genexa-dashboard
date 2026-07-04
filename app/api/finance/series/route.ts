import { NextRequest, NextResponse } from 'next/server'
import { fixieFetch } from '@/lib/fixieFetch'

const MERCURY_API_URL = 'https://api.mercury.com/api/v1'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

// Reconstruct a daily ending-balance series for one account, working backwards
// from the current balance through its transaction history (forward-walk form).
function reconstruct(currentBalance: number, txs: any[], days: number): number[] {
  const netByDay: Record<string, number> = {}
  for (const t of txs) {
    const day = (t.postedAt || t.createdAt || '').slice(0, 10)
    if (day) netByDay[day] = (netByDay[day] || 0) + (t.amount || 0)
  }
  const totalNet = Object.values(netByDay).reduce((s, n) => s + n, 0)
  let bal = currentBalance - totalNet
  const out: number[] = []
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
    bal += netByDay[day] || 0
    out.push(bal)
  }
  return out
}

// GET /api/finance/series?days=N
// Two lines: Checking account balance, and Credit Card Total Balance (amount owed),
// both reconstructed from their Mercury transaction history over the window.
export async function GET(request: NextRequest) {
  try {
    const apiKey = process.env.MERCURY_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'Mercury API key not configured' }, { status: 500 })

    const days = Math.min(Math.max(Number(request.nextUrl.searchParams.get('days')) || 30, 1), 400)
    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    const start = new Date(Date.now() - days * 86400000).toISOString()
    const end = new Date().toISOString()
    const txQuery = (id: string) => {
      const p = new URLSearchParams({ start, end, limit: '500' })
      p.append('status[]', 'sent')
      p.append('status[]', 'pending')
      return `${MERCURY_API_URL}/account/${id}/transactions?${p}`
    }
    const jget = async (url: string) => {
      const r = await fixieFetch(url, { headers })
      return r.ok ? r.json() : null
    }

    // Checking account (depository) + Credit card account.
    const accData = await jget(`${MERCURY_API_URL}/accounts`)
    const accounts = accData?.accounts || []
    const checking = accounts.find((a: any) => a.kind === 'checking') || accounts[0] || {}
    const checkingBal = checking.availableBalance ?? 0

    const credData = await jget(`${MERCURY_API_URL}/credit`)
    const creditAcct = (credData?.accounts || [])[0] || {}
    const creditRaw = creditAcct.currentBalance ?? 0 // negative = amount owed
    const creditTotalBalance = -creditRaw // positive amount owed = card Total Balance

    // Reconstruct both lines.
    const [checkingTx, creditTx] = await Promise.all([
      checking.id ? jget(txQuery(checking.id)) : null,
      creditAcct.id ? jget(txQuery(creditAcct.id)) : null,
    ])
    const checkingSeries = reconstruct(checkingBal, checkingTx?.transactions || [], days)
    const creditRawSeries = reconstruct(creditRaw, creditTx?.transactions || [], days)

    const series = checkingSeries.map((c, i) => ({
      date: new Date(Date.now() - (days - 1 - i) * 86400000).toISOString().slice(0, 10),
      checking: Math.round(c),
      credit: Math.round(-creditRawSeries[i]), // owed (Total Balance) as a positive line
    }))

    return NextResponse.json({ series, checking: checkingBal, credit: creditTotalBalance })
  } catch (error) {
    console.error('finance series error:', error)
    return NextResponse.json({ error: 'Failed to build finance series' }, { status: 500 })
  }
}
