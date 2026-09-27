// Password gate for the dashboard. Everything except the Genexa Clients tab needs the
// DASHBOARD_PASSWORD. The session cookie holds a hash of the password, never the password itself,
// so changing DASHBOARD_PASSWORD logs everyone out. Uses Web Crypto so it runs in middleware (edge).

export const AUTH_COOKIE = 'genexa_session'
export const SESSION_DAYS = 30

// Paths anyone can open without the password.
export const PUBLIC_PATHS = ['/genexa-clients', '/api/clinics', '/login', '/api/auth']

export const isPublicPath = (path: string) => PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`))

export async function sessionToken(password: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`genexa-dashboard-session:${password}`))
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}

// True when the cookie matches the current password. Fails closed if no password is configured.
export async function isValidSession(cookie: string | undefined): Promise<boolean> {
  const password = process.env.DASHBOARD_PASSWORD
  if (!password || !cookie) return false
  return cookie === (await sessionToken(password))
}
