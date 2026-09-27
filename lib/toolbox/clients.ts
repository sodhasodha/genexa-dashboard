import type { CommasTx } from '@/lib/commas'
import type { EodRow } from '@/lib/toolbox/eod'
import type { RosterRow, RosterStatus } from '@/lib/toolbox/sheet'
import { normaliseClient } from '@/lib/toolbox/eod'
import { smsStreams, type Stream } from '@/lib/mrr'
import { BILLING_ALIASES, BILLING_OVERRIDES, DEFAULT_JOB_VALUE, JOB_VALUES, LEAD_TO_JOB, MINOR_FLAGS_FOR_HIGH, PERFORMANCE, RISK } from '@/lib/toolbox/config'

// Toolbox Clients: Cold SMS clients joined across the Retainer Clients sheet (roster: status, niche,
// price, FanBasis billing email), Commas (payments) and the daily SMS sender results.

const DAY = 86400000
const MONTH_DAYS = 365 / 12
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export type WindowKey = '7d' | '30d' | 'mtd'
export type Cadence = 'daily' | 'weekly' | 'monthly'
export type Performance = 'performing' | 'borderline' | 'not_performing' | 'no_data'
export type RiskFlag = { level: 'major' | 'minor'; text: string }

export type Payment = { date: string; amount: number; product: string }
export type DayStat = { date: string; leads: number; sms: number; delivered: number | null }

export type ToolboxClient = {
  key: string
  name: string
  niches: string[]
  accounts: string[] // sheet rows / sub-accounts
  billingName: string | null
  status: 'active' | 'paused' | 'failed_pay' | 'churned' | 'no_billing'
  rosterStatus: string | null // as written on the sheet
  priceText: string | null // price as written on the sheet
  cadence: Cadence | null
  oneOffOnly: boolean
  charge: number | null // typical charge per billing cycle
  mrr: number
  firstPaid: string | null
  lastPaid: string | null
  nextDue: string | null
  daysOverdue: number
  lifetimePaid: number
  paidInWindow: number
  // Results (window)
  leads: number
  sms: number
  sendDays: number
  leadsPerDay: number | null // per sending day
  delivered: number | null
  lastSent: string | null
  // Estimates
  jobValue: number
  estJobsMonth: number | null
  estRevenueMonth: number | null
  roi: number | null
  cpl: number | null // what the client pays per lead
  performance: Performance
  highRisk: boolean
  flags: RiskFlag[]
  trend: number | null // leads/day last 7d vs prior 21d
  history: DayStat[]
  payments: Payment[]
}

export type ToolboxSummary = {
  active: number
  paused: number
  failedPay: number
  byCadence: Record<Cadence, number>
  churnedInWindow: number
  mrr: number
  leads: number
  estRevenueMonth: number
  performing: number
  notPerforming: number
  highRisk: number
  unmatchedBilling: number
}

/* --------------------------------- helpers -------------------------------- */
export function makeWindow(key: WindowKey, now = Date.now()) {
  const start = key === 'mtd' ? Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1) : now - (key === '30d' ? 30 : 7) * DAY
  return { key, start, end: now, days: Math.max(1, (now - start) / DAY) }
}

export const jobValueFor = (niche: string | null) => (niche ? JOB_VALUES[niche.toLowerCase().trim()] : undefined) ?? DEFAULT_JOB_VALUE

// Niche from the business name when the sheet has no niche column (early EODs).
function nicheFromName(name: string): string | null {
  const n = name.toLowerCase()
  if (/stump/.test(n)) return 'Stump Grinding'
  if (/tree/.test(n)) return 'Tree Service'
  if (/landscap|lawn/.test(n)) return 'Landscaping'
  if (/paint/.test(n)) return 'Painting'
  if (/roof/.test(n)) return 'Roofing'
  if (/clean/.test(n)) return 'House Cleaning'
  if (/light/.test(n)) return 'Permanent Lighting'
  if (/deck/.test(n)) return 'Deck Repair'
  return null
}
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase())

// Setup fees and trials aren't billing for the service.
const NOT_SERVICE = /setup|trial/i

const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

// Similarity of two names, 0–1 (token-wise, tolerant of spelling: Elisio/Eliseo, Victor/Victorino).
function lev(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}
// Words that don't identify a client (business boilerplate, generic Commas product titles).
const STOP = new Set(['llc', 'inc', 'tree', 'trees', 'service', 'services', 'the', 'and', 'co', 'client', 'weekly', 'monthly', 'lead', 'leads', 'leeads', 'program', 'subscription', 'sub', 'worth', 'account', 'estimate', 'estimates'])
const isStop = (t: string) => STOP.has(t) || /^(serv|tre|lea|wee)/.test(t) && t.length < 6
const tokens = (s: string) =>
  Array.from(
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 3 && !isStop(t))
    )
  )
// Prefix counts as a match only for longer names (Victor → Victorino, not Alex → Alexander).
const tokenSim = (a: string, b: string) =>
  a === b ? 1 : Math.min(a.length, b.length) >= 5 && (a.startsWith(b) || b.startsWith(a)) ? 0.9 : 1 - lev(a, b) / Math.max(a.length, b.length)
export function nameScore(eodName: string, billingName: string): number {
  const ta = tokens(eodName)
  const tb = tokens(billingName)
  if (!ta.length || !tb.length) return 0
  const best = ta.map((t) => Math.max(...tb.map((u) => tokenSim(t, u))))
  const strongVals = best.filter((v) => v >= 0.75)
  const avg = strongVals.reduce((s, v) => s + v, 0) / (strongVals.length || 1)
  if (ta.length >= 2 && tb.length >= 2) {
    // Both sides have two+ names → both must agree (Daniel Perez ≠ Daniel Sanchez)…
    if (strongVals.length >= 2) return avg
    // …unless the surname matches exactly and the first names share a stem (Alex ↔ Alexander).
    const exactLong = ta.some((t) => t.length >= 5 && tb.includes(t))
    return exactLong && ta[0].slice(0, 3) === tb[0].slice(0, 3) ? 0.85 : 0
  }
  // One side is a single name ("Jessica", "Dagoberto"): weaker evidence, ranked below full-name matches.
  return strongVals.length ? avg * 0.8 : 0
}

/* --------------------------------- billing -------------------------------- */
type Billing = {
  id: string // FanBasis fan id
  name: string
  aliases: { name: string; weight: number }[] // fan name, then product titles (e.g. "Gaby 3 brothers tree service")
  emails: Set<string>
  payments: Payment[]
  stream: Stream | null // live recurring billing (same model as the Finance tab's Cold SMS MRR)
  charge: number
  first: number
  last: number
  setupOnly: boolean
}
const ONE_OFF = /one[\s-]?(time|off)|^\$?[\d,.]+$/i

function billingFor(txs: CommasTx[], streams: Map<string, Stream>): Billing {
  const sorted = [...txs].sort((a, b) => a.ts - b.ts)
  const service = sorted.filter((t) => !NOT_SERVICE.test(t.product))
  const recurring = service.filter((t) => !ONE_OFF.test(t.product.trim()))
  const list = service.length ? service : sorted
  return {
    id: sorted[0].customerId,
    name: sorted[0].name,
    aliases: [
      { name: sorted[0].name, weight: 1 },
      ...Array.from(new Set(sorted.map((t) => t.product))).map((name) => ({ name, weight: 0.8 })),
    ].filter((a) => tokens(a.name).length),
    emails: new Set(sorted.map((t) => t.email.toLowerCase()).filter(Boolean)),
    payments: list.map((t) => ({ date: iso(t.ts), amount: t.amount, product: t.product })),
    stream: streams.get(sorted[0].customerId) ?? null,
    charge: median((recurring.length ? recurring : service).slice(-4).map((t) => t.amount)),
    first: list[0].ts,
    last: list[list.length - 1].ts,
    setupOnly: !service.length,
  }
}
const cadenceOf = (d: number): Cadence => (d <= 2 ? 'daily' : d <= 10 ? 'weekly' : 'monthly')

/* ---------------------------------- build --------------------------------- */
const ROSTER_RANK: RosterStatus[] = ['active', 'failed_pay', 'paused', 'canceled']
const PER_DAYS = { day: 1, week: 7, month: MONTH_DAYS } as const

export function buildToolboxClients(eod: EodRow[], txs: CommasTx[], roster: RosterRow[], windowKey: WindowKey, now = Date.now()) {
  const win = makeWindow(windowKey, now)
  const winStart = iso(win.start)

  // Screenshot names get cut off by the column width ("Henner L&T TREE SERVI"); snap a truncated
  // key to the full roster key it's a prefix of.
  const rosterKeys = Array.from(new Set(roster.map((r) => normaliseClient(r.client)).filter(Boolean)))
  const canon = (name: string) => {
    const k = normaliseClient(name)
    if (!k || rosterKeys.includes(k)) return k
    return rosterKeys.find((rk) => k.length >= 8 && rk.startsWith(k)) ?? k
  }

  // EOD rows → clients (by normalised name).
  type Agg = { names: Map<string, number>; niches: Map<string, number>; rows: EodRow[] }
  const eodBy = new Map<string, Agg>()
  for (const r of eod) {
    const key = canon(r.client)
    if (!key) continue
    const a: Agg = eodBy.get(key) ?? { names: new Map(), niches: new Map(), rows: [] }
    a.names.set(r.client, (a.names.get(r.client) || 0) + 1)
    const niche = r.niche || nicheFromName(r.client)
    if (niche) a.niches.set(titleCase(niche.toLowerCase()), (a.niches.get(titleCase(niche.toLowerCase())) || 0) + 1)
    a.rows.push(r)
    eodBy.set(key, a)
  }
  // Roster rows join the same client keys; the sheet's niche outranks inferred ones.
  const rosterBy = new Map<string, RosterRow[]>()
  for (const r of roster) {
    const key = normaliseClient(r.client)
    if (!key) continue
    rosterBy.set(key, [...(rosterBy.get(key) || []), r])
    const a: Agg = eodBy.get(key) ?? { names: new Map(), niches: new Map(), rows: [] }
    a.names.set(r.client, (a.names.get(r.client) || 0) + 1)
    if (r.niche) a.niches.set(titleCase(r.niche.toLowerCase()), (a.niches.get(titleCase(r.niche.toLowerCase())) || 0) + 1000)
    eodBy.set(key, a)
  }
  const eodDates = Array.from(new Set(eod.map((r) => r.date))).sort()
  const recentEods = eodDates.slice(-3)

  // Commas customers (by fan id) with their live billing stream.
  const streams = new Map(
    smsStreams(
      txs.map((t) => ({ ts: t.ts, customer: t.customerId, amount: t.amount, fee: t.fee, product: t.product })),
      now
    ).map((st) => [st.customer, st])
  )
  const txBy = new Map<string, CommasTx[]>()
  for (const t of txs) txBy.set(t.customerId, [...(txBy.get(t.customerId) || []), t])
  const billings = Array.from(txBy.values()).map((list) => billingFor(list, streams))

  // Match: each EOD client links to its best Commas customer and vice versa; linked groups become
  // one client (merges "Enoc Perez" + "Enoc Rivera Perez", two fan ids for one person, etc.).
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x)
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    return r
  }
  const union = (x: string, y: string) => parent.set(find(x), find(y))
  for (const k of eodBy.keys()) find(`e:${k}`)
  for (const b of billings) find(`b:${b.id}`)
  const score = (key: string, a: Agg, b: Billing) => {
    const names = [key, ...Array.from(a.names.keys())]
    return Math.max(0, ...names.flatMap((n) => b.aliases.map((al) => nameScore(n, al.name) * al.weight)))
  }
  const norm = (n: string) => n.toLowerCase().replace(/\s+/g, ' ').trim()
  const bestB = new Map<string, { id: string; s: number }>()
  const bestE = new Map<string, { key: string; s: number }>()
  for (const [key, a] of eodBy) {
    for (const b of billings) {
      const s = score(key, a, b)
      if (s < 0.75) continue
      if (s > (bestB.get(key)?.s ?? 0)) bestB.set(key, { id: b.id, s })
      if (s > (bestE.get(b.id)?.s ?? 0)) bestE.set(b.id, { key, s })
    }
  }
  // Billing email on the roster = exact match to the Commas customer.
  for (const [key, rows] of rosterBy) {
    const emails = new Set(rows.flatMap((r) => r.emails))
    for (const b of billings) if (Array.from(b.emails).some((e) => emails.has(e))) union(`e:${key}`, `b:${b.id}`)
  }
  for (const [key, { id }] of bestB) union(`e:${key}`, `b:${id}`)
  for (const [id, { key }] of bestE) union(`b:${id}`, `e:${key}`)
  // Manual payer links from config (additive).
  for (const [key, names] of Object.entries(BILLING_ALIASES)) {
    if (!eodBy.has(key)) continue
    const wanted = new Set(names.map(norm))
    for (const b of billings) if (wanted.has(norm(b.name))) union(`e:${key}`, `b:${b.id}`)
  }
  const groups = new Map<string, { keys: string[]; bills: Billing[] }>()
  for (const k of eodBy.keys()) {
    const g = groups.get(find(`e:${k}`)) ?? { keys: [], bills: [] }
    g.keys.push(k)
    groups.set(find(`e:${k}`), g)
  }
  for (const b of billings) {
    const g = groups.get(find(`b:${b.id}`)) ?? { keys: [], bills: [] }
    g.bills.push(b)
    groups.set(find(`b:${b.id}`), g)
  }

  const clients: ToolboxClient[] = []
  for (const [gid, g] of groups) {
    const key = g.keys[0] ?? gid
    // Merge the group's EOD clients.
    const a: Agg | undefined = g.keys.length
      ? g.keys.reduce<Agg>(
          (m, k) => {
            const x = eodBy.get(k)!
            x.names.forEach((v, n) => m.names.set(n, (m.names.get(n) || 0) + v))
            x.niches.forEach((v, n) => m.niches.set(n, (m.niches.get(n) || 0) + v))
            m.rows.push(...x.rows)
            return m
          },
          { names: new Map(), niches: new Map(), rows: [] }
        )
      : undefined
    a?.rows.sort((x, y) => x.date.localeCompare(y.date))
    const bs = g.bills
    const live = bs.filter((b) => b.stream)

    // Billing rollup.
    const payments = bs.flatMap((b) => b.payments).sort((x, y) => x.date.localeCompare(y.date))
    const paidBs = bs.filter((b) => !b.setupOnly)
    const first = paidBs.length ? Math.min(...paidBs.map((b) => b.first)) : null
    const last = paidBs.length ? Math.max(...paidBs.map((b) => b.last)) : null
    // Cadence: from live billing, else from the gaps between past payments (for churn dates).
    const payDays = Array.from(new Set(payments.map((p) => p.date))).map((d) => Date.parse(`${d}T00:00:00Z`) / DAY)
    const gapGuess = payDays.length > 1 ? Math.max(1, median(payDays.slice(1).map((d, i) => d - payDays[i]))) : 7
    // Roster: status and price (summed across the client's accounts, e.g. 2 × $750/week).
    const rosterRows = g.keys.flatMap((k) => rosterBy.get(k) || [])
    const rosterStatus = ROSTER_RANK.find((st) => rosterRows.some((r) => r.status === st)) ?? null
    const priced = rosterRows.filter((r) => r.price && r.price.per !== 'estimate' && (rosterStatus !== 'active' || r.status === 'active'))
    const rosterPrice = priced.length ? { charge: priced.reduce((s, r) => s + r.price!.amount, 0), days: PER_DAYS[priced[0].price!.per as 'day' | 'week' | 'month'] } : null
    const perEstimate = rosterRows.some((r) => r.price?.per === 'estimate')
    // Billing priority: config override > live Commas billing > roster price (one-off-link payers).
    const cfg = g.keys.map((k) => BILLING_OVERRIDES[k]).find(Boolean)
    const override = cfg
      ? { charge: cfg.charge, days: { daily: 1, weekly: 7, monthly: MONTH_DAYS }[cfg.cadence] }
      : !live.length && rosterPrice && rosterStatus === 'active'
        ? rosterPrice
        : null
    const overrideDays = override ? override.days : null
    const cadenceDays = overrideDays ?? (live.length ? Math.min(...live.map((b) => b.stream!.cadence)) : paidBs.length ? gapGuess : null)
    const oneOffOnly = !override && paidBs.length > 0 && payments.every((p) => ONE_OFF.test(p.product.trim()))
    const mrr = override ? (override.charge * MONTH_DAYS) / overrideDays! : live.reduce((s, b) => s + b.stream!.mrr, 0)
    const billed = live.length > 0 || !!override // has recurring billing (live in Commas or known from config)
    const lastSentDate = a?.rows.length ? a.rows[a.rows.length - 1].date : null
    const sentRecently = !!lastSentDate && recentEods.includes(lastSentDate)
    const status: ToolboxClient['status'] = rosterStatus
      ? ({ active: 'active', paused: 'paused', failed_pay: 'failed_pay', canceled: 'churned' } as const)[rosterStatus]
      : billed || (sentRecently && paidBs.length)
        ? 'active'
        : sentRecently
          ? 'no_billing'
          : 'churned'
    const nextDue = last !== null && cadenceDays !== null ? last + cadenceDays * DAY : null
    const daysOverdue = nextDue !== null && billed ? Math.max(0, Math.floor((now - nextDue) / DAY)) : 0

    // Results in the window.
    const rows = a?.rows || []
    const inWin = rows.filter((r) => r.date >= winStart)
    const byDate = new Map<string, DayStat>()
    for (const r of rows) {
      const d = byDate.get(r.date) ?? { date: r.date, leads: 0, sms: 0, delivered: null }
      d.leads += r.leads
      d.sms += r.smsSent
      if (r.delivered !== null) d.delivered = d.delivered === null ? r.delivered : (d.delivered + r.delivered) / 2
      byDate.set(r.date, d)
    }
    const history = Array.from(byDate.values()).sort((x, y) => x.date.localeCompare(y.date))
    const winDays = history.filter((d) => d.date >= winStart)
    const leads = inWin.reduce((s, r) => s + r.leads, 0)
    const sms = inWin.reduce((s, r) => s + r.smsSent, 0)
    const deliveredVals = inWin.map((r) => r.delivered).filter((v): v is number => v !== null)
    const delivered = deliveredVals.length ? deliveredVals.reduce((s, v) => s + v, 0) / deliveredVals.length : null

    // Niches and job value (weighted by leads per niche).
    const niches = a ? Array.from(a.niches.entries()).sort((x, y) => y[1] - x[1]).map(([n]) => n) : []
    const fallbackNiche = niches[0] ?? null
    const estRevWin = inWin.reduce((s, r) => s + r.leads * LEAD_TO_JOB * jobValueFor(r.niche || nicheFromName(r.client) || fallbackNiche), 0)
    const jobValue = leads > 0 ? estRevWin / (leads * LEAD_TO_JOB) : jobValueFor(fallbackNiche)

    // Monthly run-rate over the part of the window the client was being sent.
    const firstSent = history[0]?.date ?? null
    const activeFrom = Math.max(win.start, firstSent ? Date.parse(`${firstSent}T00:00:00Z`) : win.start)
    const spanDays = Math.max(1, (now - activeFrom) / DAY)
    const leadsMonth = inWin.length ? (leads / spanDays) * MONTH_DAYS : null
    const estJobsMonth = leadsMonth === null ? null : leadsMonth * LEAD_TO_JOB
    const estRevenueMonth = leadsMonth === null ? null : (estRevWin / spanDays) * MONTH_DAYS
    const roi = estRevenueMonth !== null && mrr > 0 ? estRevenueMonth / mrr : null
    const cpl = leadsMonth && mrr > 0 ? mrr / leadsMonth : null

    // Churned clients aren't rated; no billing or no EOD rows in the window → no data.
    const performance: Performance =
      status === 'churned' || roi === null ? 'no_data' : roi >= PERFORMANCE.performing ? 'performing' : roi >= PERFORMANCE.borderline ? 'borderline' : 'not_performing'

    // Lead trend: per sending day, last 7 days vs the 21 before.
    const cut7 = iso(now - 7 * DAY)
    const cut28 = iso(now - 28 * DAY)
    const recent = history.filter((d) => d.date >= cut7)
    const prior = history.filter((d) => d.date >= cut28 && d.date < cut7)
    const avg = (xs: DayStat[]) => (xs.length ? xs.reduce((s, d) => s + d.leads, 0) / xs.length : null)
    const rAvg = avg(recent)
    const pAvg = avg(prior)
    const trend = rAvg !== null && pAvg ? (rAvg - pAvg) / pAvg : null

    // Risk flags.
    const flags: RiskFlag[] = []
    if (status === 'active') {
      if (billed && daysOverdue > RISK.paymentGraceDays) flags.push({ level: 'major', text: `Payment ${daysOverdue}d overdue` })
      if (!billed && last !== null) {
        const ago = Math.floor((now - last) / DAY)
        if ((oneOffOnly || perEstimate) && ago <= 14) flags.push({ level: 'minor', text: `${perEstimate ? 'Pay per estimate' : 'One-off payment'} ${ago}d ago — no recurring billing` })
        else flags.push({ level: 'major', text: `Billing lapsed — last paid ${ago}d ago, still being sent` })
      }
      if (last === null) {
        if (bs.some((b) => b.setupOnly) || perEstimate) flags.push({ level: 'minor', text: bs.some((b) => b.setupOnly) ? 'Setup fee only — first charge pending' : 'Pay per estimate — no charge yet' })
        else flags.push({ level: 'major', text: 'Active on the sheet, no payment found in Commas' })
      }
      const lastN = eodDates.slice(-RISK.noSendDays)
      const hasRows = !!a?.rows.length
      if (hasRows && lastN.length === RISK.noSendDays && !lastN.some((d) => byDate.has(d))) flags.push({ level: 'major', text: `Not in last ${RISK.noSendDays} EODs` })
      if (!hasRows) flags.push({ level: rosterStatus === 'active' ? 'minor' : 'major', text: rosterStatus === 'active' ? 'No results recorded yet' : 'Paying but not in any EOD' })
      if (performance === 'not_performing') flags.push({ level: 'major', text: `Est. ROI ${roi!.toFixed(1)}x` })
      if (trend !== null && trend <= -RISK.leadDropMajor) flags.push({ level: 'major', text: `Leads down ${Math.round(-trend * 100)}%` })
      else if (trend !== null && trend <= -RISK.leadDropMinor) flags.push({ level: 'minor', text: `Leads down ${Math.round(-trend * 100)}%` })
      if (performance === 'borderline') flags.push({ level: 'minor', text: `Est. ROI ${roi!.toFixed(1)}x` })
      if (delivered !== null && delivered < RISK.deliveredMin) flags.push({ level: 'minor', text: `Delivered ${delivered.toFixed(0)}%` })
      if (first !== null && now - first < RISK.newClientDays * DAY) flags.push({ level: 'minor', text: 'New client' })
      if (hasRows && winDays.length > 0 && winDays.length < 3) flags.push({ level: 'minor', text: `Only ${winDays.length} send day${winDays.length > 1 ? 's' : ''} of data` })
    }
    if (status === 'no_billing') {
      if (bs.some((b) => b.setupOnly)) flags.push({ level: 'minor', text: 'Setup fee only — first charge pending' })
      else flags.push({ level: 'major', text: 'Being sent, no payment found in Commas' })
    }
    const highRisk = flags.some((f) => f.level === 'major') || flags.filter((f) => f.level === 'minor').length >= MINOR_FLAGS_FOR_HIGH

    // Name: the active roster account, else the fullest name seen.
    const activeRow = rosterRows.find((r) => r.status === 'active') ?? rosterRows[0]
    const displayName = (activeRow?.client ?? (a ? Array.from(a.names.entries()).sort((x, y) => y[0].length - x[0].length || y[1] - x[1])[0][0] : bs[0].name)).replace(/\s+\d+$/, '')
    clients.push({
      key,
      name: displayName,
      rosterStatus: rosterRows.length ? Array.from(new Set(rosterRows.map((r) => r.statusLabel))).join(' / ') : null,
      priceText: rosterRows.length ? Array.from(new Set(rosterRows.map((r) => r.priceText).filter(Boolean))).join(' + ') || null : null,
      niches,
      accounts: a ? Array.from(a.names.keys()) : [],
      billingName: bs.length ? Array.from(new Set(bs.map((b) => b.name))).join(' / ') : null,
      status,
      cadence: cadenceDays === null ? null : cadenceOf(cadenceDays),
      oneOffOnly,
      charge: override ? override.charge : paidBs.length ? (live.length ? live : paidBs).reduce((s, b) => s + b.charge, 0) : null,
      mrr,
      firstPaid: first !== null ? iso(first) : null,
      lastPaid: last !== null ? iso(last) : null,
      nextDue: nextDue !== null ? iso(nextDue) : null,
      daysOverdue,
      lifetimePaid: payments.reduce((s, p) => s + p.amount, 0),
      paidInWindow: payments.filter((p) => p.date >= winStart).reduce((s, p) => s + p.amount, 0),
      leads,
      sms,
      sendDays: winDays.length,
      leadsPerDay: winDays.length ? leads / winDays.length : null,
      delivered,
      lastSent: lastSentDate,
      jobValue,
      estJobsMonth,
      estRevenueMonth,
      roi,
      cpl,
      performance,
      highRisk,
      flags,
      trend,
      history,
      payments,
    })
  }

  // Drop dormant billing-only customers (paid long ago, never in an EOD) older than 90 days.
  const visible = clients.filter((c) => c.status !== 'churned' || c.accounts.length || (c.lastPaid && now - Date.parse(c.lastPaid) < 90 * DAY))

  const active = visible.filter((c) => c.status === 'active')
  const summary: ToolboxSummary = {
    active: active.length,
    paused: visible.filter((c) => c.status === 'paused').length,
    failedPay: visible.filter((c) => c.status === 'failed_pay').length,
    byCadence: {
      daily: active.filter((c) => c.cadence === 'daily').length,
      weekly: active.filter((c) => c.cadence === 'weekly').length,
      monthly: active.filter((c) => c.cadence === 'monthly').length,
    },
    churnedInWindow: visible.filter((c) => c.status === 'churned' && c.nextDue && c.nextDue >= winStart).length,
    mrr: active.reduce((s, c) => s + c.mrr, 0),
    leads: visible.reduce((s, c) => s + c.leads, 0),
    estRevenueMonth: active.reduce((s, c) => s + (c.estRevenueMonth || 0), 0),
    performing: active.filter((c) => c.performance === 'performing').length,
    notPerforming: active.filter((c) => c.performance === 'not_performing').length,
    highRisk: active.filter((c) => c.highRisk).length,
    unmatchedBilling: visible.filter((c) => c.status === 'no_billing').length,
  }
  return { window: { key: windowKey, start: iso(win.start), end: iso(now), days: win.days }, summary, clients: visible, eodDates: { first: eodDates[0] ?? null, last: eodDates[eodDates.length - 1] ?? null, count: eodDates.length } }
}
