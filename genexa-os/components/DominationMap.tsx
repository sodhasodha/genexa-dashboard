"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type * as Leaflet from "leaflet";
import { regeocodeClient, searchTerritory, setProspectLocation } from "@/lib/actions/domination";
import {
  MIN_MARKET_POPULATION, OVERLAP_DISTANCE_MILES, TERRITORY_RADIUS_MILES,
  checkTerritory, circlePoints, markets, populationCovered,
  type CbsaRow, type CountyRow, type LatLng, type Market, type TerritoryCheck,
} from "@/lib/domination/geo";
import type { DominationData, MapClient, MapProspect } from "@/lib/queries/domination";

// USA Domination: every clinic as a pin with its territory, the markets still open, and a
// territory checker. Self-contained: the Clients page only passes in the clinics and prospects.
// The Census files load from /data on demand, and all the territory maths runs in the browser.

const BRAND = "#ff6a1a"; // active clinics
const AMBER = "#f2c230"; // onboarding / launching
const GREY = "#8d8c84"; // paused / churned
const PIPELINE = "#7dd3fc"; // hot pipeline (hollow)
const US_BOUNDS: [[number, number], [number, number]] = [[24.4, -125], [49.6, -66.6]];
// OpenStreetMap's own tiles need no key; they are darkened with a CSS filter (see .dom-map below).
const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const VERDICT = {
  available: { label: "AVAILABLE", tone: "border-good/50 bg-good-bg text-good" },
  overlap: { label: "OVERLAP", tone: "border-warn/50 bg-warn-bg text-warn" },
  taken: { label: "TAKEN", tone: "border-bad/50 bg-bad-bg text-bad" },
} as const;

type Placed<T> = T & LatLng;
type Searched = { point: LatLng; label: string; short: string; check: TerritoryCheck };
type Suggestion = { label: string; sub: string; point: LatLng };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const people = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : `${Math.round(n / 1000)}k`);
const money = (n: number | null) => (n === null ? "no data" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }));
const count = (n: number | null) => (n === null ? "no data" : String(Math.round(n)));
const place = (c: { city: string | null; state: string | null }) => [c.city, c.state].filter(Boolean).join(", ");
const hasPoint = <T extends { lat: number | null; lng: number | null }>(x: T): x is Placed<T> => x.lat !== null && x.lng !== null;

function clientTip(c: MapClient, month: string) {
  const status = c.status === "active" ? "Active" : c.status === "onboarding" ? "Onboarding" : c.stage === "paused" ? "Paused" : "Churned";
  return `<div class="dom-tip-title">${esc(c.name)}</div>
    <div class="dom-tip-sub">${esc(place(c) || "No city saved")} · ${status}</div>
    <div class="dom-tip-sub">Launched ${c.launch_date ? esc(c.launch_date) : "— no launch date"}</div>
    <div class="dom-tip-grid"><span>${esc(month)} shows</span><b>${count(c.shows)}</b><span>Closes</span><b>${count(c.closes)}</b><span>Revenue</span><b>${money(c.revenue)}</b></div>`;
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={`mt-0.5 text-3xl font-semibold tabular-nums tracking-tight ${tone ?? ""}`}>{value}</div>
      <div className="mt-0.5 text-xs text-muted">{sub}</div>
    </div>
  );
}

export function DominationMap({ data, canEdit, monthLabel }: { data: DominationData; canEdit: boolean; monthLabel: string }) {
  const router = useRouter();
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const layers = useRef<{ L: typeof Leaflet; base: Leaflet.LayerGroup; search: Leaflet.LayerGroup } | null>(null);
  /** True while the map still shows the default whole-US view. */
  const framed = useRef(true);
  const [ready, setReady] = useState(false);
  const [census, setCensus] = useState<{ cbsa: CbsaRow[]; counties: CountyRow[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [showPipeline, setShowPipeline] = useState(false);

  const [query, setQuery] = useState("");
  const [suggestQuery, setSuggestQuery] = useState("");
  const [searched, setSearched] = useState<Searched | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [searching, startSearch] = useTransition();
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [fixing, startFix] = useTransition();
  const [fixMessage, setFixMessage] = useState<string | null>(null);

  // Who holds territory: active clinics for the headline numbers; active + onboarding for what is still open.
  const placed = useMemo(() => data.clients.filter(hasPoint), [data.clients]);
  const active = useMemo(() => placed.filter((c) => c.status === "active"), [placed]);
  const holders = useMemo(() => placed.filter((c) => c.status !== "inactive"), [placed]);
  const missing = useMemo(() => data.clients.filter((c) => !hasPoint(c)), [data.clients]);
  const prospects = useMemo(() => data.prospects.filter(hasPoint), [data.prospects]);
  const unplacedProspects = useMemo(() => data.prospects.filter((p) => !hasPoint(p)), [data.prospects]);

  const stats = useMemo(() => {
    if (!census) return null;
    const all: Market[] = markets(census.cbsa, holders);
    const open = all.filter((m) => !m.taken).sort((a, b) => b.population - a.population);
    return {
      markets: all,
      open,
      conquered: populationCovered(census.counties, active),
      withOnboarding: populationCovered(census.counties, holders),
    };
  }, [census, active, holders]);

  // Census files: fetched once, cached by the browser.
  useEffect(() => {
    let cancelled = false;
    Promise.all([fetch("/data/us-cbsa.json").then((r) => r.json()), fetch("/data/us-counties.json").then((r) => r.json())])
      .then(([cbsa, counties]) => !cancelled && setCensus({ cbsa, counties }))
      .catch(() => !cancelled && setLoadError("Could not load the US market data."));
    return () => {
      cancelled = true;
    };
  }, []);

  // The map itself. Leaflet touches window, so it loads in the browser only.
  useEffect(() => {
    let cancelled = false;
    let resize: ResizeObserver | null = null;
    import("leaflet").then((mod) => {
      const L = (mod as unknown as { default?: typeof Leaflet }).default ?? mod;
      if (cancelled || !mapEl.current || mapRef.current) return;
      const map = L.map(mapEl.current, { zoomControl: true, scrollWheelZoom: false, minZoom: 3, maxZoom: 11, zoomSnap: 0.25, attributionControl: true });
      L.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(map);
      map.fitBounds(US_BOUNDS);
      // Wheel zoom only after a click, so scrolling the page never gets trapped in the map.
      map.on("click", () => map.scrollWheelZoom.enable());
      map.on("mouseout", () => map.scrollWheelZoom.disable());
      // Keep the whole country framed as the layout settles or the window resizes, until the
      // map has been moved by hand or a search has zoomed it.
      const el = mapEl.current;
      const touch = () => (framed.current = false);
      for (const ev of ["pointerdown", "wheel", "keydown"]) el.addEventListener(ev, touch, { passive: true });
      resize = new ResizeObserver(() => {
        map.invalidateSize();
        if (framed.current) map.fitBounds(US_BOUNDS, { animate: false });
      });
      resize.observe(el);
      mapRef.current = map;
      layers.current = { L, base: L.layerGroup().addTo(map), search: L.layerGroup().addTo(map) };
      setReady(true);
    });
    return () => {
      cancelled = true;
      resize?.disconnect();
      mapRef.current?.remove();
      mapRef.current = null;
      layers.current = null;
    };
  }, []);

  // Pins, territories and open markets.
  useEffect(() => {
    const ctx = layers.current;
    if (!ready || !ctx) return;
    const { L, base } = ctx;
    base.clearLayers();
    const tip = { direction: "top" as const, className: "dom-tip", opacity: 1, offset: [0, -6] as [number, number] };

    for (const m of stats?.open ?? []) {
      L.circleMarker([m.lat, m.lng], { radius: 2.5, stroke: false, fillColor: "#ffffff", fillOpacity: 0.28 })
        .bindTooltip(`<div class="dom-tip-title">${esc(m.name)}</div><div class="dom-tip-sub">${people(m.population)} people · <b class="dom-open">Available</b></div>`, tip)
        .addTo(base);
    }
    const shown = placed.filter((c) => c.status !== "inactive" || showInactive);
    // Territories first so every pin sits on top of every circle.
    for (const c of shown) {
      const colour = c.status === "active" ? BRAND : c.status === "onboarding" ? AMBER : GREY;
      L.polygon(circlePoints(c), {
        color: colour, weight: c.status === "active" ? 1.2 : 1, opacity: c.status === "inactive" ? 0.35 : 0.75,
        dashArray: c.status === "active" ? undefined : "4 4", fillColor: colour, fillOpacity: c.status === "active" ? 0.14 : c.status === "onboarding" ? 0.07 : 0.03,
        interactive: false,
      }).addTo(base);
    }
    for (const c of shown) {
      const colour = c.status === "active" ? BRAND : c.status === "onboarding" ? AMBER : GREY;
      L.circleMarker([c.lat, c.lng], { radius: c.status === "active" ? 6 : 5, color: "#0b0b0a", weight: 1.5, fillColor: colour, fillOpacity: 1 })
        .bindTooltip(clientTip(c, monthLabel), tip)
        .on("click", () => router.push(`/clients/${c.id}`))
        .addTo(base);
    }
    if (showPipeline) {
      for (const p of prospects) {
        L.circleMarker([p.lat, p.lng], { radius: 6, color: PIPELINE, weight: 2, fillOpacity: 0 })
          .bindTooltip(`<div class="dom-tip-title">${esc(p.name)}</div><div class="dom-tip-sub">Hot pipeline · ${esc(p.stage.replace("_", " "))}${place(p) ? ` · ${esc(place(p))}` : ""}</div>`, tip)
          .on("click", () => router.push(`/pipeline/${p.id}`))
          .addTo(base);
      }
    }
  }, [ready, stats, placed, prospects, showInactive, showPipeline, monthLabel, router]);

  // The searched location: pin, dashed circle, zoom to fit.
  useEffect(() => {
    const ctx = layers.current;
    const map = mapRef.current;
    if (!ready || !ctx || !map) return;
    ctx.search.clearLayers();
    if (!searched) return;
    framed.current = false;
    const ring = circlePoints(searched.point);
    ctx.L.polygon(ring, { color: "#ffffff", weight: 1.5, dashArray: "6 6", fillColor: "#ffffff", fillOpacity: 0.04, interactive: false }).addTo(ctx.search);
    ctx.L.circleMarker([searched.point.lat, searched.point.lng], { radius: 6, color: "#0b0b0a", weight: 1.5, fillColor: "#ffffff", fillOpacity: 1 })
      .bindTooltip(`<div class="dom-tip-title">${esc(searched.short)}</div><div class="dom-tip-sub">${VERDICT[searched.check.verdict].label}</div>`, { direction: "top", className: "dom-tip", opacity: 1, offset: [0, -6] })
      .addTo(ctx.search);
    const bounds = ctx.L.latLngBounds(ring);
    const near = searched.check.nearest;
    const neighbour = near && near.miles <= OVERLAP_DISTANCE_MILES * 1.5 ? holders.find((h) => h.name === near.name) : null;
    if (neighbour) bounds.extend(circlePoints(neighbour));
    map.fitBounds(bounds, { padding: [24, 24] });
  }, [ready, searched, holders]);

  const suggestions: Suggestion[] = useMemo(() => {
    const q = suggestQuery.trim().toLowerCase();
    if (q.length < 2 || !census) return [];
    const pool: Suggestion[] = [
      ...holders.map((c) => ({ label: c.name, sub: `Client · ${place(c)}`, point: { lat: c.lat, lng: c.lng } })),
      ...census.cbsa.map((c) => ({ label: c[0], sub: `${c[4] === "M" ? "Metro" : "Micro"} area · ${people(c[3])}`, point: { lat: c[1], lng: c[2] } })),
    ];
    const starts = pool.filter((s) => s.label.toLowerCase().startsWith(q));
    const contains = pool.filter((s) => !s.label.toLowerCase().startsWith(q) && s.label.toLowerCase().includes(q));
    return [...starts, ...contains].slice(0, 6);
  }, [suggestQuery, census, holders]);

  function runCheck(point: LatLng, label: string, short: string) {
    if (!census) return;
    setSearchError(null);
    setCopied(false);
    setSuggestQuery("");
    setSearched({ point, label, short, check: checkTerritory(point, holders, census.cbsa, census.counties) });
  }
  function onType(value: string) {
    setQuery(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setSuggestQuery(value), 200);
  }
  function submit() {
    const q = query.trim();
    if (!q || !census) return;
    if (debounce.current) clearTimeout(debounce.current);
    setSuggestQuery("");
    startSearch(async () => {
      const r = await searchTerritory(q);
      if (!r.ok) {
        setSearched(null);
        setSearchError(r.error);
        return;
      }
      runCheck({ lat: r.lat, lng: r.lng }, r.label, [r.city, r.state].filter(Boolean).join(" ") || q);
    });
  }
  function clear() {
    setSearched(null);
    setSearchError(null);
    setQuery("");
    setSuggestQuery("");
    framed.current = true;
    mapRef.current?.fitBounds(US_BOUNDS);
  }

  const near = searched?.check.nearest ?? null;
  const summary = searched
    ? `${searched.short}: ${VERDICT[searched.check.verdict].label}, ${near ? `nearest client ${near.city ?? near.name} ${Math.round(near.miles)} mi` : "no clients yet"}`
    : "";
  function copy() {
    navigator.clipboard?.writeText(summary).then(() => setCopied(true), () => setCopied(false));
  }

  function fix(run: () => Promise<{ ok: boolean; error?: string; label?: string }>) {
    setFixMessage(null);
    startFix(async () => {
      const r = await run();
      setFixMessage(r.ok ? `Saved: ${r.label}` : (r.error ?? "Could not save."));
      if (r.ok) router.refresh();
    });
  }

  const onboarding = data.clients.filter((c) => c.status === "onboarding").length;
  const activeCount = data.clients.filter((c) => c.status === "active").length;
  const toggle = (on: boolean) => `cursor-pointer rounded border px-2.5 py-1 text-xs ${on ? "border-accent bg-accent/15 text-ink" : "border-line text-muted hover:text-ink"}`;
  const field = "min-w-0 flex-1 rounded border border-line bg-raised px-2.5 py-1.5 text-sm";

  return (
    <section className="flex flex-col gap-3" aria-label="USA Domination">
      <style>{`
        .dom-map { background: #0b0b0a; }
        .dom-map .leaflet-container { background: #0b0b0a; font: inherit; }
        .dom-map .leaflet-tile-pane { filter: invert(1) hue-rotate(180deg) grayscale(0.75) brightness(0.72) contrast(1.15); }
        .dom-map .leaflet-control-zoom a { background: #1a1a19; color: #fff; border-color: #2e2e2b; }
        .dom-map .leaflet-control-attribution { background: rgba(17,17,16,.7); color: #a9a89e; font-size: 10px; }
        .dom-map .leaflet-control-attribution a { color: #a9a89e; }
        .leaflet-tooltip.dom-tip { background: #1a1a19; border: 1px solid #2e2e2b; color: #fff; border-radius: 8px; padding: 8px 10px; box-shadow: 0 6px 24px rgba(0,0,0,.5); font-size: 12px; white-space: nowrap; }
        .leaflet-tooltip.dom-tip::before { display: none; }
        .dom-tip-title { font-weight: 600; font-size: 13px; }
        .dom-tip-sub { color: #a9a89e; margin-top: 1px; }
        .dom-tip-grid { display: grid; grid-template-columns: auto auto; gap: 1px 14px; margin-top: 6px; }
        .dom-tip-grid span { color: #a9a89e; }
        .dom-tip-grid b { text-align: right; font-variant-numeric: tabular-nums; }
        .dom-open { color: #4cc38a; font-weight: 600; }
      `}</style>

      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">USA Domination</h2>
          <p className="text-xs text-muted">
            Each clinic holds everything within {TERRITORY_RADIUS_MILES} miles. Target markets are US metro and micro areas of {people(MIN_MARKET_POPULATION)}+ people.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Territories taken" value={String(activeCount)} sub={`active clinics${onboarding ? ` · +${onboarding} onboarding` : ""}`} tone="text-[#ff6a1a]" />
        <Stat
          label="Territories available"
          value={stats ? String(stats.open.length) : "…"}
          sub={stats ? `of ${stats.markets.length} target markets · no client within ${TERRITORY_RADIUS_MILES} mi` : "loading markets"}
        />
        <Stat
          label="% of US conquered"
          value={stats ? `${(stats.conquered.share * 100).toFixed(1)}%` : "…"}
          sub={stats ? `${people(stats.conquered.covered)} of ${people(stats.conquered.total)} people · ${(stats.withOnboarding.share * 100).toFixed(1)}% once onboarding launch` : "loading population"}
        />
      </div>

      <div className="relative">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            value={query}
            onChange={(e) => onType(e.target.value)}
            placeholder="Check a territory: address, city or ZIP"
            aria-label="Check a territory"
            autoComplete="off"
            className={field}
          />
          <button type="submit" disabled={searching || !query.trim() || !census} className="cursor-pointer rounded bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:cursor-default disabled:opacity-60">
            {searching ? "Checking…" : "Check"}
          </button>
          {searched || query ? (
            <button type="button" onClick={clear} className="cursor-pointer rounded border border-line px-3 py-1.5 text-sm text-muted hover:text-ink">Clear</button>
          ) : null}
        </form>
        {suggestions.length > 0 ? (
          <ul className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-line bg-panel shadow-xl">
            {suggestions.map((s) => (
              <li key={`${s.label}${s.sub}`}>
                <button
                  type="button"
                  onClick={() => {
                    setQuery(s.label);
                    runCheck(s.point, s.label, s.label);
                  }}
                  className="flex w-full cursor-pointer items-baseline justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-raised"
                >
                  <span className="truncate">{s.label}</span>
                  <span className="shrink-0 text-xs text-muted">{s.sub}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {searchError ? <p role="alert" className="rounded bg-bad-bg px-3 py-2 text-sm text-bad">{searchError}</p> : null}

      {searched ? (
        <div className={`rounded-lg border px-4 py-3 ${VERDICT[searched.check.verdict].tone}`}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-lg font-semibold tracking-wide">{VERDICT[searched.check.verdict].label}</span>
            <span className="min-w-0 truncate text-sm text-ink" title={searched.label}>{searched.label}</span>
            <span className="ml-auto flex gap-2">
              <button type="button" onClick={copy} className="cursor-pointer rounded border border-current/40 px-2.5 py-1 text-xs">{copied ? "Copied" : "Copy result"}</button>
              <button type="button" onClick={clear} className="cursor-pointer rounded border border-current/40 px-2.5 py-1 text-xs">Clear</button>
            </span>
          </div>
          <p className="mt-1 text-sm text-ink">
            {!near
              ? "No clients on the map yet."
              : searched.check.verdict === "taken"
                ? `Inside ${near.name}'s territory${near.city ? ` (${near.city})` : ""}: ${near.miles.toFixed(1)} miles away.`
                : searched.check.verdict === "overlap"
                  ? `Outside every territory, but its circle overlaps ${near.name}${near.city ? ` (${near.city})` : ""}, ${Math.round(near.miles)} miles away. ${searched.check.overlapShare < 0.01 ? "Under 1%" : `About ${Math.round(searched.check.overlapShare * 100)}%`} of the people in this circle are already covered.`
                  : `No overlap. Nearest client is ${near.name}${near.city ? ` (${near.city})` : ""}, ${Math.round(near.miles)} miles away (clear beyond ${OVERLAP_DISTANCE_MILES}).`}
          </p>
          <p className="mt-1 text-xs text-muted">
            {searched.check.metro ? `${searched.check.metro.name} · ${people(searched.check.metro.population)} people in the metro` : "Not in a metro or micro area"}
            {` · ${people(searched.check.population)} people within ${TERRITORY_RADIUS_MILES} miles`}
          </p>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 overflow-hidden rounded-lg border border-line">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line bg-panel px-3 py-2 text-xs text-muted">
            <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full" style={{ background: BRAND }} />Active</span>
            <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full" style={{ background: AMBER }} />Onboarding</span>
            <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-white/40" />Open market</span>
            <span className="ml-auto flex flex-wrap gap-1.5">
              <button type="button" aria-pressed={showPipeline} onClick={() => setShowPipeline((v) => !v)} className={toggle(showPipeline)}>
                Hot pipeline{data.prospects.length ? ` (${prospects.length}/${data.prospects.length})` : ""}
              </button>
              <button type="button" aria-pressed={showInactive} onClick={() => setShowInactive((v) => !v)} className={toggle(showInactive)}>Paused / churned</button>
            </span>
          </div>
          {/* isolate: Leaflet's z-indexes stay inside the map and under the sticky nav. */}
          <div className="dom-map relative isolate z-0">
            <div ref={mapEl} className="h-[58vh] min-h-80 w-full md:h-[520px]" role="application" aria-label="Map of client territories" />
            {loadError ? <p className="absolute inset-x-3 top-3 z-[1000] rounded bg-bad-bg px-3 py-2 text-sm text-bad">{loadError}</p> : null}
          </div>
        </div>

        <aside className="min-w-0 rounded-lg border border-line bg-panel">
          <h3 className="border-b border-line px-3 py-2 text-sm font-semibold">Top 10 open markets</h3>
          {stats ? (
            <ol className="divide-y divide-line">
              {stats.open.slice(0, 10).map((m, i) => (
                <li key={m.name}>
                  <button
                    type="button"
                    onClick={() => {
                      setQuery(m.name);
                      runCheck(m, m.name, m.name);
                    }}
                    className="flex w-full cursor-pointer items-baseline gap-2 px-3 py-2 text-left text-sm hover:bg-raised"
                  >
                    <span className="w-4 shrink-0 text-xs tabular-nums text-muted">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate" title={m.name}>{m.name}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted">{people(m.population)}</span>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="px-3 py-3 text-xs text-muted">Loading markets…</p>
          )}
        </aside>
      </div>

      {missing.length > 0 || (showPipeline && unplacedProspects.length > 0) ? (
        <div className="rounded-lg border border-line bg-panel px-3 py-2.5 text-sm">
          {missing.length > 0 ? (
            <>
              <div className="text-xs font-medium text-warn">Not on the map: no coordinates saved</div>
              <ul className="mt-1.5 flex flex-col gap-1.5">
                {missing.map((c) => <LocationRow key={c.id} name={`${c.name} · ${c.stage}`} initial={c.address ?? ""} placeholder="Street address, city, state ZIP" button="Re-geocode" disabled={!canEdit || fixing} onSave={(v) => fix(() => regeocodeClient(c.id, v || undefined))} />)}
              </ul>
            </>
          ) : null}
          {showPipeline && unplacedProspects.length > 0 ? (
            <>
              <div className={`text-xs font-medium text-muted ${missing.length ? "mt-3" : ""}`}>Hot pipeline with no location yet</div>
              <ul className="mt-1.5 flex flex-col gap-1.5">
                {unplacedProspects.map((p: MapProspect) => <LocationRow key={p.id} name={p.name} initial={place(p)} placeholder="City, ST" button="Place on map" disabled={!canEdit || fixing} onSave={(v) => fix(() => setProspectLocation(p.id, v))} />)}
              </ul>
            </>
          ) : null}
          {fixMessage ? <p className="mt-2 text-xs text-muted" role="status">{fixMessage}</p> : null}
          {!canEdit ? <p className="mt-2 text-xs text-muted">Only the owner can set locations.</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function LocationRow({ name, initial, placeholder, button, disabled, onSave }: { name: string; initial: string; placeholder: string; button: string; disabled: boolean; onSave: (value: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span className="w-full text-sm sm:w-56 sm:truncate" title={name}>{name}</span>
      <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} aria-label={`${name} location`} className="min-w-0 flex-1 rounded border border-line bg-raised px-2.5 py-1.5 text-sm" />
      <button type="button" disabled={disabled || !value.trim()} onClick={() => onSave(value.trim())} className="cursor-pointer rounded border border-line px-2.5 py-1.5 text-xs disabled:cursor-default disabled:opacity-50">{button}</button>
    </li>
  );
}
