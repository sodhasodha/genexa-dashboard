// USA Domination map: the numbers every territory rule hangs off, and the distance maths.
// Pure functions only, so the same code runs on the server and in the browser.

/** A clinic's territory: this many miles around it. Change it here and everything follows. */
export const TERRITORY_RADIUS_MILES = 55;
/** Two territories overlap when the centres are closer than this (two radii). */
export const OVERLAP_DISTANCE_MILES = TERRITORY_RADIUS_MILES * 2;
/** A metro / micro area is a "target market" at this population or more. */
export const MIN_MARKET_POPULATION = 150_000;

const EARTH_RADIUS_MILES = 3958.7613;
const RAD = Math.PI / 180;

export type LatLng = { lat: number; lng: number };

/** Great-circle distance in miles (haversine). */
export function milesBetween(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The closest of `points` to `from`, with its distance. Null when there are none. */
export function nearest<T extends LatLng>(from: LatLng, points: T[]): { point: T; miles: number } | null {
  let best: { point: T; miles: number } | null = null;
  for (const point of points) {
    const miles = milesBetween(from, point);
    if (!best || miles < best.miles) best = { point, miles };
  }
  return best;
}

/** True when `p` is inside the territory of any of `centres`. */
export function insideAny(p: LatLng, centres: LatLng[], radius = TERRITORY_RADIUS_MILES): boolean {
  // Cheap latitude band first: a degree of latitude is ~69 miles everywhere.
  const band = radius / 69 + 0.01;
  for (const c of centres) {
    if (Math.abs(c.lat - p.lat) > band) continue;
    if (milesBetween(p, c) <= radius) return true;
  }
  return false;
}

// Static Census files in public/data (see scripts/build-domination-data.py for how they are made).
/** [name, lat, lng, population (2023 estimate), "M" metro | "u" micro] */
export type CbsaRow = [string, number, number, number, "M" | "u"];
/** [lat, lng, population (2020 Census), index into the CBSA file or -1] — the county's centre of population. */
export type CountyRow = [number, number, number, number];

export type Market = LatLng & { name: string; population: number; taken: boolean };

/** Every target market, flagged taken when its centre is inside a client territory. */
export function markets(cbsa: CbsaRow[], clients: LatLng[]): Market[] {
  return cbsa
    .filter((c) => c[3] >= MIN_MARKET_POPULATION)
    .map((c) => {
      const p = { lat: c[1], lng: c[2] };
      return { ...p, name: c[0], population: c[3], taken: insideAny(p, clients) };
    });
}

/** Share of the US population living in a county whose centre is inside a client territory (0-1). */
export function populationCovered(counties: CountyRow[], clients: LatLng[]): { covered: number; total: number; share: number } {
  let covered = 0;
  let total = 0;
  for (const c of counties) {
    total += c[2];
    // A county is counted once however many territories reach it.
    if (clients.length && insideAny({ lat: c[0], lng: c[1] }, clients)) covered += c[2];
  }
  return { covered, total, share: total ? covered / total : 0 };
}

export type Verdict = "available" | "overlap" | "taken";
export type TerritoryCheck = {
  verdict: Verdict;
  nearest: { name: string; city: string | null; miles: number } | null;
  /** Share of the people inside the searched circle who already sit inside a client territory (0-1). */
  overlapShare: number;
  population: number; // people inside the searched circle
  metro: { name: string; population: number } | null;
};

/** The verdict for a searched point against the clinics that hold territory. */
export function checkTerritory(
  point: LatLng,
  clients: (LatLng & { name: string; city: string | null })[],
  cbsa: CbsaRow[],
  counties: CountyRow[],
): TerritoryCheck {
  const near = nearest(point, clients);
  const verdict: Verdict = !near || near.miles > OVERLAP_DISTANCE_MILES ? "available" : near.miles > TERRITORY_RADIUS_MILES ? "overlap" : "taken";
  let population = 0;
  let shared = 0;
  let home: { row: CountyRow; miles: number } | null = null;
  for (const c of counties) {
    const p = { lat: c[0], lng: c[1] };
    if (Math.abs(p.lat - point.lat) > 2) continue;
    const miles = milesBetween(point, p);
    if (!home || miles < home.miles) home = { row: c, miles };
    if (miles > TERRITORY_RADIUS_MILES) continue;
    population += c[2];
    if (insideAny(p, clients)) shared += c[2];
  }
  // The metro is the one the nearest county belongs to.
  const index = home && home.miles <= 60 ? home.row[3] : -1;
  const metro = index >= 0 && cbsa[index] ? { name: cbsa[index][0], population: cbsa[index][3] } : null;
  return {
    verdict,
    nearest: near ? { name: near.point.name, city: near.point.city, miles: near.miles } : null,
    overlapShare: population ? shared / population : 0,
    population,
    metro,
  };
}

/** Points of a circle `miles` around a centre, as [lat, lng] pairs (for drawing). */
export function circlePoints(centre: LatLng, miles = TERRITORY_RADIUS_MILES, steps = 72): [number, number][] {
  const d = miles / EARTH_RADIUS_MILES;
  const lat1 = centre.lat * RAD;
  const lng1 = centre.lng * RAD;
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const brng = (i / steps) * 2 * Math.PI;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
    const lng2 = lng1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    out.push([lat2 / RAD, lng2 / RAD]);
  }
  return out;
}
