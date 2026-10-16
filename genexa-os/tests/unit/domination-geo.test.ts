import { describe, expect, it } from "vitest";
import {
  OVERLAP_DISTANCE_MILES, TERRITORY_RADIUS_MILES, checkTerritory, circlePoints, insideAny, markets, milesBetween, populationCovered,
  type CbsaRow, type CountyRow,
} from "@/lib/domination/geo";

const NYC = { lat: 40.7128, lng: -74.006 };
const LA = { lat: 34.0522, lng: -118.2437 };
/** A point `miles` due north of `from`. */
const north = (from: { lat: number; lng: number }, miles: number) => ({ lat: from.lat + miles / 69.0933, lng: from.lng });

describe("domination geo", () => {
  it("measures great-circle miles", () => {
    expect(milesBetween(NYC, LA)).toBeGreaterThan(2440);
    expect(milesBetween(NYC, LA)).toBeLessThan(2460);
    expect(milesBetween(NYC, NYC)).toBe(0);
    expect(milesBetween(NYC, north(NYC, 55))).toBeCloseTo(55, 0);
  });

  it("draws a circle whose edge is the radius away", () => {
    for (const [lat, lng] of circlePoints(NYC)) expect(milesBetween(NYC, { lat, lng })).toBeCloseTo(TERRITORY_RADIUS_MILES, 1);
  });

  it("counts a county once when two territories overlap", () => {
    const a = NYC;
    const b = north(NYC, 20);
    const counties: CountyRow[] = [
      [north(NYC, 10).lat, NYC.lng, 1000, -1], // inside both
      [north(NYC, 70).lat, NYC.lng, 500, -1], // inside b only
      [LA.lat, LA.lng, 8500, -1], // inside neither
    ];
    expect(populationCovered(counties, [a, b])).toEqual({ covered: 1500, total: 10000, share: 0.15 });
    expect(populationCovered(counties, []).share).toBe(0);
  });

  it("only treats 150k+ areas as markets and flags the ones inside a territory", () => {
    const cbsa: CbsaRow[] = [
      ["Near, NY", north(NYC, 30).lat, NYC.lng, 900_000, "M"],
      ["Far, CA", LA.lat, LA.lng, 5_000_000, "M"],
      ["Small, NY", NYC.lat, NYC.lng, 149_999, "u"],
    ];
    const m = markets(cbsa, [NYC]);
    expect(m.map((x) => [x.name, x.taken])).toEqual([["Near, NY", true], ["Far, CA", false]]);
  });

  it("gives the three verdicts at the two thresholds", () => {
    const clients = [{ ...NYC, name: "Clinic", city: "New York" }];
    const counties: CountyRow[] = [[NYC.lat, NYC.lng, 1000, 0], [north(NYC, 80).lat, NYC.lng, 1000, -1]];
    const cbsa: CbsaRow[] = [["New York, NY", NYC.lat, NYC.lng, 19_000_000, "M"]];
    const at = (miles: number) => checkTerritory(north(NYC, miles), clients, cbsa, counties);
    expect(at(TERRITORY_RADIUS_MILES - 5).verdict).toBe("taken");
    expect(at(TERRITORY_RADIUS_MILES + 5).verdict).toBe("overlap");
    expect(at(OVERLAP_DISTANCE_MILES + 5).verdict).toBe("available");
    expect(insideAny(north(NYC, 54), [NYC])).toBe(true);
    // 80 miles out: the circle holds the far county (uncovered) and the near one is 80 miles away.
    const overlap = at(80);
    expect(overlap.nearest?.name).toBe("Clinic");
    expect(overlap.overlapShare).toBe(0);
    expect(at(10).metro?.name).toBe("New York, NY");
    expect(at(10).overlapShare).toBe(1);
  });
});
