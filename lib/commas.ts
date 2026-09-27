// Commas (FanBasis) — Cold SMS client payments. Key: COMMAS_API_KEY.

const COMMAS_API_URL = 'https://www.fanbasis.com/public-api'

export type CommasTx = {
  id: string
  ts: number
  customerId: string // FanBasis fan id (stable per customer)
  name: string
  email: string
  amount: number
  fee: number
  product: string
  paymentType: string // 'auto_renew' | 'upfront'
  refunds: { ts: number; amount: number }[]
}

export async function fetchCommasTransactions(): Promise<CommasTx[]> {
  const apiKey = process.env.COMMAS_API_KEY
  if (!apiKey) throw new Error('Commas API key not configured')
  const out: CommasTx[] = []
  let page = 1
  let more = true
  while (more && page <= 50) {
    const res = await fetch(`${COMMAS_API_URL}/checkout-sessions/transactions?per_page=100&page=${page}`, {
      headers: { 'x-api-key': apiKey, Accept: 'application/json' },
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`Commas API error: ${res.statusText}`)
    const data = (await res.json()).data || {}
    const txs = data.transactions || []
    for (const t of txs) {
      const ts = new Date(t.transaction_date).getTime()
      if (!ts) continue
      out.push({
        id: String(t.id),
        ts,
        customerId: t.fan?.id || t.fan?.email || String(t.id),
        name: (t.fan?.name || '').trim(),
        email: t.fan?.email || '',
        amount: Number(t.amount) || 0,
        fee: Number(t.fee_amount) || 0,
        product: t.product?.title || t.service?.title || '',
        paymentType: t.servicePayment?.payment_type || '',
        refunds: (t.refunds || []).map((rf: any) => ({ ts: new Date(rf.created_at).getTime() || ts, amount: Number(rf.amount) || 0 })),
      })
    }
    more = !!data.pagination?.has_more && txs.length > 0
    page += 1
  }
  return out
}
