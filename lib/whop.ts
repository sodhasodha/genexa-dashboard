const WHOP_API_URL = 'https://api.whop.com/api/v2'

function headers() {
  const apiKey = process.env.WHOP_API_KEY
  if (!apiKey) throw new Error('Whop API key not configured')
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
}

// Walk every page of a Whop v2 list endpoint.
async function fetchAll(path: string): Promise<any[]> {
  const out: any[] = []
  let page = 1
  let totalPages = 1
  do {
    const sep = path.includes('?') ? '&' : '?'
    const res = await fetch(`${WHOP_API_URL}${path}${sep}page=${page}&per=50`, { headers: headers() })
    if (!res.ok) throw new Error(`Whop API error: ${res.statusText}`)
    const data = await res.json()
    totalPages = data.pagination?.total_page ?? 1
    out.push(...(data.data || []))
    page += 1
  } while (page <= totalPages && page <= 50)
  return out
}

export const fetchWhopPayments = () => fetchAll('/payments')
export const fetchWhopMemberships = () => fetchAll('/memberships?valid=true')
export async function fetchWhopProducts(): Promise<Record<string, string>> {
  const map: Record<string, string> = {}
  for (const p of await fetchAll('/products')) map[p.id] = p.name || p.title || ''
  return map
}
export async function fetchWhopPlans(): Promise<Record<string, any>> {
  const map: Record<string, any> = {}
  for (const p of await fetchAll('/plans')) map[p.id] = p
  return map
}

export const whopCustomerName = (p: any): string =>
  p.billing_address?.name || [p.billing_first_name, p.billing_last_name].filter(Boolean).join(' ') || p.email || 'Unknown'
