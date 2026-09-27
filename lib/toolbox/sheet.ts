import { sql } from '@vercel/postgres'
import { ROSTER_SHEET_ID } from '@/lib/toolbox/config'
import { ensureEodTables } from '@/lib/toolbox/eod'

// Jacob's "Retainer Clients" sheet (public link): the live client roster plus tonight's results.
// Columns: A client · B status · C niche · D sender · E SMS blast size · F leads today ·
//          G price/week · H LTV · I additional info (usually the price, e.g. "$350/week") ·
//          J notes · K billing email under FanBasis.
// Leads are overwritten every evening (8–11:30pm UK), so a nightly snapshot builds the history.

export type RosterStatus = 'active' | 'paused' | 'failed_pay' | 'canceled'
export type RosterRow = {
  client: string
  status: RosterStatus
  statusLabel: string
  niche: string | null
  sender: string
  smsBlast: number
  leadsToday: number | null
  price: { amount: number; per: 'week' | 'month' | 'estimate' | 'day' } | null
  priceText: string
  emails: string[]
  notes: string
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (ch !== '\r') cell += ch
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

const num = (s: string | undefined) => {
  const n = Number((s || '').replace(/[$,\s]/g, ''))
  return (s || '').trim() !== '' && isFinite(n) ? n : null
}

// "$350/week", "$65/estimate", "$1800/Monthly", "$750/week", "$450 for his first week"
export function parsePrice(text: string): RosterRow['price'] {
  const m = text.match(/\$\s*([\d,]+(?:\.\d+)?)/)
  if (!m) return null
  const amount = Number(m[1].replace(/,/g, ''))
  const per = /estimate/i.test(text) ? 'estimate' : /month/i.test(text) ? 'month' : /day|daily/i.test(text) ? 'day' : 'week'
  return amount ? { amount, per } : null
}

const STATUS: [RegExp, RosterStatus][] = [
  [/^active/i, 'active'],
  [/pause/i, 'paused'],
  [/fail/i, 'failed_pay'],
  [/cancel|disput/i, 'canceled'],
]

export async function fetchRoster(): Promise<RosterRow[]> {
  const url = `https://docs.google.com/spreadsheets/d/${ROSTER_SHEET_ID}/gviz/tq?tqx=out:csv&headers=0&sheet=${encodeURIComponent('Retainer Clients')}`
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`Retainer Clients sheet: ${res.status}`)
  const rows = parseCsv(await res.text())
  return rows
    .slice(1)
    .filter((r) => (r[0] || '').trim() && (r[1] || '').trim())
    .map((r) => {
      const statusLabel = r[1].trim()
      const priceText = [r[6], r[8]].map((x) => (x || '').trim()).filter((x) => /\$/.test(x))[0] || ''
      return {
        client: r[0].trim(),
        status: STATUS.find(([re]) => re.test(statusLabel))?.[1] ?? 'paused',
        statusLabel,
        niche: (r[2] || '').trim() || null,
        sender: (r[3] || '').trim(),
        smsBlast: num(r[4]) ?? 0,
        leadsToday: num(r[5]),
        price: parsePrice(priceText),
        priceText,
        emails: Array.from(new Set(((r[10] || '').match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || []).map((e) => e.toLowerCase()))),
        notes: (r[9] || '').trim(),
      }
    })
}

// US-Eastern calendar date (the day the sends happened) and UK hour, for snapshot timing.
function clock(now: Date) {
  const et = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(now)
  const get = (t: string) => et.find((p) => p.type === t)?.value || ''
  const ukHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }).format(now)) % 24
  const ukMin = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', minute: '2-digit' }).format(now))
  return { date: `${get('year')}-${get('month')}-${get('day')}`, weekday: get('weekday'), ukMinutes: ukHour * 60 + ukMin }
}

// Save tonight's leads as that day's EOD rows (file_id "sheet:YYYY-MM-DD"). Idempotent — a later
// run the same night replaces the rows. Only runs once the sheet is done for the night
// (23:30–06:00 UK), on weekdays, and skips if nothing changed since the previous snapshot.
export async function snapshotRoster(now = new Date(), opts: { force?: boolean } = {}) {
  const { date, weekday, ukMinutes } = clock(now)
  if (!opts.force) {
    if (weekday === 'Sat' || weekday === 'Sun') return { saved: 0, skipped: 'weekend' }
    if (!(ukMinutes >= 23 * 60 + 30 || ukMinutes < 6 * 60)) return { saved: 0, skipped: 'sheet still being updated (snapshots after 23:30 UK)' }
  }
  await ensureEodTables()
  const roster = await fetchRoster()
  const rows = roster.filter((r) => r.status === 'active' && r.leadsToday !== null)
  if (!rows.length) return { saved: 0, skipped: 'no results on the sheet' }

  // Stale sheet (not updated today) looks identical to the last snapshot — don't double count.
  const sig = rows.map((r) => `${r.client}:${r.leadsToday}`).sort().join('|')
  const { rows: prev } = await sql`SELECT file_id FROM toolbox_eod_files WHERE file_id LIKE 'sheet:%' AND file_id <> ${`sheet:${date}`} ORDER BY file_id DESC LIMIT 1`
  if (prev[0]) {
    const { rows: last } = await sql`SELECT client, leads FROM toolbox_eod_rows WHERE file_id = ${prev[0].file_id}`
    if (last.map((r) => `${r.client}:${Number(r.leads)}`).sort().join('|') === sig) return { saved: 0, skipped: 'sheet unchanged since last snapshot' }
  }

  const fileId = `sheet:${date}`
  await sql`DELETE FROM toolbox_eod_rows WHERE file_id = ${fileId}`
  for (const [i, r] of rows.entries()) {
    await sql`INSERT INTO toolbox_eod_rows (file_id, idx, date, client, niche, sms_sent, leads, delivered, sender)
      VALUES (${fileId}, ${i}, ${date}, ${r.client}, ${r.niche}, ${r.smsBlast}, ${r.leadsToday}, ${null}, ${r.sender})`
  }
  await sql`INSERT INTO toolbox_eod_files (file_id, posted_at, processed_at, row_count, error) VALUES (${fileId}, ${now.getTime()}, ${now.getTime()}, ${rows.length}, NULL)
    ON CONFLICT (file_id) DO UPDATE SET posted_at = EXCLUDED.posted_at, processed_at = EXCLUDED.processed_at, row_count = EXCLUDED.row_count, error = NULL`
  return { saved: rows.length, date }
}
