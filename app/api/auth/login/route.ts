import { NextRequest, NextResponse } from 'next/server'
import { AUTH_COOKIE, SESSION_DAYS, sessionToken } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// POST /api/auth/login { password } → sets the session cookie.
export async function POST(request: NextRequest) {
  const expected = process.env.DASHBOARD_PASSWORD
  if (!expected) return NextResponse.json({ error: 'DASHBOARD_PASSWORD not configured' }, { status: 500 })
  const { password } = await request.json().catch(() => ({ password: '' }))
  if (typeof password !== 'string' || password !== expected) {
    await new Promise((r) => setTimeout(r, 600)) // slow down guessing
    return NextResponse.json({ error: 'Wrong password' }, { status: 401 })
  }
  const res = NextResponse.json({ ok: true })
  res.cookies.set(AUTH_COOKIE, await sessionToken(expected), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  })
  return res
}

// DELETE /api/auth/login → logs out.
export async function DELETE() {
  const res = NextResponse.json({ ok: true })
  res.cookies.set(AUTH_COOKIE, '', { path: '/', maxAge: 0 })
  return res
}
