import { NextResponse } from 'next/server'
import { Anthropic } from '@anthropic-ai/sdk'

const FATHOM_API_URL = 'https://api.fathom.ai/external/v1'
const client = new Anthropic()

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

// GET /api/meetings/brief
// Meetings from the last 3 days, each with 2–5 action items extracted from the
// transcript by Claude. Summaries are intentionally dropped.
export async function GET() {
  try {
    const apiKey = process.env.FATHOM_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'Fathom API key not configured' }, { status: 500 })

    const res = await fetch(`${FATHOM_API_URL}/meetings?include_transcript=true&limit=25`, {
      headers: { 'X-Api-Key': apiKey },
    })
    if (!res.ok) throw new Error(`Fathom API error: ${res.statusText}`)
    const items = (await res.json()).items || []

    const cutoff = Date.now() - 3 * 86400000
    const recent = items
      .filter((m: any) => new Date(m.created_at).getTime() >= cutoff)
      .slice(0, 6)

    const meetings = await Promise.all(
      recent.map(async (m: any) => {
        const base = {
          id: m.recording_id ?? m.url,
          title: m.meeting_title || m.title || 'Untitled meeting',
          date: m.created_at,
          url: m.share_url || m.url,
        }
        const transcript = Array.isArray(m.transcript) ? m.transcript : []
        if (transcript.length === 0) return { ...base, actionItems: [] }

        const text = transcript
          .map((e: any) => `${e.speaker?.display_name || '?'}: ${e.text}`)
          .join('\n')
          .slice(0, 8000)

        try {
          const completion = await client.messages.create({
            model: 'claude-sonnet-5',
            max_tokens: 1024,
            messages: [
              {
                role: 'user',
                content:
                  `From this meeting transcript, extract 2 to 5 concrete action items for Aryan ` +
                  `(the person running these sales/scaling calls). Each item short and specific. ` +
                  `Return ONLY a JSON array of strings — no prose.\n\nTranscript:\n${text}`,
              },
            ],
          })
          const textBlock = completion.content.find((b) => b.type === 'text') as
            | { type: 'text'; text: string }
            | undefined
          let actionItems: string[] = []
          const raw = textBlock?.text || '[]'
          const s = raw.indexOf('[')
          const e = raw.lastIndexOf(']')
          if (s >= 0 && e > s) {
            const parsed = JSON.parse(raw.slice(s, e + 1))
            if (Array.isArray(parsed)) actionItems = parsed.map(String).slice(0, 5)
          }
          return { ...base, actionItems }
        } catch (err) {
          console.error('action-item extraction failed:', err)
          return { ...base, actionItems: [] }
        }
      })
    )

    return NextResponse.json({ meetings })
  } catch (error) {
    console.error('meetings brief error:', error)
    return NextResponse.json({ error: 'Failed to build meeting brief' }, { status: 500 })
  }
}
