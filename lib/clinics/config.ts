// Genexa Clients — clinic list, pods, EOD channels and KPI targets.
// Change targets here; every status on the Genexa Clients tab reads from TARGETS.

export type ClinicConfig = {
  name: string
  businessId: string // Cortana business id
  pod: string
  // Only paid campaigns whose name matches count toward spend / clicks / Meta leads.
  // Use when the clinic's ad account also runs non-Genexa campaigns. Organic / unattributed
  // CRM leads are always kept (the CRM sub-account is ours).
  campaignFilter?: RegExp
  // Matches the "Client:" line in Slack booking notifications.
  slackClient?: RegExp
  // Pod channel the clinic's booking notifications post in, if not its own pod.
  bookingPod?: string
}

// Pods mirror the Monday CLIENTS board groups.
export const CLINICS: ClinicConfig[] = [
  { name: 'Beyond Stem Cells', businessId: '14d26997-dca9-456e-b379-ad7d28504c1f', pod: 'Pod 2', slackClient: /beyond stem/i },
  {
    name: 'Interventional Pain Consultants (Russell)',
    businessId: 'e62c2cb3-da61-4a41-a4cb-506ead4b830e',
    pod: 'Pod 1',
    slackClient: /^interventional pain consultants(?!\s*-?\s*georgia)/i,
  },
  { name: 'IPC Georgia', businessId: 'c2e266c2-1371-49a7-9033-0a05db2624f2', pod: 'Pod 2', slackClient: /georgia/i },
  { name: 'Multivita IV', businessId: 'd919c593-216f-4c50-9906-2c98bfc60388', pod: 'Pod TBC', slackClient: /multivita/i, bookingPod: 'Pod 1' },
  { name: 'Pivotal Health Florida', businessId: 'ace397d2-aca1-4fa5-836a-17277a21fabc', pod: 'Pod 1', slackClient: /pivotal/i },
  { name: 'Pure Health Medical', businessId: '87db4b2c-ecbb-4e4d-960b-943b96c0b67a', pod: 'Pod 1', slackClient: /pure health/i },
  // Ad account also runs GVTY / Staplerz / "Low Intent" campaigns that aren't ours.
  { name: 'Regen Rx', businessId: '79a6bd5c-5a20-4b97-ad6e-4c8c57d089e1', pod: 'Pod 1', campaignFilter: /genexa/i, slackClient: /regen\s*rx/i },
  { name: 'Regenestem', businessId: '3ecf24a3-41e3-43b6-a84f-fee28a98b096', pod: 'Pod 1', slackClient: /regenestem/i },
  { name: 'Terry L Franklin MD', businessId: '04cd16a9-2a8b-45c1-a6e5-b2bfb73e2471', pod: 'Pod 2', slackClient: /franklin/i },
  { name: 'Vitale Health', businessId: '621f3634-8a10-4576-8f15-b7909c5148f6', pod: 'Pod 2', slackClient: /vitale/i },
]

// Appointment-notification channels per pod (channel ids aren't secrets; the token is SLACK_BOT_TOKEN).
// The dashboard bot (@genexa_dashboard) must be a member of each channel.
export const BOOKING_CHANNELS: Record<string, string> = {
  'Pod 1': 'C0ATY12G8UX', // #pod-1-appointment-notis (public)
  'Pod 2': 'C0BV7K2QUEN', // #pod-2-appointment-notis (private — bot also needs groups:history)
}

export type Direction = 'higher' | 'lower'
export type Target = { target: number; dir: Direction; good?: number }

export const TARGETS = {
  ctr: { target: 2, dir: 'higher' }, // % link CTR on ads
  clickToLead: { target: 8, dir: 'higher' }, // % link clicks → leads
  cpl: { target: 25, dir: 'lower' }, // $ spend / new leads
  bookingRate: { target: 35, dir: 'higher' }, // % all bookings / leads
  confirmationRate: { target: 70, dir: 'higher' }, // % confirmed / all bookings
  closeRate: { target: 25, dir: 'higher' }, // % purchases / shows
  spendPerDay: { target: 100, dir: 'higher' }, // $ average daily spend
  confirmedPerWeek: { target: 3, dir: 'higher' },
  costPerConfirmed: { target: 102, dir: 'lower' }, // $25 CPL / 35% booking / 70% confirmation
  pickupRate: { target: 60, dir: 'higher' }, // %
  leadToSale: { target: 10, dir: 'higher' }, // % purchases / leads
  roas: { target: 3, dir: 'higher', good: 4 },
  revenue: { target: 30000, dir: 'higher' }, // $ per clinic per month (pro-rated to the window)
  hoursSinceLead: { target: 48, dir: 'lower' },
  hoursSinceSpend: { target: 48, dir: 'lower' },
} satisfies Record<string, Target>

export const AMBER_BAND = 0.2 // "Close" = up to 20% worse than target
export const STALE_HOURS = 48 // no leads / spend for this long → red
export const CACHE_SECONDS = 15 * 60

// A clinic is "at KPI" when it books this many confirmed appointments a week
// AND at least CORE_GREEN_MIN of the core KPIs are green.
export const CORE_KPIS = ['cpl', 'bookingRate', 'confirmationRate', 'closeRate', 'spendPerDay'] as const
export const CORE_GREEN_MIN = 4
