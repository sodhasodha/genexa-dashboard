import { NextRequest, NextResponse } from 'next/server'
import { fixieFetch } from '@/lib/fixieFetch'

const MERCURY_API_URL = 'https://api.mercury.com/api/v1'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const start = searchParams.get('start') || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const end = searchParams.get('end') || new Date().toISOString()

    const apiKey = process.env.MERCURY_API_KEY

    if (!apiKey) {
      return NextResponse.json(
        { error: 'Mercury API key not configured' },
        { status: 500 }
      )
    }

    const params = new URLSearchParams({
      start,
      end,
      limit: '100',
    })

    params.append('status[]', 'pending')
    params.append('status[]', 'sent')

    const response = await fixieFetch(`${MERCURY_API_URL}/transactions?${params}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      throw new Error(`Mercury API error: ${response.statusText}`)
    }

    const data = await response.json()

    return NextResponse.json({
      transactions: data.transactions || [],
    })
  } catch (error) {
    console.error('Mercury transactions error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch Mercury transactions' },
      { status: 500 }
    )
  }
}
