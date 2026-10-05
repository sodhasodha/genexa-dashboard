// Acceptance checks for the Genexa Clients tab, run against a live deployment or `next dev`.
//   node scripts/check-clinics.mjs [baseUrl] [window]     (CORTANA_API_KEY must be set; read-only)
// Compares /api/clinics/kpis with Cortana directly. Exits 1 if any check fails.

const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '')
const windowKey = process.argv[3] || 'mtd'
const key = process.env.CORTANA_API_KEY
if (!key) throw new Error('CORTANA_API_KEY not set')

const EXCLUDED = ['53f99ff4-efdd-4458-8fc0-19946fd28f17', '893e8bff-93f9-41b2-b85b-0e98b5bafb7d', '74eddd7b-f64d-45e0-b5ae-906969bb32d1', '1e384b1e-903c-47ed-9ee5-402826d62792']
const ID = {
  reviv: '01ccb044-6ae0-4ced-81a3-fbafd75cbc60',
  cleveland: '1cea99f9-0fee-414c-8321-14a3a48b4ff4',
  georgia: 'c2e266c2-1371-49a7-9033-0a05db2624f2',
  multivita: 'd919c593-216f-4c50-9906-2c98bfc60388',
  regenRx: '79a6bd5c-5a20-4b97-ad6e-4c8c57d089e1',
}
const REGEN_RX_CAMPAIGN = '120250163338130107'

const cortana = async (path) => {
  const res = await fetch(`https://app.usecortana.ai/api/v1/${path}`, { headers: { Authorization: `Bearer ${key}` } })
  if (!res.ok) throw new Error(`Cortana ${res.status} for ${path}`)
  return res.json()
}
const usd = (n) => `$${n.toFixed(2)}`
let failures = 0
const check = (name, pass, detail) => {
  if (!pass) failures++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`)
}

const res = await fetch(`${base}/api/clinics/kpis?window=${windowKey}`)
if (!res.ok) throw new Error(`${base} returned ${res.status}`)
const data = await res.json()
const by = Object.fromEntries(data.clinics.map((c) => [c.businessId, c]))
console.log(`${base} · ${data.label} · ${data.clinics.length} clinics · generated ${data.generatedAt}\n`)

// 1. Roster
const businesses = (await cortana('businesses')).data
const expected = businesses.filter((b) => !EXCLUDED.includes(b.id))
const missing = expected.filter((b) => !by[b.id]).map((b) => b.name)
check(
  '1. Roster = Cortana businesses minus exclusions, incl. Reviv Florida and IPC Cleveland',
  data.clinics.length === expected.length && !missing.length && !!by[ID.reviv] && !!by[ID.cleveland] && !data.clinics.some((c) => EXCLUDED.includes(c.businessId)),
  `Cortana ${businesses.length} businesses − ${EXCLUDED.length} excluded = ${expected.length}; dashboard ${data.clinics.length}; missing: ${missing.join(', ') || 'none'}`
)

// 2. IPC Georgia vs IPC Cleveland
const g = by[ID.georgia]?.raw
const c = by[ID.cleveland]?.raw
const differ = g && c && (g.spend.toFixed(2) !== c.spend.toFixed(2) || g.impressions !== c.impressions)
check(
  '2. IPC Georgia and IPC Cleveland differ, or both show a duplicate-source error',
  !!differ || (!!g?.dataError && !!c?.dataError),
  `Georgia ${usd(g?.spend ?? 0)} / ${g?.impressions} impressions${g?.dataError ? ' [data error]' : ''}; Cleveland ${usd(c?.spend ?? 0)} / ${c?.impressions} impressions${c?.dataError ? ' [data error]' : ''}`
)

// 3. MultiVita
const mv = by[ID.multivita]?.raw
check(
  '3. MultiVita shows "Account disabled", not a bare $0',
  !!mv?.accounts.some((a) => a.state === 'disabled'),
  `spend ${usd(mv?.spend ?? 0)}; accounts: ${(mv?.accounts || []).map((a) => `${a.name} → ${a.label}`).join(' | ')}`
)

// 4. Regen Rx — spend and revenue only from the Genexa campaign
const qs = new URLSearchParams({ startDate: data.start, endDate: data.end, groupBy: 'campaign' })
const rxRows = (await cortana(`businesses/${ID.regenRx}/attribution?${qs}`)).data.data
const genexa = rxRows.find((r) => String(r.platformEntityId) === REGEN_RX_CAMPAIGN)
const accountSpend = rxRows.reduce((s, r) => s + (r.spent || 0), 0)
const metaPurchaseValue = rxRows.reduce((s, r) => s + (Number(r.purchaseValue) || 0), 0)
const genexaCloses = genexa?.conversions?.purchase?.revenue ?? 0
const rx = by[ID.regenRx]?.raw
check(
  '4. Regen Rx revenue and spend exclude the non-Genexa campaigns',
  !!rx && Math.abs(rx.spend - (genexa?.spent ?? 0)) < 25 && rx.revenue <= genexaCloses + 0.01,
  `dashboard spend ${usd(rx?.spend ?? 0)} vs Genexa campaign ${usd(genexa?.spent ?? 0)} (whole account ${usd(accountSpend)}); dashboard revenue ${usd(rx?.revenue ?? 0)} vs Cortana closes on the Genexa campaign ${usd(genexaCloses)}; Meta purchase value on other campaigns ${usd(metaPurchaseValue)} (not counted)`
)

// 5. Funnel rates
const RATES = ['ctr', 'clickToLead', 'bookingRate', 'confirmationRate', 'closeRate', 'leadToSale']
const over = []
let flagged = 0
for (const cl of data.clinics) {
  for (const k of RATES) {
    if ((cl.kpis[k].value ?? 0) > 100) over.push(`${cl.name} ${k} ${cl.kpis[k].value}`)
    if (cl.kpis[k].error) flagged++
  }
  for (const s of cl.funnel) if ((s.pct ?? 0) > 100) over.push(`${cl.name} funnel ${s.label} ${s.pct}`)
}
check('5. No funnel rate above 100%', !over.length, over.length ? over.join('; ') : `${data.clinics.length} clinics × ${RATES.length} rates + funnels checked; ${flagged} flagged as data errors instead of shown`)

// 6. ZZTEST contacts
const start = Date.parse(data.start)
const end = Date.parse(data.end)
const leaked = []
let zz = 0
for (const cl of data.clinics) {
  const dropped = new Set(cl.raw.testContacts)
  for (let page = 1; page < 40; page++) {
    const p = new URLSearchParams({ from: data.start, limit: '100', page: String(page), sort: '-occurredAt' })
    const json = await cortana(`businesses/${cl.businessId}/conversions/entries?${p}`)
    for (const e of json.data) {
      const at = Date.parse(e.occurredAt)
      if (at < start || at >= end || !/zztest/i.test(`${e.contact?.name} ${e.contact?.email}`)) continue
      zz++
      if (cl.raw.bound && !dropped.has(String(e.contactId))) leaked.push(`${cl.name}: ${e.configName} ${e.occurredAt}`)
    }
    if (!json.pagination?.hasMore) break
  }
}
check('6. No ZZTEST contact appears in any count', !leaked.length, leaked.length ? leaked.join('; ') : `${zz} ZZTEST events found in Cortana for the window; every one belongs to a contact the dashboard dropped`)

// 7. Totals
const rows = data.clinics.filter((cl) => cl.live && !cl.raw.error && !cl.raw.dataError)
const sum = rows.reduce((s, cl) => s + cl.raw.spend, 0)
check('7. Total spend card = sum of the clinic rows', Math.abs(sum - data.summary.spend) < 0.005, `card ${usd(data.summary.spend)}; sum of ${rows.length} live rows ${usd(sum)}`)

console.log(`\n${failures ? `${failures} check(s) FAILED` : 'All 7 checks passed'}`)
process.exit(failures ? 1 : 0)
