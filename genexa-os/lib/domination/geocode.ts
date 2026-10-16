import "server-only";

// Free geocoding, server-side only (neither service allows browser calls from our origin):
//   1. US Census Geocoder — street addresses.
//   2. Nominatim (OpenStreetMap) — fallback for cities, ZIPs and anything Census cannot place.
// Used when a clinic's address is saved or re-geocoded, and by the territory search. Never on page load.

export type Geocoded = { lat: number; lng: number; label: string; city: string | null; state: string | null; source: "census" | "nominatim" };

const TIMEOUT_MS = 12_000;
const get = (url: string, headers: Record<string, string> = {}) =>
  fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });

async function census(query: string): Promise<Geocoded | null> {
  const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${new URLSearchParams({ address: query, benchmark: "Public_AR_Current", format: "json" })}`;
  const res = await get(url);
  if (!res.ok) return null;
  const match = (await res.json())?.result?.addressMatches?.[0];
  if (!match?.coordinates) return null;
  const parts = match.addressComponents ?? {};
  return {
    lat: Number(match.coordinates.y),
    lng: Number(match.coordinates.x),
    label: String(match.matchedAddress ?? query),
    city: parts.city ? titleCase(String(parts.city)) : null,
    state: parts.state ? String(parts.state) : null,
    source: "census",
  };
}

async function nominatim(query: string): Promise<Geocoded | null> {
  const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: query, format: "jsonv2", countrycodes: "us", limit: "1", addressdetails: "1" })}`;
  // Nominatim's usage policy asks for an identifying User-Agent.
  const res = await get(url, { "User-Agent": "GenexaOperations/1.0 (ops.genexascaling.com)", "Accept-Language": "en" });
  if (!res.ok) return null;
  const hit = (await res.json())?.[0];
  if (!hit) return null;
  const a = hit.address ?? {};
  const state = typeof a["ISO3166-2-lvl4"] === "string" ? a["ISO3166-2-lvl4"].replace("US-", "") : null;
  return {
    lat: Number(hit.lat),
    lng: Number(hit.lon),
    label: String(hit.display_name ?? query),
    city: a.city ?? a.town ?? a.village ?? a.hamlet ?? a.county ?? null,
    state,
    source: "nominatim",
  };
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** Coordinates for an address, city or ZIP. Null when neither service can place it. */
export async function geocode(query: string): Promise<Geocoded | null> {
  const q = query.trim();
  if (!q) return null;
  // Suite / unit numbers and plaza names trip both services up, so each is also tried without them.
  const plain = q.replace(/[,\s]+(suite|ste|unit|apt|bldg|building|#)\.?\s*#?[\w-]+/gi, "").replace(/\s+,/g, ",").trim();
  const tries = plain && plain !== q ? [q, plain] : [q];
  // A street address has a number and a word; anything else (city, ZIP) goes straight to Nominatim.
  const looksLikeStreet = /\d+\s+\S+/.test(q) && !/^\d{5}(-\d{4})?$/.test(q);
  if (looksLikeStreet) {
    for (const t of tries) {
      const hit = await census(t).catch(() => null);
      if (hit) return hit;
    }
  }
  for (const t of tries) {
    const hit = await nominatim(t).catch(() => null);
    if (hit) return hit;
  }
  return null;
}
