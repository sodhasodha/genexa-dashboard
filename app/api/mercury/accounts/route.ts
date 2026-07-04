import { NextResponse } from 'next/server'
import { fixieFetch } from '@/lib/fixieFetch'

const MERCURY_API_URL = 'https://api.mercury.com/api/v1'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const apiKey = process.env.MERCURY_API_KEY

    if (!apiKey) {
      return NextResponse.json(
        { error: 'Mercury API key not configured' },
        { status: 500 }
      )
    }

    const response = await fixieFetch(`${MERCURY_API_URL}/accounts`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      throw new Error(`Mercury API error: ${response.statusText}`)
    }

    const data = await response.json()
    const accounts = data.accounts || []

    // Checking = total available across depository accounts.
    const checkingBalance = accounts.reduce(
      (sum: number, a: { availableBalance?: number }) => sum + (a.availableBalance || 0),
      0
    )

    // Credit card balance comes from the Mercury IO credit endpoint, not /accounts.
    // Mercury reports the amount owed as a negative currentBalance, so negate it to
    // express the outstanding balance as a positive number owed.
    let creditBalance = 0
    try {
      const creditResponse = await fixieFetch(`${MERCURY_API_URL}/credit`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      })

      if (creditResponse.ok) {
        const creditData = await creditResponse.json()
        creditBalance = -(creditData.accounts || []).reduce(
          (sum: number, a: { currentBalance?: number }) => sum + (a.currentBalance || 0),
          0
        )
      }
    } catch (creditError) {
      console.error('Mercury credit error:', creditError)
    }

    return NextResponse.json({
      accounts,
      checkingBalance,
      creditBalance,
    })
  } catch (error) {
    console.error('Mercury accounts error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch Mercury accounts' },
      { status: 500 }
    )
  }
}
