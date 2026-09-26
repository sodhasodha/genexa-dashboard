const MONDAY_API_URL = 'https://api.monday.com/v2'
const CLIENTS_BOARD = 5094961079

// CLIENTS board column ids.
const COL = {
  fullName: 'text_mm2kk9q3',
  retainer: 'numeric_mm2kav1e',
  stage: 'color_mm7chs4k',
  health: 'color_mm7cqza5',
  billingCycle: 'color_mm7c9ep4',
  renewalStatus: 'color_mm7cm5py',
  lastPayment: 'date_mm7ctzwa',
  lastPaymentAmount: 'numeric_mm7cmv02',
  nextRenewal: 'date_mm7cn1hp',
  monthlyFee: 'numeric_mm7c80mf',
}

export type MondayClient = {
  name: string
  url: string | null // Monday item link
  fullName: string
  group: string
  stage: string
  health: string
  billingCycleDays: number | null
  renewalStatus: string
  retainer: number
  lastPayment: string | null
  lastPaymentAmount: number
  nextRenewal: string | null
  monthlyFee: number
  churned: boolean
}

export async function fetchMondayClients(): Promise<MondayClient[]> {
  const apiKey = process.env.MONDAY_API_KEY
  if (!apiKey) throw new Error('Monday API key not configured')
  const ids = Object.values(COL).map((c) => `"${c}"`).join(',')
  const query = `{ boards(ids:[${CLIENTS_BOARD}]){ items_page(limit:500){ items{ name url group{ title } column_values(ids:[${ids}]){ id text } } } } }`
  const res = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json', 'API-Version': '2024-10' },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) throw new Error(`Monday API error: ${res.statusText}`)
  const items = (await res.json()).data?.boards?.[0]?.items_page?.items || []
  return items.map((i: any) => {
    const v: Record<string, string> = {}
    for (const c of i.column_values || []) v[c.id] = c.text || ''
    const num = (id: string) => Number(v[id]) || 0
    const group = i.group?.title || ''
    const stage = v[COL.stage]
    const cycle = v[COL.billingCycle].match(/(\d+)/)
    return {
      name: i.name,
      url: i.url || null,
      fullName: v[COL.fullName],
      group,
      stage,
      health: v[COL.health],
      billingCycleDays: cycle ? Number(cycle[1]) : null,
      renewalStatus: v[COL.renewalStatus],
      retainer: num(COL.retainer),
      lastPayment: v[COL.lastPayment] || null,
      lastPaymentAmount: num(COL.lastPaymentAmount),
      nextRenewal: v[COL.nextRenewal] || null,
      monthlyFee: num(COL.monthlyFee),
      churned: /churn|archive/i.test(group) || /churn/i.test(stage),
    }
  })
}

// Loose match between a Monday client and a Whop customer (name / email).
// Uses distinctive tokens (≥4 chars) from the Monday item + contact name.
const STOP = new Set(['pod', 'health', 'clinic', 'medical', 'center', 'wellness', 'the', 'and'])
export function mondayMatches(client: MondayClient, whopName: string, whopEmail: string): boolean {
  const hay = `${whopName} ${whopEmail}`.toLowerCase()
  const hayCompact = hay.replace(/[^a-z0-9]/g, '')
  const words = new Set(hay.split(/[^a-z0-9]+/))
  const tokens = `${client.name} ${client.fullName}`
    .toLowerCase()
    .replace(/[^a-z ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !STOP.has(t))
  // Whole-word match, or a long token inside an email (e.g. "mcconnell" in dericksmcconnell@…).
  // Short tokens must match whole words so "rick" doesn't match "derick".
  if (tokens.some((t) => words.has(t) || (t.length >= 6 && hayCompact.includes(t)))) return true
  // Multi-word business names written as one word in an email domain (e.g. "Beyond Stem Cells").
  const compactName = client.name.toLowerCase().replace(/pod\s*\d.*$/i, '').replace(/[^a-z]/g, '')
  return compactName.length >= 8 && hayCompact.includes(compactName)
}
