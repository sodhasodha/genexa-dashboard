// Cold SMS pay structure — progressive (marginal) split of the distributable pool.
//
// 1. "Our side" receives POOL_SHARE (36%) of total Cold SMS revenue. That is the pool.
// 2. The pool is split between Aryan and Rishil using bands on ARYAN'S INCOME,
//    exactly like tax brackets: each band's rate only applies to the pool money
//    that moves Aryan through that band. Crossing a threshold NEVER changes the
//    rate applied to pool money already split in earlier bands.
// 3. Bands are applied per calendar month (Aryan's income resets to $0 each month),
//    which is what reconciles with the payouts actually received in Mercury.
//
// Worked example — revenue $40,000:
//   pool = 36% × 40,000 = $14,400
//   Band 1 (Aryan $0→$8k at 80%):   pool needed = 8,000 / 0.80 = $10,000 → Aryan 8,000, Rishil 2,000
//   Band 2 (Aryan $8k→$12k at 30%): pool left 4,400; to fill band needs 4,000 / 0.30 = 13,333 → uses all 4,400
//                                    → Aryan 1,320, Rishil 3,080
//   Total: Aryan $9,320, Rishil $5,080 (sum = pool $14,400)

export const POOL_SHARE = 0.36

export type Band = { from: number; to: number | null; aryan: number; rishil: number }

// Bands are defined on Aryan's cumulative income, not on the pool.
export const BANDS: Band[] = [
  { from: 0, to: 8000, aryan: 0.8, rishil: 0.2 },
  { from: 8000, to: 12000, aryan: 0.3, rishil: 0.7 },
  { from: 12000, to: 15000, aryan: 0.2, rishil: 0.8 },
  { from: 15000, to: null, aryan: 0.15, rishil: 0.85 },
]

export type BandSlice = { band: Band; poolUsed: number; aryan: number; rishil: number }

export type SplitResult = {
  revenue: number
  pool: number
  aryan: number
  rishil: number
  aryanPctOfRevenue: number
  rishilPctOfRevenue: number
  slices: BandSlice[] // how much of the pool went through each band
  bandIndex: number // band Aryan's income currently sits in (the marginal band)
  nextThreshold: number | null // Aryan income at which the next band starts
  untilNextBand: number | null // Aryan income still needed to reach it
  bandProgress: number // 0–1 progress through the current band (0 for the open-ended top band)
}

// Split a pool progressively. `startingIncome` lets you continue from income Aryan
// has already earned this month (defaults to 0).
export function splitPool(pool: number, startingIncome = 0): Omit<SplitResult, 'revenue' | 'aryanPctOfRevenue' | 'rishilPctOfRevenue'> {
  let remaining = Math.max(pool, 0)
  let income = Math.max(startingIncome, 0)
  let aryan = 0
  let rishil = 0
  const slices: BandSlice[] = []

  for (const band of BANDS) {
    if (remaining <= 0) break
    if (band.to !== null && income >= band.to) continue // Aryan is already past this band

    // Aryan income left in this band, and the pool needed to earn it at this band's rate.
    const incomeRoom = band.to === null ? Infinity : band.to - Math.max(income, band.from)
    const poolToFillBand = incomeRoom / band.aryan
    const poolUsed = Math.min(remaining, poolToFillBand)

    const a = poolUsed * band.aryan
    const r = poolUsed * band.rishil
    slices.push({ band, poolUsed, aryan: a, rishil: r })
    aryan += a
    rishil += r
    income += a
    remaining -= poolUsed
  }

  const totalIncome = startingIncome + aryan
  // Current (marginal) band = the band the NEXT dollar of pool would be split in.
  let bandIndex = BANDS.findIndex((b) => b.to === null || totalIncome < b.to)
  if (bandIndex === -1) bandIndex = BANDS.length - 1
  const band = BANDS[bandIndex]
  const nextThreshold = band.to
  return {
    pool,
    aryan,
    rishil,
    slices,
    bandIndex,
    nextThreshold,
    untilNextBand: nextThreshold === null ? null : nextThreshold - totalIncome,
    bandProgress: band.to === null ? 0 : (totalIncome - band.from) / (band.to - band.from),
  }
}

// Revenue → pool → progressive split.
export function coldSmsPayout(revenue: number): SplitResult {
  const pool = Math.max(revenue, 0) * POOL_SHARE
  const s = splitPool(pool)
  return {
    ...s,
    revenue,
    aryanPctOfRevenue: revenue > 0 ? (s.aryan / revenue) * 100 : 0,
    rishilPctOfRevenue: revenue > 0 ? (s.rishil / revenue) * 100 : 0,
  }
}

export const bandLabel = (b: Band) =>
  `${Math.round(b.aryan * 100)} / ${Math.round(b.rishil * 100)}`
export const bandRange = (b: Band) =>
  b.to === null ? `$${b.from / 1000}k+` : `$${b.from / 1000}k–$${b.to / 1000}k`
