// Jacob's Cold SMS finance sheet (updated manually each month).
// Each month tab has: revenue items (B/C), software (E/F), staff (H/I), others (K/L),
// and a SUMMARY block (N/O) with REVENUE / EXPENSES / NET CASH FLOW.
// Revenue in the sheet = Fanbasis/Whop withdrawals (net of processor fees) — kept for reconciliation only;
// the dashboard takes revenue from Commas and costs from here.

const SHEET_ID = '1XgIchjyFd3VA5Cqga1dtO7XZ6RzBUODLX9foqxvvX3c'
const SHEET_YEAR = 2026
const MONTH_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER']
// Tab names as they are in the sheet (September's tab is "SEPT").
const MONTH_TABS = MONTH_NAMES.map((m) => (m === 'SEPTEMBER' ? 'SEPT' : m))

export type SheetItem = { name: string; amount: number; group: 'software' | 'staff' | 'other' }
export type SheetMonth = {
  month: string // 'YYYY-MM'
  revenue: number
  expenses: number
  netCashFlow: number
  software: number
  staff: number
  other: number
  items: SheetItem[]
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

const money = (s: string | undefined): number => {
  if (!s) return 0
  const n = Number(s.replace(/[$,\s]/g, ''))
  return isFinite(n) ? n : 0
}

async function fetchTab(tab: string): Promise<string[][]> {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&headers=0&sheet=${encodeURIComponent(tab)}`
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`Sheet ${tab}: ${res.statusText}`)
  return parseCsv(await res.text())
}

// Google returns the first tab (YEAR SUMMARY) when a tab name doesn't exist, so check the
// month title in the tab before trusting its numbers.
const isMonthTab = (rows: string[][], name: string) => rows.slice(0, 3).some((r) => r.some((c) => c.trim().toUpperCase() === name))

function parseMonth(rows: string[][], month: string): SheetMonth {
  let revenue = 0
  let expenses = 0
  let netCashFlow = 0
  const totals = { software: 0, staff: 0, other: 0 }
  const items: SheetItem[] = []
  const skip = /^(item|name|total|revenue|software|staff|others)$/i

  for (const r of rows) {
    // Summary block (col N label, col O value).
    const label = (r[13] || '').trim().toUpperCase()
    if (label === 'REVENUE') revenue = money(r[14])
    if (label === 'EXPENSES') expenses = money(r[14])
    if (label === 'NET CASH FLOW') netCashFlow = money(r[14])
    // Totals row.
    if ((r[4] || '').toUpperCase().startsWith('TOTAL SOFTWARE')) totals.software = money(r[5])
    if ((r[7] || '').toUpperCase().startsWith('TOTAL STAFF')) totals.staff = money(r[8])
    if ((r[10] || '').toUpperCase().startsWith('TOTAL OTHERS')) totals.other = money(r[11])
    // Line items.
    const push = (name: string | undefined, amount: string | undefined, group: SheetItem['group']) => {
      const n = (name || '').trim()
      const a = money(amount)
      if (n && a && !skip.test(n) && !/^total/i.test(n)) items.push({ name: n, amount: a, group })
    }
    push(r[4], r[5], 'software')
    push(r[7], r[8], 'staff')
    push(r[10], r[11], 'other')
  }
  // Some tabs don't have a totals row filled in — fall back to summing items.
  for (const g of ['software', 'staff', 'other'] as const) {
    if (!totals[g]) totals[g] = items.filter((i) => i.group === g).reduce((s, i) => s + i.amount, 0)
  }
  if (!expenses) expenses = totals.software + totals.staff + totals.other
  if (!netCashFlow) netCashFlow = revenue - expenses
  return { month, revenue, expenses, netCashFlow, ...totals, items }
}

// Months up to the current one that have any figures entered.
export async function fetchColdSmsSheet(): Promise<SheetMonth[]> {
  const now = new Date()
  const lastIdx = now.getUTCFullYear() > SHEET_YEAR ? 11 : now.getUTCMonth()
  const tabs = MONTH_TABS.slice(0, lastIdx + 1)
  const parsed = await Promise.all(
    tabs.map(async (tab, i) => {
      try {
        const month = `${SHEET_YEAR}-${String(i + 1).padStart(2, '0')}`
        const rows = await fetchTab(tab)
        if (!isMonthTab(rows, MONTH_NAMES[i])) throw new Error(`Sheet tab ${tab} not found`)
        return parseMonth(rows, month)
      } catch {
        return null
      }
    })
  )
  return parsed.filter((m): m is SheetMonth => !!m && (m.revenue > 0 || m.expenses > 0))
}

/* ------------------------- Costs Jacob hasn't entered yet ------------------------- */
export type CostEstimate = { name: string; amount: number }

const NOT_A_VENDOR = new Set(MONTH_NAMES.flatMap((m) => [m.toLowerCase(), m.slice(0, 3).toLowerCase()]).concat(['sept', 'beg', 'st', 'nd', 'rd', 'th']))

// "Sendivo may 25th-July1st" → "sendivo", "4/20/2026 percy" → "percy", "Jennifer march 9th" → "jen".
function vendorKey(name: string): string {
  const word = name.toLowerCase().split(/[^a-z]+/).find((w) => w.length >= 2 && !NOT_A_VENDOR.has(w)) || ''
  return word.startsWith('jen') ? 'jen' : word
}

// Regular software / staff costs missing from each month, estimated from the previous three
// months. A cost counts as regular when it is in all three (an estimate counts, so a gap in one
// month doesn't hide the next), and at least one of the three must be a figure Jacob entered,
// so a cancelled tool stops being estimated after three months. "Others" are one-offs — never guessed.
export function estimateMissingCosts(sheet: SheetMonth[]): Record<string, CostEstimate[]> {
  const out: Record<string, CostEstimate[]> = {}
  const history: { actual: Record<string, number>; filled: Set<string>; label: Record<string, string> }[] = []
  for (const m of [...sheet].filter((x) => x.expenses > 0).sort((a, b) => a.month.localeCompare(b.month))) {
    const actual: Record<string, number> = {}
    const label: Record<string, string> = {}
    const entered = new Set<string>()
    for (const it of m.items) {
      const k = vendorKey(it.name)
      if (!k) continue
      entered.add(k)
      if (it.group === 'other') continue
      actual[k] = (actual[k] || 0) + it.amount
      label[k] = label[k] || it.name.trim().split(/\s+/)[0]
    }
    const prior = history.slice(-3)
    const estimates: CostEstimate[] = []
    if (prior.length === 3) {
      for (const k of Array.from(prior[2].filled)) {
        if (entered.has(k) || !prior.every((p) => p.filled.has(k))) continue
        const known = prior.filter((p) => p.actual[k]).map((p) => p.actual[k])
        if (!known.length) continue
        const name = prior.map((p) => p.label[k]).filter(Boolean).pop() || k
        estimates.push({ name, amount: Math.round((known.reduce((s, v) => s + v, 0) / known.length) * 100) / 100 })
        label[k] = name
      }
    }
    if (estimates.length) out[m.month] = estimates
    history.push({ actual, filled: new Set([...Object.keys(actual), ...estimates.map((e) => vendorKey(e.name))]), label })
  }
  return out
}
