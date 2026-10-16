import "server-only";
import { createClient } from "@/lib/supabase/server";

// Data for the USA Domination map on the Clients page. Reads saved coordinates only:
// nothing here geocodes.

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export type MapStatus = "active" | "onboarding" | "inactive";
export type MapClient = {
  id: string;
  name: string;
  stage: string;
  status: MapStatus;
  address: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  launch_date: string | null;
  /** This ET month, from client_mtd (the same source as the clients table). Null = no data. */
  shows: number | null;
  closes: number | null;
  revenue: number | null;
};
export type MapProspect = { id: string; name: string; stage: string; city: string | null; state: string | null; lat: number | null; lng: number | null };
export type DominationData = { clients: MapClient[]; prospects: MapProspect[] };

const STATUS: Record<string, MapStatus> = { live: "active", onboarding: "onboarding", unlaunched: "onboarding", paused: "inactive", churned: "inactive" };

export async function getDominationData(): Promise<DominationData> {
  const supabase = await createClient();
  const [clients, mtd, prospects] = await Promise.all([
    supabase.from("clients").select("id, name, stage, address, city, state, lat, lng, launch_date").is("deleted_at", null).order("name"),
    supabase.from("client_mtd").select("client_id, shows, closes, revenue"),
    supabase.from("prospects").select("id, name, stage, city, state, lat, lng").is("deleted_at", null).eq("heat", "hot").neq("stage", "dead").order("name"),
  ]);
  for (const r of [clients, mtd, prospects]) if (r.error) throw new Error(`domination map: ${r.error.message}`);
  const month = new Map((mtd.data ?? []).map((m) => [m.client_id as string, m]));
  return {
    clients: (clients.data ?? []).map((c) => {
      const m = month.get(c.id);
      return {
        id: c.id, name: c.name, stage: c.stage, status: STATUS[c.stage] ?? "inactive",
        address: c.address, city: c.city, state: c.state, lat: n(c.lat), lng: n(c.lng), launch_date: c.launch_date,
        shows: m ? n(m.shows) : null, closes: m ? n(m.closes) : null, revenue: m ? n(m.revenue) : null,
      };
    }),
    prospects: (prospects.data ?? []).map((p) => ({ id: p.id, name: p.name, stage: p.stage, city: p.city, state: p.state, lat: n(p.lat), lng: n(p.lng) })),
  };
}
