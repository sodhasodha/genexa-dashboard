import { NextResponse } from 'next/server'
import { getCalendarClient, isGoogleConfigured } from '@/lib/google'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

export async function GET() {
  try {
    if (!isGoogleConfigured()) {
      return NextResponse.json(
        { error: 'Google Calendar credentials not configured' },
        { status: 500 }
      )
    }

    const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary'
    const calendar = getCalendarClient()

    // Window: start of today through the end of tomorrow (local time).
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const endOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2)

    const response = await calendar.events.list({
      calendarId,
      timeMin: startOfToday.toISOString(),
      timeMax: endOfTomorrow.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    })

    return NextResponse.json({
      events: response.data.items || [],
    })
  } catch (error) {
    console.error('Google Calendar error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch calendar events' },
      { status: 500 }
    )
  }
}
