import { unstable_cache } from 'next/cache'
import { BOOKING_CHANNELS, CACHE_SECONDS, CLINICS } from '@/lib/clinics/config'
import type { SlackBookings, Window } from '@/lib/clinics/types'

// Per-clinic bookings from the pod appointment-notification channels (server-side only).
// Token: SLACK_BOT_TOKEN; the bot must be in each channel (public needs channels:history,
// private needs groups:history). Posts look like:
//   ":moneybag:NEW UNCONFIRMED CONSULTATION BOOKED! … Client: Regenestem LLC  Contact Name: …  Consultation Date and Time: …"
//   ":moneybag: CONFIRMED APPOINTMENT BOOKED … Client: Vitale health LLC …"
// Each post is matched to a clinic via its `slackClient` pattern. Pickups aren't posted anywhere in Slack.

export type BookingEvent = { type: 'booked' | 'confirmed'; client: string; contact: string; when: string }

export function parseBooking(raw: string): BookingEvent | null {
  const text = raw.replace(/[*_]/g, '').replace(/ /g, ' ')
  const type = /CONFIRMED APPOINTMENT BOOKED/i.test(text) && !/UNCONFIRMED/i.test(text) ? 'confirmed' : /UNCONFIRMED CONSULTATION BOOKED/i.test(text) ? 'booked' : null
  if (!type) return null
  const field = (label: string) => text.match(new RegExp(`${label}:\\s*(.+)`, 'i'))?.[1].trim() || ''
  return { type, client: field('Client'), contact: field('Contact Name').toLowerCase().replace(/\s+/g, ' '), when: field('Consultation Date and Time') }
}

async function fetchHistory(channel: string, oldest: number, latest: number): Promise<{ text: string }[]> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) throw new Error('SLACK_BOT_TOKEN not set')
  const out: { text: string }[] = []
  let cursor = ''
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({ channel, oldest: String(oldest), latest: String(latest), limit: '200', ...(cursor ? { cursor } : {}) })
    const res = await fetch(`https://slack.com/api/conversations.history?${qs}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
    const data = await res.json()
    if (!data.ok) {
      if (data.error === 'not_in_channel' || data.error === 'channel_not_found') throw new Error(`dashboard bot can't read ${channel} — invite @genexa_dashboard`)
      if (data.error === 'missing_scope') throw new Error(`dashboard bot missing scope ${data.needed || ''} for ${channel}`)
      throw new Error(`Slack: ${data.error}`)
    }
    out.push(...(data.messages || []).map((m: any) => ({ text: m.text || '' })))
    cursor = data.response_metadata?.next_cursor || ''
    if (!cursor) break
  }
  return out
}
// Cached 15 min; errors (bot not in channel) aren't cached, so fixing access shows up on next load.
const history = unstable_cache(fetchHistory, ['slack-booking-history-v1'], { revalidate: CACHE_SECONDS, tags: ['clinic-kpis'] })

// Clinic name → Slack booking counts for the window. A clinic is "connected" when its own pod's
// channel was readable; events are matched from every readable channel.
export async function fetchSlackBookings(window: Window): Promise<Record<string, SlackBookings>> {
  const oldest = Math.floor(window.start.getTime() / 1000)
  const latest = Math.floor(window.end.getTime() / 1000)
  const errors: Record<string, string> = {}
  const events: BookingEvent[] = []
  await Promise.all(
    Object.entries(BOOKING_CHANNELS).map(async ([label, channel]) => {
      try {
        for (const m of await history(channel, oldest, latest)) {
          const e = parseBooking(m.text)
          if (e) events.push(e)
        }
      } catch (e) {
        errors[label] = (e as Error).message
      }
    })
  )

  const out: Record<string, SlackBookings> = {}
  for (const c of CLINICS) {
    const mine = events.filter((e) => c.slackClient?.test(e.client))
    // De-dupe re-posts of the same booking; a contact booked then confirmed counts once in each.
    const uniq = (t: BookingEvent['type']) => new Set(mine.filter((e) => e.type === t).map((e) => `${e.contact}|${e.when}`)).size
    const contacts = (t?: BookingEvent['type']) => new Set(mine.filter((e) => !t || e.type === t).map((e) => e.contact)).size
    const pod = c.bookingPod ?? c.pod
    const err = !BOOKING_CHANNELS[pod] ? `no Slack booking channel configured for ${pod}` : errors[pod]
    out[c.name] = {
      connected: !err,
      error: err,
      booked: uniq('booked'),
      confirmed: uniq('confirmed'),
      allBookings: contacts(), // unique patients with any booking post
      confirmedPatients: contacts('confirmed'),
    }
  }
  return out
}
