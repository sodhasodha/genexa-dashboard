// Genexa Clients — roster exclusions, pods, EOD channels and KPI targets.
// Change targets here; every status on the Genexa Clients tab reads from TARGETS.

export type ClinicConfig = {
  name: string
  businessId: string // Cortana business id
  pod: string
  // Matches the "Client:" line in Slack booking notifications.
  slackClient?: RegExp
  // Pod channel the clinic's booking notifications post in, if not its own pod.
  bookingPod?: string
}

// The roster is every Cortana business except these (see lib/clinics/roster.ts), so a new
// Cortana business shows up on the tab without a code change.
export const EXCLUDED_BUSINESSES: Record<string, string> = {
  '53f99ff4-efdd-4458-8fc0-19946fd28f17': 'Example (demo)',
  '893e8bff-93f9-41b2-b85b-0e98b5bafb7d': 'Genexa Scaling (us)',
  '74eddd7b-f64d-45e0-b5ae-906969bb32d1': 'CC Medical (churned)',
  '1e384b1e-903c-47ed-9ee5-402826d62792': 'Dr Paul and Dr Marc (churned)',
}

export const DEFAULT_POD = 'Unassigned'

// Optional per-clinic extras, keyed by Cortana business id. Pods mirror the Monday CLIENTS board groups.
// A business with no entry here still appears, under its Cortana name and DEFAULT_POD.
export const CLINIC_META: Record<string, Partial<Omit<ClinicConfig, 'businessId'>>> = {
  '14d26997-dca9-456e-b379-ad7d28504c1f': { name: 'Beyond Stem Cells', pod: 'Pod 2', slackClient: /beyond stem/i },
  'e62c2cb3-da61-4a41-a4cb-506ead4b830e': {
    name: 'Interventional Pain Consultants (Russell)',
    pod: 'Pod 1',
    slackClient: /^interventional pain consultants(?!\s*-?\s*(georgia|cleveland))/i,
  },
  '1cea99f9-0fee-414c-8321-14a3a48b4ff4': { name: 'IPC Cleveland', slackClient: /cleveland/i },
  'c2e266c2-1371-49a7-9033-0a05db2624f2': { name: 'IPC Georgia', pod: 'Pod 2', slackClient: /georgia/i },
  'd919c593-216f-4c50-9906-2c98bfc60388': { pod: 'Pod TBC', slackClient: /multivita/i, bookingPod: 'Pod 1' },
  'ace397d2-aca1-4fa5-836a-17277a21fabc': { pod: 'Pod 1', slackClient: /pivotal/i },
  '87db4b2c-ecbb-4e4d-960b-943b96c0b67a': { pod: 'Pod 1', slackClient: /pure health/i },
  '79a6bd5c-5a20-4b97-ad6e-4c8c57d089e1': { pod: 'Pod 1', slackClient: /regen\s*rx/i },
  '3ecf24a3-41e3-43b6-a84f-fee28a98b096': { pod: 'Pod 1', slackClient: /regenestem/i },
  '01ccb044-6ae0-4ced-81a3-fbafd75cbc60': { slackClient: /reviv/i },
  '04cd16a9-2a8b-45c1-a6e5-b2bfb73e2471': { pod: 'Pod 2', slackClient: /franklin/i },
  '621f3634-8a10-4576-8f15-b7909c5148f6': { name: 'Vitale Health', pod: 'Pod 2', slackClient: /vitale/i },
}

// Test contacts — dropped at ingest so they never count as leads, bookings, shows or sales.
// A contact is a test if its name or email matches a pattern, or its phone is an internal number.
export const TEST_CONTACTS = {
  name: [/zztest/i, /\btest\b/i, /^tes$/i],
  // Any "test" in an email is treated as a test (a real "latest@…" would be dropped too — acceptable).
  email: [/test/i, /@(toolboxgrowth|genexascaling)\.com$/i, /^adityaarajdhiman@gmail\.com$/i, /^airealbro(\+.*)?@gmail\.com$/i, /^aryansodha\d*@gmail\.com$/i],
  phones: ['16893459116', '15596693445'], // digits only
}
export function isTestContact(c: { name?: string | null; email?: string | null; phone?: string | null }): boolean {
  const name = (c.name || '').trim()
  const email = (c.email || '').trim()
  const phone = (c.phone || '').replace(/\D/g, '')
  return (
    TEST_CONTACTS.name.some((p) => p.test(name)) || TEST_CONTACTS.email.some((p) => p.test(email)) || (!!phone && TEST_CONTACTS.phones.some((n) => phone.endsWith(n.slice(-10))))
  )
}

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
