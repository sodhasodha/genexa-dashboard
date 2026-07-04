'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ReactNode } from 'react'

// Compact stroke icons (16px, currentColor).
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

function NavLink({ href, label, icon, active }: { href: string; label: string; icon: string; active: boolean }) {
  return (
    <Link href={href} className={`nav-item ${active ? 'active' : ''}`}>
      <span className="opacity-90">{icons[icon]}</span>
      <span>{label}</span>
    </Link>
  )
}

export default function Sidebar() {
  const pathname = usePathname()
  const isActive = (href: string) => pathname === href || (href === '/home' && pathname === '/')

  return (
    <aside className="w-56 shrink-0 h-screen sticky top-0 bg-los-surface border-r border-los-border flex flex-col px-3 py-4">
      <div className="px-2 mb-6 flex items-center gap-2">
        <div className="w-6 h-6 rounded-md bg-los-accent flex items-center justify-center text-white text-xs font-bold">G</div>
        <span className="font-semibold text-los-text tracking-tight">Genexa OS</span>
      </div>

      <p className="los-label px-2 mb-2">Workspace</p>
      <nav className="space-y-0.5">
        {MAIN.map((item) => (
          <NavLink key={item.href} {...item} active={isActive(item.href)} />
        ))}
      </nav>

      <div className="mt-auto">
        <div className="space-y-0.5 pt-4">
          {BOTTOM.map((item) => (
            <NavLink key={item.href} {...item} active={isActive(item.href)} />
          ))}
        </div>
        <div className="border-t border-los-border mt-3 pt-3 flex items-center gap-2.5 px-2">
          <div className="w-7 h-7 rounded-full bg-los-accent-soft text-los-accent flex items-center justify-center text-[11px] font-semibold">
            AS
          </div>
          <div className="leading-tight">
            <p className="text-xs text-los-text">Aryan Sodha</p>
            <p className="text-[11px] text-los-text-muted">CEO</p>
          </div>
        </div>
      </div>
    </aside>
  )
}
