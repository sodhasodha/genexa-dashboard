"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/staff";
import { geocode, type Geocoded } from "@/lib/domination/geocode";
import { createClient } from "@/lib/supabase/server";

// USA Domination map. Geocoding happens only here: when an address is saved / re-geocoded,
// or when someone searches a territory. Writes go through the user's Supabase client, so RLS
// (owner-only on clients and prospects) and the audit trigger apply.

const Id = z.uuid();
const Text = z.string().trim().min(2).max(300);
export type GeocodeResult = { ok: true; label: string } | { ok: false; error: string };

/** City and state as written at the end of a US address ("…, Plantation, FL 33324"). */
function cityState(address: string, hit: Geocoded) {
  const m = address.match(/,\s*([^,]+),\s*([A-Za-z]{2})\s+\d{5}/);
  return { city: m?.[1]?.trim() ?? hit.city, state: m?.[2]?.toUpperCase() ?? hit.state };
}

/** Geocode a clinic once and save the result. Pass an address to set or replace the stored one. */
export async function regeocodeClient(clientId: string, address?: string): Promise<GeocodeResult> {
  const me = await requireStaff();
  if (me.role !== "owner") return { ok: false, error: "Only the owner can change a clinic's location." };
  const id = Id.safeParse(clientId);
  if (!id.success) return { ok: false, error: "Unknown clinic." };
  const supabase = await createClient();
  const { data: client } = await supabase.from("clients").select("address").eq("id", id.data).maybeSingle();
  const entered = address === undefined ? null : Text.safeParse(address);
  if (entered && !entered.success) return { ok: false, error: "Enter the clinic's street address." };
  const use = entered?.data ?? client?.address ?? null;
  if (!use) return { ok: false, error: "No address saved for this clinic. Enter one first." };
  const hit = await geocode(use);
  if (!hit) return { ok: false, error: `Could not find "${use}". Check the address and try again.` };
  const { error } = await supabase
    .from("clients")
    .update({ address: use, ...cityState(use, hit), lat: hit.lat, lng: hit.lng, geocoded_at: new Date().toISOString() })
    .eq("id", id.data);
  if (error) return { ok: false, error: "Could not save the location." };
  revalidatePath("/clients");
  return { ok: true, label: hit.label };
}

/** Put a hot-pipeline prospect on the map: "City, ST". */
export async function setProspectLocation(prospectId: string, place: string): Promise<GeocodeResult> {
  const me = await requireStaff();
  if (me.role !== "owner") return { ok: false, error: "Only the owner can set a prospect's location." };
  const id = Id.safeParse(prospectId);
  const entered = Text.safeParse(place);
  if (!id.success || !entered.success) return { ok: false, error: "Enter a city and state, e.g. Tampa, FL." };
  const hit = await geocode(entered.data);
  if (!hit) return { ok: false, error: `Could not find "${entered.data}".` };
  const supabase = await createClient();
  const { error } = await supabase
    .from("prospects")
    .update({ city: hit.city ?? entered.data, ...(hit.state ? { state: hit.state } : {}), lat: hit.lat, lng: hit.lng })
    .eq("id", id.data);
  if (error) return { ok: false, error: "Could not save the location." };
  revalidatePath("/clients");
  return { ok: true, label: hit.label };
}

export type TerritorySearch = { ok: true; lat: number; lng: number; label: string; city: string | null; state: string | null } | { ok: false; error: string };

/** Territory checker: where is this address, city or ZIP? Census first, OpenStreetMap as fallback. */
export async function searchTerritory(query: string): Promise<TerritorySearch> {
  await requireStaff();
  const q = Text.safeParse(query);
  if (!q.success) return { ok: false, error: "Type an address, city or ZIP." };
  const hit = await geocode(q.data);
  if (!hit) return { ok: false, error: `Could not find "${q.data}" in the US.` };
  return { ok: true, lat: hit.lat, lng: hit.lng, label: hit.label, city: hit.city, state: hit.state };
}
