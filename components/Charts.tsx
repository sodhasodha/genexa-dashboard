'use client'

import { useState } from 'react'

const ACCENT = '#3b82f6'
const GRID = 'rgba(255,255,255,0.06)'
const AXIS = '#6b6b78'

type Pt = { label: string; value: number }

/* ------------------------------- Sparkline -------------------------------- */
// Tiny inline trend line, no axes — for metric tiles.
export function Sparkline({
  data,
  width = 96,
  height = 28,
  color = ACCENT,
  filled = true,
}: {
  data: number[]
  width?: number
  height?: number
  color?: string
  filled?: boolean
}) {
  if (data.length < 2) return <div style={{ width, height }} />
  const min = Math.min(...data)
  const max = Math.max(...data)
  const span = max - min || 1
  const dx = width / (data.length - 1)
  const y = (v: number) => height - 3 - ((v - min) / span) * (height - 6)
  const pts = data.map((v, i) => `${i * dx},${y(v)}`)
  return (
    <svg width={width} height={height} className="overflow-visible">
      {filled && (
        <polygon
          points={`0,${height} ${pts.join(' ')} ${width},${height}`}
          fill={color}
          opacity={0.12}
        />
      )}
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={(data.length - 1) * dx} cy={y(data[data.length - 1])} r={2} fill={color} />
    </svg>
  )
}

/* -------------------------------- TrendPill ------------------------------- */
// Small % change indicator with direction color.
export function TrendPill({ pct }: { pct: number }) {
  const up = pct >= 0
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[11px] font-medium ${up ? 'text-los-green' : 'text-los-red'}`}
    >
      {up ? '▲' : '▼'} {Math.abs(pct).toFixed(0)}%
    </span>
  )
}

const W = 640 // logical width; SVG stretches to container via preserveAspectRatio=none

function useHover(len: number) {
  const [idx, setIdx] = useState<number | null>(null)
  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const rel = (e.clientX - rect.left) / rect.width
    setIdx(Math.max(0, Math.min(len - 1, Math.round(rel * (len - 1)))))
  }
  return { idx, onMove, clear: () => setIdx(null) }
}

/* ------------------------------- LineChart -------------------------------- */
export function LineChart({
  data,
  height = 170,
  format = (v: number) => String(v),
  color = ACCENT,
}: {
  data: Pt[]
  height?: number
  format?: (v: number) => string
  color?: string
}) {
  const { idx, onMove, clear } = useHover(data.length)
  if (data.length < 2) return <Empty height={height} />

  const padB = 18
  const plotH = height - padB
  const values = data.map((d) => d.value)
  const min = Math.min(0, ...values)
  const max = Math.max(...values) || 1
  const span = max - min || 1
  const dx = W / (data.length - 1)
  const y = (v: number) => 6 + (1 - (v - min) / span) * (plotH - 12)
  const pts = data.map((d, i) => `${i * dx},${y(d.value)}`)
  const ticks = [max, min + span * 0.66, min + span * 0.33, min]
  const xLabels = [0, Math.floor((data.length - 1) / 2), data.length - 1]

  return (
    <div className="relative w-full" style={{ height }}>
      {/* y-axis labels (HTML overlay so text isn't stretched) */}
      {ticks.map((t, i) => (
        <span
          key={i}
          className="absolute left-0 text-[10px] text-los-text-muted font-mono -translate-y-1/2"
          style={{ top: (y(t) / height) * 100 + '%' }}
        >
          {format(t)}
        </span>
      ))}
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        className="block"
      >
        <defs>
          <linearGradient id="lc-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.22} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        {ticks.map((t, i) => (
          <line key={i} x1={0} x2={W} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ))}
        <polygon points={`0,${plotH} ${pts.join(' ')} ${W},${plotH}`} fill="url(#lc-fill)" />
        <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
        {idx !== null && (
          <>
            <line x1={idx * dx} x2={idx * dx} y1={0} y2={plotH} stroke={AXIS} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <circle cx={idx * dx} cy={y(data[idx].value)} r={3.5} fill={color} stroke="#0a0a0f" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          </>
        )}
      </svg>
      {/* x-axis labels */}
      <div className="absolute bottom-0 left-0 right-0 flex justify-between text-[10px] text-los-text-muted">
        {xLabels.map((i) => (
          <span key={i}>{data[i].label}</span>
        ))}
      </div>
      {/* hover capture + tooltip */}
      <div className="absolute inset-0" onMouseMove={onMove} onMouseLeave={clear} />
      {idx !== null && (
        <div
          className="absolute -translate-x-1/2 -top-1 pointer-events-none rounded-md border border-los-border bg-los-surface-2 px-2 py-1 text-[11px] whitespace-nowrap shadow-lg"
          style={{ left: `${(idx / (data.length - 1)) * 100}%` }}
        >
          <span className="text-los-text-muted">{data[idx].label} · </span>
          <span className="text-los-text font-mono">{format(data[idx].value)}</span>
        </div>
      )}
    </div>
  )
}

/* -------------------------------- BarChart -------------------------------- */
export function BarChart({
  data,
  height = 170,
  format = (v: number) => String(v),
  color = ACCENT,
}: {
  data: Pt[]
  height?: number
  format?: (v: number) => string
  color?: string
}) {
  const { idx, onMove, clear } = useHover(data.length)
  if (!data.length) return <Empty height={height} />

  const padB = 18
  const plotH = height - padB
  const max = Math.max(...data.map((d) => d.value)) || 1
  const gap = 4
  const bw = (W - gap * (data.length - 1)) / data.length
  const ticks = [max, max * 0.5, 0]
  const xLabels = [0, Math.floor((data.length - 1) / 2), data.length - 1]

  return (
    <div className="relative w-full" style={{ height }}>
      {ticks.map((t, i) => (
        <span
          key={i}
          className="absolute left-0 text-[10px] text-los-text-muted font-mono -translate-y-1/2"
          style={{ top: ((1 - t / max) * (plotH - 6) + 3) / height * 100 + '%' }}
        >
          {format(t)}
        </span>
      ))}
      <svg width="100%" height={height} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="block">
        {ticks.map((t, i) => {
          const yy = (1 - t / max) * (plotH - 6) + 3
          return <line key={i} x1={0} x2={W} y1={yy} y2={yy} stroke={GRID} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        })}
        {data.map((d, i) => {
          const h = (d.value / max) * (plotH - 6)
          return (
            <rect
              key={i}
              x={i * (bw + gap)}
              y={plotH - h}
              width={bw}
              height={Math.max(h, 0)}
              rx={3}
              fill={color}
              opacity={idx === null || idx === i ? 0.9 : 0.45}
            />
          )
        })}
      </svg>
      <div className="absolute bottom-0 left-0 right-0 flex justify-between text-[10px] text-los-text-muted">
        {xLabels.map((i) => (
          <span key={i}>{data[i].label}</span>
        ))}
      </div>
      <div className="absolute inset-0" onMouseMove={onMove} onMouseLeave={clear} />
      {idx !== null && (
        <div
          className="absolute -translate-x-1/2 -top-1 pointer-events-none rounded-md border border-los-border bg-los-surface-2 px-2 py-1 text-[11px] whitespace-nowrap shadow-lg"
          style={{ left: `${((idx + 0.5) / data.length) * 100}%` }}
        >
          <span className="text-los-text-muted">{data[idx].label} · </span>
          <span className="text-los-text font-mono">{format(data[idx].value)}</span>
        </div>
      )}
    </div>
  )
}

function Empty({ height }: { height: number }) {
  return (
    <div className="w-full flex items-center justify-center text-los-text-muted text-xs" style={{ height }}>
      No data yet
    </div>
  )
}
