// Small status/anomaly badge. red = urgent, amber = review, green = positive, muted = neutral.
export type Tone = 'red' | 'amber' | 'green' | 'muted'
export type ChipData = { tone: Tone; text: string }

const TONES: Record<Tone, { fg: string; bg: string }> = {
  red: { fg: '#f87171', bg: 'rgba(239,68,68,0.12)' },
  amber: { fg: '#fbbf24', bg: 'rgba(245,158,11,0.12)' },
  green: { fg: '#4ade80', bg: 'rgba(34,197,94,0.12)' },
  muted: { fg: '#a0a0ab', bg: 'rgba(255,255,255,0.06)' },
}

export function Chip({ tone, children, onClick, title }: { tone: Tone; children: React.ReactNode; onClick?: () => void; title?: string }) {
  const t = TONES[tone]
  const cls = 'inline-flex items-center rounded px-1.5 py-[1px] text-[10px] font-medium whitespace-nowrap leading-4'
  if (onClick)
    return (
      <button type="button" onClick={onClick} title={title} className={`${cls} hover:opacity-80 transition`} style={{ color: t.fg, background: t.bg }}>
        {children}
      </button>
    )
  return (
    <span title={title} className={cls} style={{ color: t.fg, background: t.bg }}>
      {children}
    </span>
  )
}

export function Chips({ chips }: { chips?: ChipData[] }) {
  if (!chips?.length) return null
  return (
    <span className="inline-flex flex-wrap gap-1">
      {chips.map((c, i) => (
        <Chip key={i} tone={c.tone}>
          {c.text}
        </Chip>
      ))}
    </span>
  )
}
