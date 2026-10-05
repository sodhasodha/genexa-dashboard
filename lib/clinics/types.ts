import type { ClinicConfig, TARGETS } from '@/lib/clinics/config'

export type WindowKey = '7d' | '30d' | 'mtd'
export type Window = { key: WindowKey; start: Date; end: Date; days: number }

export type Status = 'green' | 'amber' | 'red' | 'grey'

export type DayPoint = { date: string; spend: number; leads: number; revenue: number } // date = YYYY-MM-DD

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
  excludedCampaigns: number // paid campaigns Cortana lists for the clinic that aren't in its binding
}

// Anything that can supply raw clinic numbers (Cortana today, mock for testing).
export interface ClinicSource {
  name: string
  fetchAll(clinics: ClinicConfig[], window: Window): Promise<ClinicRaw[]>
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
}

export type FunnelStep = { label: string; value: number | null; pct: number | null } // pct = vs previous step

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
  raw: ClinicRaw
}

export type ClinicsSummary = {
  atKpi: number
  total: number // live clinics
  roster: number // every clinic on the roster, live or not
  spend: number
  leads: number
  confirmed: number
  cpl: number | null
  roas: number | null
}

export type ClinicsResponse = {
  window: WindowKey
  start: string
  end: string
  days: number
  generatedAt: string
  mock: boolean
  sources: { cortana: string; slack: string }
  summary: ClinicsSummary
  clinics: ClinicReport[]
}
