'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ReactNode, useState } from 'react'

const Icon = ({ d }: { d: string }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
)
const icons: Record<string, ReactNode> = {
  home: <Icon d="M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5" />,
  tasks: <Icon d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  goals: <Icon d="M12 2v4m0 12v4M2 12h4m12 0h4M12 12l4-4" />,
  clients: <Icon d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm14 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />,
  health: <Icon d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  docs: <Icon d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6" />,
}

const MAIN = [
  { href: '/home', label: 'Home', icon: 'home' },
  { href: '/tasks', label: 'Tasks', icon: 'tasks' },
  { href: '/goals', label: 'Goals', icon: 'goals' },
  { href: '/clients', label: 'Clients', icon: 'clients' },
  { href: '/health', label: 'Health', icon: 'health' },
]
const BOTTOM = [{ href: '/docs', label: 'Docs', icon: 'docs' }]

function Logo() {
  return (
    <div className="flex items-center gap-2">
      <div className="w-6 h-6 rounded-md bg-los-accent flex items-center justify-center text-white text-xs font-bold">G</div>
      <span className="font-semibold text-los-text tracking-tight">Genexa OS</span>
    </div>
  )
}

function NavContent({ onNavigate, isActive }: { onNavigate?: () => void; isActive: (h: string) => boolean }) {
  const link = (item: { href: string; label: string; icon: string }) => (
    <Link key={item.href} href={item.href} onClick={onNavigate} className={`nav-item ${isActive(item.href) ? 'active' : ''}`}>
      <span className="opacity-90">{icons[item.icon]}</span>
      <span>{item.label}</span>
    </Link>
  )
  return (
    <div className="flex flex-col h-full px-3 py-4">
      <div className="px-2 mb-6">
        <Logo />
      </div>
      <p className="los-label px-2 mb-2">Workspace</p>
      <nav className="space-y-0.5">{MAIN.map(link)}</nav>
      <div className="mt-auto">
        <div className="space-y-0.5 pt-4">{BOTTOM.map(link)}</div>
        <div className="border-t border-los-border mt-3 pt-3 flex items-center gap-2.5 px-2">
          <div className="w-7 h-7 rounded-full bg-los-accent-soft text-los-accent flex items-center justify-center text-[11px] font-semibold">AS</div>
          <div className="leading-tight">
            <p className="text-xs text-los-text">Aryan Sodha</p>
            <p className="text-[11px] text-los-text-muted">CEO</p>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function Sidebar() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const isActive = (href: string) => pathname === href || (href === '/home' && pathname === '/')

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:block w-56 shrink-0 h-screen sticky top-0 bg-los-surface border-r border-los-border">
        <NavContent isActive={isActive} />
      </aside>

      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-40 h-12 bg-los-surface border-b border-los-border flex items-center justify-between px-4">
        <Logo />
        <button onClick={() => setOpen(true)} aria-label="Open menu" className="text-los-text-secondary">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>
      </div>

      {/* Mobile drawer */}
      {open && (
        <div className="md:hidden fixed inset-0 z-50 bg-black/60" onClick={() => setOpen(false)}>
          <aside className="w-64 h-full bg-los-surface border-r border-los-border" onClick={(e) => e.stopPropagation()}>
            <NavContent isActive={isActive} onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
    </>
  )
}
