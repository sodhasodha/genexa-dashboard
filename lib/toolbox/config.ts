// Toolbox Clients (Cold SMS) — thresholds, job values and name aliases. Edit here.

// #sms-senders-eod-as (Slack Connect channel from Jacob's Close Ai workspace). Senders post a
// screenshot of the day's sheet: date, client, niche, SMS sent, leads sent, delivered rate, sender.
// Primary source for daily results.
export const EOD_CHANNEL = 'C0AHG8S5EFK'

// Jacob's "Retainer Clients" sheet (link-shared): client roster — status, niche, price, FanBasis
// billing email — plus tonight's leads (fallback results when no screenshot exists for a date).
export const ROSTER_SHEET_ID = '1A28uYF3gLM20pAoy-geworIJG9rs6CWcKUpMAjkxf8Q'

// Revenue estimate for the client: 1 in LEAD_TO_JOB leads becomes a medium-sized job.
export const LEAD_TO_JOB = 1 / 10

// Medium job value by niche (USD). Assumptions — edit to match what clients actually quote.
export const JOB_VALUES: Record<string, number> = {
  'tree removal': 1500,
  'tree service': 1200,
  'stump grinding': 400,
  landscaping: 2000,
  'deck repair': 2500,
  painting: 3000,
  remodel: 12000,
  'house cleaning': 250,
  'permanent lighting': 3000,
  roofing: 9000,
  fencing: 4000,
  concrete: 4000,
  'pressure washing': 400,
}
export const DEFAULT_JOB_VALUE = 1500

// Estimated client ROI = estimated job revenue ÷ what they paid us.
export const PERFORMANCE = {
  performing: 5, // ≥ 5x → Performing
  borderline: 3, // 3–5x → Borderline, below → Not performing
}

// High-risk rules. A client is High risk with any major flag, or MINOR_FLAGS_FOR_HIGH minor flags.
export const RISK = {
  paymentGraceDays: 3, // payment overdue by more than this past the expected date → major
  noSendDays: 3, // no EOD rows for this many sending days → major (not being sent)
  leadDropMajor: 0.5, // leads/day last 7d down ≥50% vs the prior 21d → major
  leadDropMinor: 0.25, // down ≥25% → minor
  deliveredMin: 80, // delivered rate below this % → minor
  newClientDays: 21, // first paid within this many days → minor (onboarding)
}
export const MINOR_FLAGS_FOR_HIGH = 2

// EOD client name → canonical client key, when automatic normalisation gets it wrong.
// Keys and values are lower-case; see normaliseClient() in lib/toolbox/eod.ts.
export const EOD_ALIASES: Record<string, string> = {
  'joe shupps stump grindin': 'joseph shupps',
  'jose maldonad': 'jose maldonado',
}

// Canonical EOD client key → Commas customer name(s) who pay for that client. These are added on
// top of automatic name matching (a client can have several payers / Commas records).
export const BILLING_ALIASES: Record<string, string[]> = {
  'henner l&t tree services': ['Hener Lopez'],
  'patrick smith': ['Joshua Wigle'], // pays for Patrick's deck repair account
  'willie da tree service': ['Naveen Jeyasankar'], // $250/wk paid via Naveen
  'geovanny hernandez': ['Jose Ramos Hernandez'], // 2 accounts; first $1,500 paid as one charge
}

// Known billing that neither Commas nor the sheet's price column gets right. The sheet price already
// covers one-off-link payers (e.g. Geovanny, 2 × $750/week), so this is usually empty.
export const BILLING_OVERRIDES: Record<string, { charge: number; cadence: 'daily' | 'weekly' | 'monthly' }> = {}
