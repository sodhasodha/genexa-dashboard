// Simple, explainable projections for the finance page.

// Month-end projection from month-to-date at a linear run-rate.
export function paceProjection(mtd: number, dayOfMonth: number, daysInMonth: number): number {
  return dayOfMonth > 0 ? (mtd / dayOfMonth) * daysInMonth : mtd
}

// Least-squares trend over the last `lookback` points, extended `ahead` points.
// Falls back to a flat average with fewer than 3 points. Never goes below `floor`.
export function linearForecast(values: number[], ahead = 3, lookback = 6, floor: number | null = 0): number[] {
  const pts = values.slice(-lookback)
  const n = pts.length
  if (n === 0) return Array(ahead).fill(0)
  const clamp = (v: number) => (floor === null ? v : Math.max(floor, v))
  if (n < 3) {
    const avg = pts.reduce((s, v) => s + v, 0) / n
    return Array(ahead).fill(clamp(avg))
  }
  const xMean = (n - 1) / 2
  const yMean = pts.reduce((s, v) => s + v, 0) / n
  let num = 0
  let den = 0
  pts.forEach((v, i) => {
    num += (i - xMean) * (v - yMean)
    den += (i - xMean) ** 2
  })
  const slope = den ? num / den : 0
  const intercept = yMean - slope * xMean
  return Array.from({ length: ahead }, (_, k) => clamp(intercept + slope * (n + k)))
}

// Next `ahead` month keys after 'YYYY-MM'.
export function nextMonths(last: string, ahead = 3): string[] {
  const [y, m] = last.split('-').map(Number)
  return Array.from({ length: ahead }, (_, k) => new Date(Date.UTC(y, m + k, 1)).toISOString().slice(0, 7))
}

export const monthLabel = (key: string) =>
  new Date(`${key}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
