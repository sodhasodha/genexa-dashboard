import type { ClinicConfig, TARGETS } from '@/lib/clinics/config'

export type WindowKey = '7d' | '30d' | 'mtd'
export type Window = { key: WindowKey; start: Date; end: Date; days: number }

export type Status = 'green' | 'amber' | 'red' | 'grey'

export type DayPoint = { date: string; spend: number; leads: number; revenue: number } // date = YYYY-MM-DD

// Where one bound ad account stands. disabled / payment_issue / closed come from the dated account
// snapshot in bindings.ts; the campaign states are live from Cortana.
export type AccountState = 'active' | 'disabled' | 'payment_issue' | 'closed' | 'no_active_campaigns' | 'campaign_paused' | 'not_delivering'
export type AccountStatus = { accountId: string; name: string; state: AccountState; label: string; detail: string }

// Raw per-clinic numbers for a window, as returned by a ClinicSource.
export type ClinicRaw = {
  error?: string // source failed / not connected → every KPI from it is grey
  dataError?: string // numbers can't be trusted (e.g. duplicate source) → shown as an error, left out of totals
  bound: boolean // has an explicit ad-account binding (lib/clinics/bindings.ts); false → no numbers at all
  spend: number
  impressions: number
  linkClicks: number
  leads: number
  leadsFrom: 'cortana' | 'meta' // Meta platform leads only when Cortana has none
  booked: number // unconfirmed_appointment_booked (all bookings)
  confirmed: number // appointment_booked
  shown: number // appointment_shown
  purchases: number
  revenue: number
  // Event seen for this clinic in the last 60 days — tells "not tracked" apart from "zero".
  tracked: { lead: boolean; booked: boolean; confirmed: boolean; shown: boolean; purchase: boolean }
  daily: DayPoint[] // one point per day in the window
  lastLeadDate: string | null // last day with a lead (60-day lookback)
  lastSpendDate: string | null // last day with spend (60-day lookback)
  excludedEvents: number // CRM events in the window attributed to campaigns outside the binding (not counted)
  testContacts: string[] // Cortana contact ids dropped as test contacts in the window
  accounts: AccountStatus[] // one per bound ad account
  metaConnected: boolean // Cortana returned ad data for a bound campaign in this or the prior period
  syncedAt: string | null // when the dashboard last pulled this clinic from Cortana (ISO)
  lastEventAt: string | null // newest CRM event Cortana holds for the clinic (ISO)
  dailySpendShare: number // <1 → daily spend / last spend are pro-rated from a shared ad account
  excludedCampaigns: number // paid campaigns Cortana lists for the clinic that aren't in its binding
}

// Anything that can supply raw clinic numbers (Cortana today, mock for testing).
export interface ClinicSource {
  name: string
  // Raw numbers for the window and for the prior period (same order as `clinics`).
  fetchAll(clinics: ClinicConfig[], window: Window, prev: Window): Promise<{ cur: ClinicRaw[]; prev: ClinicRaw[] }>
}

// Per-clinic booking notifications from the pod appointment-notis channels in Slack.
export type SlackBookings = {
  connected: boolean
  error?: string
  booked: number // "NEW UNCONFIRMED CONSULTATION BOOKED" posts
  confirmed: number // "CONFIRMED APPOINTMENT BOOKED" posts
  allBookings: number // unique patients with any booking post
  confirmedPatients: number // unique patients with a confirmed post
}

export type KpiKey = keyof typeof TARGETS
export type Kpi = {
  key: KpiKey
  label: string
  value: number | null
  display: string
  targetLabel: string
  status: Status
  note?: string
  error?: boolean // impossible value (e.g. a rate over 100%) — shown as a data error, not a number
}

// pct = value ÷ the step named in `of` (booked ÷ leads, confirmed ÷ booked, showed ÷ booked, sold ÷ showed).
// pct is null when the denominator is missing; error = over 100%.
export type FunnelStep = { label: string; value: number | null; pct: number | null; of?: string; error?: boolean }

// The same headline numbers for the prior period (null = not available).
export type Prior = { spend: number; leads: number; confirmed: number; cpl: number | null; revenue: number | null }

export type ClinicReport = {
  name: string
  pod: string
  businessId: string
  // Live = bound and has spend, leads or any activity in the 60-day lookback.
  live: boolean
  kpis: Record<KpiKey, Kpi>
  atKpi: boolean
  coreGreen: number
  worst: number // sort key: higher = worse
  funnel: FunnelStep[]
  daily: DayPoint[]
  problem: string
  notes: string[]
  slack: SlackBookings | null
  // Data health: is each source feeding this clinic?
  health: { meta: boolean; crm: boolean; revenue: boolean; syncedAt: string | null; lastEventAt: string | null }
  raw: ClinicRaw
  prev: Prior | null
}

export type ClinicsSummary = {
  atKpi: number
  total: number // live clinics
  roster: number // every clinic on the roster, live or not
  spend: number
  leads: number
  confirmed: number
  cpl: number | null
  revenue: number | null // null = no live clinic tracks closes
  revenueTracked: number // live clinics with closes logged in Cortana
  roas: number | null
  roasHidden: string | null // why blended ROAS isn't shown
  prev: Prior
}

export type ClinicsResponse = {
  window: WindowKey
  start: string
  end: string
  days: number
  label: string // e.g. "MTD · 1–5 Oct" — printed on every card
  prevLabel: string // the prior period the trends compare against
  generatedAt: string
  mock: boolean
  sources: { cortana: string; slack: string }
  summary: ClinicsSummary
  clinics: ClinicReport[]
}
