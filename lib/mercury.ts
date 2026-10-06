import { fixieFetch } from '@/lib/fixieFetch'

export const MERCURY_API_URL = 'https://api.mercury.com/api/v1'

// Mercury deposits from these counterparties are Aryan's cold SMS payouts.
const SMS_PAYOUT = /ray media|fanbasis/i
// Transfers to self (owner draws) — not an expense.
const OWNER_DRAW = /aryan.*sodha/i
// Uncategorised card spend in these Mercury categories is personal.
const PERSONAL_MERCURY_CATS = new Set(['Retail', 'Entertainment', 'Restaurants', 'Groceries'])
// Merchants whose spend is always personal, whatever category Mercury gives it (confirmed by Aryan 2026-10-06).
const PERSONAL_MERCHANTS = /acorn\s*fire|amazon|temu|paypal/i
// Card charges that Mercury mislabels (e.g. consulting bought via Whop shows as Entertainment) — always business.
const BUSINESS_MERCHANTS = /whop/i

export type TxClass = 'income' | 'smsPayout' | 'expense' | 'cardRefund' | 'transfer' | 'ownerDraw' | 'personal'

export function mercuryHeaders() {
  const apiKey = process.env.MERCURY_API_KEY
  if (!apiKey) throw new Error('Mercury API key not configured')
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
}

export async function mercuryGet(path: string): Promise<any> {
  const res = await fixieFetch(`${MERCURY_API_URL}${path}`, { headers: mercuryHeaders() })
  if (!res.ok) throw new Error(`Mercury API error: ${res.statusText}`)
  return res.json()
}

// All transactions across accounts (incl. credit card) created since `since`.
export async function fetchMercuryTransactions(since: string, statuses = ['sent', 'pending']): Promise<any[]> {
  const txs: any[] = []
  let cursor = ''
  for (let i = 0; i < 20; i++) {
    const p = new URLSearchParams({ start: since, limit: '1000', order: 'asc' })
    for (const s of statuses) p.append('status[]', s)
    if (cursor) p.set('start_after', cursor)
    const batch = (await mercuryGet(`/transactions?${p}`)).transactions || []
    txs.push(...batch)
    if (batch.length < 1000) break
    cursor = batch[batch.length - 1].id
  }
  return txs
}

export const txTime = (t: any) => new Date(t.postedAt || t.createdAt).getTime()
export const txName = (t: any): string => t.counterpartyName || t.bankDescription || 'Unknown'
// Custom Mercury category wins over Mercury's merchant category.
export const txCategory = (t: any): string => t.categoryData?.name || t.mercuryCategory || 'Uncategorised'

export function classifyTx(t: any): TxClass {
  const name = txName(t)
  const desc = `${t.bankDescription || ''} ${name}`
  if (/^Mercury (Credit|Checking|Savings|Treasury)/i.test(name) || /AUTOPAY/i.test(desc)) return 'transfer' // card payoff / internal
  if (t.kind === 'internalTransfer' || t.kind === 'treasuryTransfer') return 'transfer'
  if (t.amount > 0) {
    if (SMS_PAYOUT.test(name)) return 'smsPayout'
    if (t.kind === 'creditCardCredit') return PERSONAL_MERCHANTS.test(desc) ? 'personal' : 'cardRefund' // a personal refund isn't a business credit
    return 'income'
  }
  if (t.kind !== 'debitCardTransaction' && t.kind !== 'creditCardTransaction' && OWNER_DRAW.test(desc)) return 'ownerDraw'
  if (PERSONAL_MERCHANTS.test(desc)) return 'personal'
  if (!t.categoryData?.name && PERSONAL_MERCURY_CATS.has(t.mercuryCategory) && !BUSINESS_MERCHANTS.test(desc)) return 'personal'
  return 'expense'
}

// Business expenses (positive = spend); card refunds offset spend.
export function businessExpenses(txs: any[]): { ts: number; amount: number; category: string; name: string }[] {
  const out: { ts: number; amount: number; category: string; name: string }[] = []
  for (const t of txs) {
    const c = classifyTx(t)
    if (c === 'expense' || c === 'cardRefund') out.push({ ts: txTime(t), amount: -t.amount, category: txCategory(t), name: txName(t) })
  }
  return out
}
