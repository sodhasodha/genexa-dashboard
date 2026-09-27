'use client'

import { useState } from 'react'

export default function LoginPage() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Login failed')
      // Only follow same-site relative paths.
      const next = new URLSearchParams(window.location.search).get('next') || '/home'
      window.location.href = next.startsWith('/') && !next.startsWith('//') ? next : '/home'
    } catch (err) {
      setError((err as Error).message)
      setLoading(false)
    }
  }

  return (
    <div className="min-h-[80vh] flex items-center justify-center px-4">
      <form onSubmit={submit} className="los-card p-6 w-full max-w-sm flex flex-col gap-4">
        <div>
          <h1 className="text-lg font-semibold text-los-text tracking-tight">Genexa OS</h1>
          <p className="text-xs text-los-text-muted mt-0.5">Enter the password to continue.</p>
        </div>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="bg-los-surface-2 border border-los-border rounded-md px-3 py-2 text-sm text-los-text outline-none focus:border-los-accent"
        />
        {error && <p className="text-xs text-los-red">{error}</p>}
        <button type="submit" disabled={loading || !password} className="los-btn bg-los-accent text-white disabled:opacity-50">
          {loading ? 'Checking…' : 'Unlock'}
        </button>
      </form>
    </div>
  )
}
