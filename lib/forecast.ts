// Small date/pace helpers for the finance page (scenario forecasting lives in lib/scenarios.ts).

// Month-end projection from month-to-date at a linear run-rate.
export function paceProjection(mtd: number, dayOfMonth: number, daysInMonth: number): number {
  return dayOfMonth > 0 ? (mtd / dayOfMonth) * daysInMonth : mtd
}

export const monthLabel = (key: string) =>
  new Date(`${key}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
