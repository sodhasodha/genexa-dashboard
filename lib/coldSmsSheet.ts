// Jacob's Cold SMS finance sheet (updated manually each month).
// Each month tab has: revenue items (B/C), software (E/F), staff (H/I), others (K/L),
// and a SUMMARY block (N/O) with REVENUE / EXPENSES / NET CASH FLOW.
// Revenue in the sheet = Fanbasis/Whop withdrawals (net of processor fees).

const SHEET_ID = '1XgIchjyFd3VA5Cqga1dtO7XZ6RzBUODLX9foqxvvX3c'
const SHEET_YEAR = 2026
const MONTH_TABS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER']

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
        return parseMonth(await fetchTab(tab), month)
      } catch {
        return null
      }
    })
  )
  return parsed.filter((m): m is SheetMonth => !!m && (m.revenue > 0 || m.expenses > 0))
}
