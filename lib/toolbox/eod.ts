import Anthropic from '@anthropic-ai/sdk'
import { sql } from '@vercel/postgres'
import { EOD_ALIASES, EOD_CHANNEL } from '@/lib/toolbox/config'

// Daily SMS sender results per client, stored in Postgres.
//  - Primary: the screenshots posted to #sms-senders-eod-as (file_id = Slack file id; include
//    delivered rate). Claude reads each screenshot once (ANTHROPIC_API_KEY); the bot needs to be in
//    the channel (SLACK_BOT_TOKEN, channels:history + files:read).
//  - Fallback: a nightly snapshot of the Retainer Clients sheet (file_id "sheet:YYYY-MM-DD", see
//    lib/toolbox/sheet.ts). If a screenshot exists for a date, its rows replace the sheet's.

export type EodRow = {
  fileId: string
  date: string // YYYY-MM-DD
  client: string // as written on the sheet
  niche: string | null
  smsSent: number
  leads: number
  delivered: number | null // %
  sender: string
}

let ready: Promise<void> | null = null
export function ensureEodTables() {
  ready ||= (async () => {
    await sql`CREATE TABLE IF NOT EXISTS toolbox_eod_files (
      file_id TEXT PRIMARY KEY, posted_at BIGINT NOT NULL DEFAULT 0, processed_at BIGINT NOT NULL DEFAULT 0,
      row_count INTEGER NOT NULL DEFAULT 0, error TEXT)`
    await sql`CREATE TABLE IF NOT EXISTS toolbox_eod_rows (
      file_id TEXT NOT NULL, idx INTEGER NOT NULL, date TEXT NOT NULL, client TEXT NOT NULL, niche TEXT,
      sms_sent INTEGER NOT NULL DEFAULT 0, leads INTEGER NOT NULL DEFAULT 0, delivered NUMERIC, sender TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (file_id, idx))`
  })().catch((e) => {
    ready = null
    throw e
  })
  return ready
}

export async function loadEodRows(): Promise<EodRow[]> {
  await ensureEodTables()
  const { rows: all } = await sql`SELECT * FROM toolbox_eod_rows ORDER BY date ASC, file_id ASC, idx ASC`
  // Screenshot rows win over sheet snapshots for the same date.
  const shotDates = new Set(all.filter((r) => !String(r.file_id).startsWith('sheet:')).map((r) => r.date))
  const rows = all.filter((r) => !String(r.file_id).startsWith('sheet:') || !shotDates.has(r.date))
  return rows.map((r) => ({
    fileId: r.file_id,
    date: r.date,
    client: r.client,
    niche: r.niche,
    smsSent: Number(r.sms_sent),
    leads: Number(r.leads),
    delivered: r.delivered === null ? null : Number(r.delivered),
    sender: r.sender,
  }))
}

export async function eodStatus() {
  await ensureEodTables()
  const { rows } = await sql`SELECT COUNT(*)::int AS files, COUNT(*) FILTER (WHERE error IS NOT NULL)::int AS failed, MAX(posted_at) AS last FROM toolbox_eod_files`
  return { files: rows[0].files as number, failed: rows[0].failed as number, lastPostedAt: rows[0].last ? Number(rows[0].last) : null }
}

/* ------------------------------- client names ------------------------------ */
// Canonical client key: the person/business before " - ", sub-account numbers dropped
// ("Robert Cain 3" → "robert cain"). A lone first name keeps the first word of the business so
// "Jessica - DA Tree" and "Jessica - S&F Tree" stay separate clients.
export function normaliseClient(name: string): string {
  const clean = name.toLowerCase().replace(/[^a-z0-9&\s-]/g, ' ').replace(/\s+/g, ' ').trim()
  if (EOD_ALIASES[clean]) return EOD_ALIASES[clean]
  const [head, ...rest] = clean.split(/\s+-\s+|\s-|-\s/)
  let key = head.replace(/\s+\d+$/, '').trim()
  const business = rest.join(' ').trim()
  if (key.split(' ').length === 1 && business) key = `${key} ${business.split(' ')[0]}`
  return EOD_ALIASES[key] ?? key
}

/* -------------------------------- screenshots ------------------------------ */
const EXTRACT_MODEL = 'claude-opus-5'

const EXTRACT_TOOL: Anthropic.Tool = {
  name: 'record_eod_rows',
  description: 'Record every client row from the SMS sender end-of-day sheet screenshot.',
  input_schema: {
    type: 'object',
    properties: {
      rows: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Row date as YYYY-MM-DD (use the DATE column)' },
            client: { type: 'string', description: "Client's name exactly as shown (may be cut off)" },
            niche: { type: ['string', 'null'], description: 'Niche column, or null if the sheet has no niche column' },
            sms_sent: { type: 'integer', description: 'SMS sent/blasted' },
            leads: { type: 'integer', description: 'Leads sent ("no good leads" = 0)' },
            delivered: { type: ['number', 'null'], description: 'Delivered stat rate as a number, e.g. 83.8 for 83.80%' },
            sender: { type: 'string', description: 'SMS sender column' },
          },
          required: ['date', 'client', 'niche', 'sms_sent', 'leads', 'delivered', 'sender'],
        },
      },
    },
    required: ['rows'],
  },
}

async function downloadFile(fileId: string): Promise<{ data: string; mediaType: 'image/png' | 'image/jpeg'; postedAt: number }> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) throw new Error('SLACK_BOT_TOKEN not set')
  const info = await fetch(`https://slack.com/api/files.info?file=${fileId}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }).then((r) => r.json())
  if (!info.ok) throw new Error(`Slack files.info: ${info.error}`)
  const f = info.file
  if (!/^image\/(png|jpeg)$/.test(f.mimetype)) throw new Error(`Not a screenshot (${f.mimetype})`)
  const res = await fetch(f.url_private_download, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
  if (!res.ok) throw new Error(`Slack download ${res.status}`)
  return { data: Buffer.from(await res.arrayBuffer()).toString('base64'), mediaType: f.mimetype, postedAt: (f.created || 0) * 1000 }
}

async function extractRows(image: { data: string; mediaType: 'image/png' | 'image/jpeg' }) {
  const client = new Anthropic()
  const response = await client.messages.create({
    model: EXTRACT_MODEL,
    max_tokens: 16000,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: EXTRACT_TOOL.name },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
          {
            type: 'text',
            text: 'This is a screenshot of a daily SMS sender report. Record every client row in the table (skip the TOTAL row, the header block and empty rows). Copy numbers exactly; strip thousands separators and % signs.',
          },
        ],
      },
    ],
  })
  if (response.stop_reason === 'max_tokens') throw new Error('Extraction cut off (max_tokens)')
  const call = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
  const rows = (call?.input as { rows?: any[] } | undefined)?.rows
  if (!Array.isArray(rows)) throw new Error('No rows extracted')
  return rows
    .filter((r) => r && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && typeof r.client === 'string' && r.client.trim())
    .map((r) => ({
      date: r.date as string,
      client: String(r.client).trim(),
      niche: typeof r.niche === 'string' && r.niche.trim() ? r.niche.trim() : null,
      smsSent: Math.round(Number(r.sms_sent) || 0),
      leads: Math.round(Number(r.leads) || 0),
      // 0% = messages still pending on the sheet, not a real rate.
      delivered: r.delivered === null || r.delivered === undefined || !Number(r.delivered) ? null : Number(r.delivered),
      sender: String(r.sender || '').trim(),
    }))
}

// Read one screenshot and store its rows (idempotent: re-running replaces them).
export async function processEodFile(fileId: string): Promise<{ fileId: string; rows: number; error?: string }> {
  await ensureEodTables()
  try {
    const img = await downloadFile(fileId)
    const rows = await extractRows(img)
    await sql`DELETE FROM toolbox_eod_rows WHERE file_id = ${fileId}`
    for (const [i, r] of rows.entries()) {
      await sql`INSERT INTO toolbox_eod_rows (file_id, idx, date, client, niche, sms_sent, leads, delivered, sender)
        VALUES (${fileId}, ${i}, ${r.date}, ${r.client}, ${r.niche}, ${r.smsSent}, ${r.leads}, ${r.delivered}, ${r.sender})`
    }
    await sql`INSERT INTO toolbox_eod_files (file_id, posted_at, processed_at, row_count, error) VALUES (${fileId}, ${img.postedAt}, ${Date.now()}, ${rows.length}, NULL)
      ON CONFLICT (file_id) DO UPDATE SET posted_at = EXCLUDED.posted_at, processed_at = EXCLUDED.processed_at, row_count = EXCLUDED.row_count, error = NULL`
    return { fileId, rows: rows.length }
  } catch (e) {
    const error = (e as Error).message
    await sql`INSERT INTO toolbox_eod_files (file_id, processed_at, error) VALUES (${fileId}, ${Date.now()}, ${error})
      ON CONFLICT (file_id) DO UPDATE SET processed_at = EXCLUDED.processed_at, error = EXCLUDED.error`
    return { fileId, rows: 0, error }
  }
}

// Screenshots in the channel not yet read successfully (newest first).
export async function discoverNewFiles(): Promise<{ fileIds: string[]; error?: string }> {
  await ensureEodTables()
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) return { fileIds: [], error: 'SLACK_BOT_TOKEN not set' }
  const { rows } = await sql`SELECT file_id FROM toolbox_eod_files WHERE error IS NULL`
  const done = new Set(rows.map((r) => r.file_id as string))
  const found: string[] = []
  let cursor = ''
  for (let page = 0; page < 5; page++) {
    const qs = new URLSearchParams({ channel: EOD_CHANNEL, limit: '200', ...(cursor ? { cursor } : {}) })
    const data = await fetch(`https://slack.com/api/conversations.history?${qs}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }).then((r) => r.json())
    if (!data.ok) return { fileIds: [], error: `Slack: ${data.error}${data.error === 'not_in_channel' ? ' — invite @genexa_dashboard to #sms-senders-eod-as' : ''}` }
    const fresh = (data.messages || []).flatMap((m: any) => (m.files || []).filter((f: any) => /^image\//.test(f.mimetype || '') && !done.has(f.id)).map((f: any) => f.id as string))
    found.push(...fresh)
    cursor = data.response_metadata?.next_cursor || ''
    // Older pages are already processed once a page has nothing new.
    if (!cursor || !fresh.length) break
  }
  return { fileIds: found }
}
