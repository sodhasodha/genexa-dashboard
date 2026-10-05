import { unstable_cache } from 'next/cache'
import { cortanaGet } from '@/lib/clinics/client'
import { CACHE_SECONDS, CLINIC_META, DEFAULT_POD, EXCLUDED_BUSINESSES, type ClinicConfig } from '@/lib/clinics/config'

// The clinic roster: every Cortana business minus EXCLUDED_BUSINESSES, in Cortana's order.
// Pod / Slack pattern / display name come from CLINIC_META when present.

const fetchBusinesses = async (): Promise<{ id: string; name: string }[]> =>
  ((await cortanaGet('businesses'))?.data || []).map((b: any) => ({ id: String(b.id), name: String(b.name || b.id) }))
const businesses = unstable_cache(fetchBusinesses, ['cortana-businesses-v1'], { revalidate: CACHE_SECONDS, tags: ['clinic-kpis'] })

export const toClinic = (b: { id: string; name: string }): ClinicConfig => {
  const meta = CLINIC_META[b.id] || {}
  return { businessId: b.id, name: meta.name ?? b.name, pod: meta.pod ?? DEFAULT_POD, slackClient: meta.slackClient, bookingPod: meta.bookingPod }
}

export async function fetchRoster(): Promise<ClinicConfig[]> {
  return (await businesses()).filter((b) => !EXCLUDED_BUSINESSES[b.id]).map(toClinic)
}
