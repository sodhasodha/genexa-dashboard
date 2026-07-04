import https from 'https'
import { HttpsProxyAgent } from 'https-proxy-agent'

// Route outbound requests through the Fixie proxy (static IP) when configured.
// Next's global fetch (undici) ignores custom agents, so we use Node's https
// module with https-proxy-agent to guarantee traffic exits via Fixie.
const proxyUrl = process.env.FIXIE_URL || ''
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined

interface FixieResponse {
  ok: boolean
  status: number
  statusText: string
  json: () => Promise<any>
  text: () => Promise<string>
}

interface FixieOptions {
  method?: string
  headers?: Record<string, string>
}

export function fixieFetch(targetUrl: string, options: FixieOptions = {}): Promise<FixieResponse> {
  const url = new URL(targetUrl)

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: options.method || 'GET',
        headers: options.headers,
        agent,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          const status = res.statusCode || 0
          resolve({
            ok: status >= 200 && status < 300,
            status,
            statusText: res.statusMessage || '',
            json: async () => JSON.parse(body || '{}'),
            text: async () => body,
          })
        })
      }
    )

    req.on('error', reject)
    req.end()
  })
}
