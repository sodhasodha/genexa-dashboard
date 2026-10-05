// Explicit clinic → Meta ad account / Genexa campaign binding, keyed by Cortana business id.
//
// Cortana's ad-account list isn't scoped per business and two businesses can surface the same
// campaign, so nothing here is inferred from names or from "the first account". A clinic only gets
// spend / impressions / clicks / Meta leads from campaigns that are BOTH in one of its `accounts`
// AND either listed in `campaignIds` or named to match `campaignPrefix`. A campaign listed under
// one clinic's `campaignIds` is never given to another clinic by prefix.
// A clinic with no entry shows "Not bound" — never another clinic's numbers.
//
// Drafted 2026-10-05 from Cortana attribution rows (account id + campaign id per row).
// `uncertain` marks bindings to double-check.

export type Binding = {
  accounts: string[] // Meta ad account ids, without the act_ prefix
  campaignIds: string[] // Genexa campaigns whose names don't carry the prefix
  campaignPrefix?: RegExp // new campaigns matching this are picked up automatically
  uncertain?: string
}

export const GENEXA_PREFIX = /^genexa\s*\|/i

export const BINDINGS: Record<string, Binding> = {
  // Beyond Stem Cells — "AC - Beyond Stem Cells". act_307945421713176 had no delivery in 60d.
  '14d26997-dca9-456e-b379-ad7d28504c1f': { accounts: ['659009857005776'], campaignIds: ['120251813902660047'], campaignPrefix: GENEXA_PREFIX },
  // IPC (Russell) — Cortana reports his campaign in the account named "…cleveland".
  'e62c2cb3-da61-4a41-a4cb-506ead4b830e': {
    accounts: ['978821704755890'],
    campaignIds: ['120251219340230334'], // 11 July Launch - $1499 Ads - IPC
    campaignPrefix: /^genexa\s*\|(?!\s*cleveland)/i,
    uncertain: 'Cortana shows this campaign in act_978821704755890 (named "…cleveland"), not act_1550873579584747',
  },
  // IPC Cleveland — its campaign is surfaced by Cortana under the Russell business.
  '1cea99f9-0fee-414c-8321-14a3a48b4ff4': {
    accounts: ['978821704755890'],
    campaignIds: ['120252860586310334'], // Genexa | Cleveland | Img & UGC | 3rd OCT
    campaignPrefix: /^genexa\s*\|\s*cleveland/i,
    uncertain: "Cortana's Cleveland business is connected to Georgia's ad account; ad numbers are read from the Russell business",
  },
  // IPC Georgia — "Interventional Pain Consultants" account.
  'c2e266c2-1371-49a7-9033-0a05db2624f2': { accounts: ['1550873579584747'], campaignIds: ['120252406723990163'], campaignPrefix: GENEXA_PREFIX },
  // Multivita IV — campaign runs in "Home Fixed it INC"; the clinic's own "MultiVita IV" account is disabled.
  'd919c593-216f-4c50-9906-2c98bfc60388': {
    accounts: ['1079606670620181', '523469470236586'],
    campaignIds: ['120249604626100128'], // Multivita IV - $1999 ADs - 11 July Launch
    campaignPrefix: GENEXA_PREFIX,
    uncertain: 'Campaign is in act_1079606670620181 ("Home Fixed it INC"), not the "MultiVita IV" account',
  },
  // Pivotal Health Florida — "Pivotal Health and Wellness-Darren Lastofsky".
  'ace397d2-aca1-4fa5-836a-17277a21fabc': {
    accounts: ['1032441997226344'],
    campaignIds: ['120248836495220703', '120249752648790703', '120250465719780703', '120250626158320703'],
    campaignPrefix: GENEXA_PREFIX,
    uncertain: 'Three campaigns have no "Genexa |" prefix; "Highest Perofrmers 27 May" is left out',
  },
  // Pure Health Medical — "Pure Health Medical Spa". The "(CM) … weight loss" campaigns aren't ours.
  '87db4b2c-ecbb-4e4d-960b-943b96c0b67a': {
    accounts: ['635515670294621'],
    campaignIds: ['120250079103530238'], // 4th Sept 2026 - Batch 1 - Images only - Starting Price
    campaignPrefix: GENEXA_PREFIX,
    uncertain: 'Campaign has no "Genexa |" prefix',
  },
  // Regen Rx — "Regen RX AL". GVTY / Staplerz / Low Intent campaigns in the same account aren't ours.
  '79a6bd5c-5a20-4b97-ad6e-4c8c57d089e1': { accounts: ['1981468182398179'], campaignIds: ['120250163338130107'], campaignPrefix: GENEXA_PREFIX },
  // Regenestem — "Regenestem Florida".
  '3ecf24a3-41e3-43b6-a84f-fee28a98b096': { accounts: ['2293482048090696'], campaignIds: ['120248922761610403'], campaignPrefix: GENEXA_PREFIX },
  // Reviv Florida — "AL REVIV Regenerative".
  '01ccb044-6ae0-4ced-81a3-fbafd75cbc60': { accounts: ['1008493701558167'], campaignIds: ['120249531634170599'], campaignPrefix: GENEXA_PREFIX },
  // Terry L Franklin MD — account is named "TelMD 2".
  '04cd16a9-2a8b-45c1-a6e5-b2bfb73e2471': {
    accounts: ['926482639147231'],
    campaignIds: ['120251117056400122'],
    campaignPrefix: GENEXA_PREFIX,
    uncertain: 'Ad account is named "TelMD 2"',
  },
  // Vitale Health.
  '621f3634-8a10-4576-8f15-b7909c5148f6': { accounts: ['1037026785668573'], campaignIds: ['120248072165010265', '120248060455850265'], campaignPrefix: GENEXA_PREFIX },
}
