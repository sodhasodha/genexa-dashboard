import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { AUTH_COOKIE, isPublicPath, isValidSession } from '@/lib/auth'

// Password-protect every page and API route except the public ones in lib/auth.ts
// (Genexa Clients + its API, and the login flow).
export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  if (isPublicPath(pathname)) return NextResponse.next()
  // Vercel cron (vercel.json) authenticates with CRON_SECRET.
  const cron = process.env.CRON_SECRET
  if (cron && pathname === '/api/toolbox/sync' && request.headers.get('authorization') === `Bearer ${cron}`) return NextResponse.next()
  if (await isValidSession(request.cookies.get(AUTH_COOKIE)?.value)) return NextResponse.next()

  if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const url = request.nextUrl.clone()
  url.pathname = '/login'
  url.search = `?next=${encodeURIComponent(pathname + search)}`
  return NextResponse.redirect(url)
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static, _next/image (build assets)
     * - favicon / apple-touch-icon (public files)
     */
    '/((?!_next/static|_next/image|favicon.ico|favicon.svg|favicon.png|apple-touch-icon.png).*)',
  ],
}
