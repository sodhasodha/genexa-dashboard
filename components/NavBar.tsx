'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

const TABS = [
  { name: 'Home', href: '/home' },
  { name: 'Tasks', href: '/tasks' },
  { name: 'Goals', href: '/goals' },
  { name: 'Clients', href: '/clients' },
  { name: 'Health', href: '/health' },
  { name: 'Docs', href: '/docs' },
]

export default function NavBar() {
  const pathname = usePathname()
  const [time, setTime] = useState('')
  const [logStreak, setLogStreak] = useState(0)

  useEffect(() => {
    // Update time every minute
    const updateTime = () => {
      const now = new Date()
      const london = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(now)
      setTime(london)
    }

    updateTime()
    const interval = setInterval(updateTime, 60000)

    // Get log streak from localStorage
    const getStreak = () => {
      let streak = 0
      const today = new Date()
      for (let i = 0; i < 365; i++) {
        const date = new Date(today)
        date.setDate(date.getDate() - i)
        const dateStr = date.toISOString().split('T')[0]
        const log = localStorage.getItem(`los_log_${dateStr}`)
        if (log) {
          const parsed = JSON.parse(log)
          if (parsed.energy !== undefined) {
            streak++
          } else {
            break
          }
        } else {
          break
        }
      }
      setLogStreak(streak)
    }

    getStreak()

    return () => clearInterval(interval)
  }, [])

  const handleBriefing = () => {
    // TODO: Open briefing modal
    console.log('Open briefing')
  }

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 h-60px bg-los-bg/96 backdrop-blur-2xl border-b border-los-border">
      <div className="h-full px-6 flex items-center justify-between">
        {/* Left: Logo */}
        <Link href="/home" className="font-bold text-base text-los-text">
          Life OS
        </Link>

        {/* Center: Tabs */}
        <div className="hidden md:flex items-center gap-2">
          {TABS.map((tab) => {
            const isActive = pathname === tab.href
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={`los-nav-tab ${
                  isActive ? 'active bg-white font-medium' : 'inactive text-los-text-muted'
                }`}
              >
                {tab.name}
              </Link>
            )
          })}
        </div>

        {/* Right: Time + Briefing + Avatar */}
        <div className="flex items-center gap-4">
          <div className="hidden sm:flex flex-col items-end">
            <div className="font-mono text-sm font-semibold text-los-text">
              {time}
            </div>
            <div className="text-xs text-los-text-muted">London</div>
          </div>

          <button
            onClick={handleBriefing}
            title={`Streak: ${logStreak} days`}
            className="p-2 hover:bg-los-surface rounded-full transition"
          >
            ⚡
          </button>

          <div className="w-32px h-32px rounded-full bg-los-accent flex items-center justify-center text-white font-semibold text-xs">
            AS
          </div>
        </div>
      </div>
    </nav>
  )
}
