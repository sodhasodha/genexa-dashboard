// Cortana REST client (server-side only, read-only). Key: CORTANA_API_KEY.
// Cortana rate-limits at ~60 calls/min, so calls run a few at a time and a 429 is retried after a pause.

const CORTANA_API_URL = 'https://app.usecortana.ai/api/v1'
const MAX_CONCURRENT = 5
const MAX_TRIES = 4

let active = 0
const waiting: (() => void)[] = []
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r))
  active++
  try {
    return await fn()
  } finally {
    active--
    waiting.shift()?.()
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function cortanaGet(path: string): Promise<any> {
  const apiKey = process.env.CORTANA_API_KEY
  if (!apiKey) throw new Error('CORTANA_API_KEY not set')
  return slot(async () => {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${CORTANA_API_URL}/${path}`, {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        cache: 'no-store',
      })
      if (res.ok) return res.json()
      if (res.status === 429 && attempt < MAX_TRIES) {
        await sleep((Number(res.headers.get('retry-after')) || 4 * attempt) * 1000)
        continue
      }
      if (res.status === 429) throw new Error('Cortana rate limit hit — refresh in a minute')
      const text = await res.text().catch(() => '')
      throw new Error(`Cortana ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`)
    }
  })
}
