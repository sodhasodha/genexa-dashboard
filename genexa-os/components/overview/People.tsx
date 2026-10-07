import Link from "next/link";
import type { ClientPill, PersonCard } from "@/lib/queries/overview";

const PILL: Record<string, string> = { green: "bg-good-bg text-good", amber: "bg-warn-bg text-warn", red: "bg-bad-bg text-bad" };
const DOT: Record<string, string> = { green: "bg-good", amber: "bg-warn", red: "bg-bad" };
const SOURCE: Record<string, string> = { client_dashboard: "client dashboard", ghl: "GHL", whop: "Whop", cortana: "Cortana" };
const ROLE: Record<string, string> = { media_buyer: "Media buyer", tech: "Tech", csr: "CSR" };

export function PeopleCards({ people }: { people: PersonCard[] }) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold">People</h2>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {people.map((p) => (
          <div key={p.id} className="rounded-lg border border-line bg-panel p-3">
            <div className="flex items-center gap-2">
              <span className={`size-2.5 rounded-full ${p.colour ? DOT[p.colour] : "bg-stale"}`} title={p.colour ?? "no score yet"} />
              <span className="font-medium">{p.name}</span>
              <span className="text-xs text-muted">{ROLE[p.role] ?? p.role}{p.pod ? ` · ${p.pod.replace("pod_", "Pod ")}` : ""}</span>
              {p.status === "at_risk" ? <span className="ml-auto rounded bg-bad-bg px-1.5 py-0.5 text-xs text-bad">at risk</span> : null}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
              {p.metrics.length === 0 ? <span className="text-stale">no scores yet</span> : null}
              {p.metrics.map((m) => (
                <span key={m.label} className={`rounded px-1.5 py-0.5 ${m.colour ? PILL[m.colour] : "bg-stale-bg text-stale"}`}>{m.label} {m.value}</span>
              ))}
            </div>
            <div className="mt-2 truncate text-xs text-muted" title={p.oldest ?? undefined}>
              {p.openItems} open · {p.oldest ? `oldest: ${p.oldest}` : "nothing open"}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ClientsStrip({ clients }: { clients: ClientPill[] }) {
  const missing = clients[0]?.sources_missing ?? [];
  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold">Clients</h2>
      {missing.length > 0 ? (
        <p className="mb-2 text-xs text-muted">
          Health is based on the sources that have synced. Not yet counted: {missing.map((m) => SOURCE[m] ?? m).join(", ")}.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {clients.map((c) => {
          const live = c.stage === "live";
          const tone = live ? PILL[c.colour] : "bg-stale-bg text-stale";
          const notes = [live ? (c.reasons ?? "No issues found") : `Not live (${c.stage})`, live && !c.cortana_connected ? "Not connected to Cortana" : null].filter(Boolean).join(" · ");
          return (
            <Link key={c.client_id} href={`/clients/${c.client_id}`} title={notes} className={`rounded-full px-2.5 py-1 text-xs ${tone} ${live && !c.cortana_connected ? "outline-1 outline-dashed outline-muted" : ""}`}>
              {c.name}
              {live && !c.cortana_connected ? <span className="ml-1 opacity-70">· not connected</span> : null}
              {!live ? <span className="ml-1 opacity-70">· {c.stage}</span> : null}
            </Link>
          );
        })}
      </div>
    </section>
  );
}
