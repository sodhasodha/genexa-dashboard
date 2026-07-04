import { NextResponse } from 'next/server'

const FATHOM_API_URL = 'https://api.fathom.ai/external/v1'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const apiKey = process.env.FATHOM_API_KEY

    if (!apiKey) {
      return NextResponse.json(
        { error: 'Fathom API key not configured' },
        { status: 500 }
      )
    }

    const response = await fetch(`${FATHOM_API_URL}/meetings?limit=10`, {
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      throw new Error(`Fathom API error: ${response.statusText}`)
    }

    const data = await response.json()
    const items = data.items || []

    const meetings = items.slice(0, 7).map((m: any) => ({
      id: m.recording_id ?? m.url,
      title: m.meeting_title || m.title || 'Untitled meeting',
      date: m.created_at,
      url: m.share_url || m.url,
      summary: m.default_summary || null,
      actionItems: m.action_items || [],
      attendees: (m.calendar_invitees || [])
        .filter((i: any) => i.is_external)
        .map((i: any) => i.name)
        .filter(Boolean),
    }))

    return NextResponse.json({ meetings })
  } catch (error) {
    console.error('Fathom meetings error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch Fathom meetings' },
      { status: 500 }
    )
  }
}
