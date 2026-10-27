import Image from "next/image";
import Link from "next/link";
import { DeskTable } from "@/components/confirmations/DeskTable";
import { DeskFilters } from "@/components/confirmations/DeskFilters";
import { requireDeskUser } from "@/lib/auth/staff";
import { getDesk, matchesStatus, parseDeskFilters, STATUS_FILTERS } from "@/lib/queries/confirmations";

export const dynamic = "force-dynamic";

/**
 * The CSR confirmation desk. The only page a CSR can open: no sidebar, no links
 * out, just the desk and a way to log out. The owner sees it too, with a way back.
 */
export default async function ConfirmationsPage({ searchParams }: PageProps<"/confirmations">) {
  const me = await requireDeskUser();
  const filters = parseDeskFilters(await searchParams);
  const { rows, clinics } = await getDesk();
  const inClinics = filters.clinics.length ? rows.filter((r) => filters.clinics.includes(r.client_id)) : rows;
  const shown = inClinics.filter((r) => matchesStatus(r, filters.status));
  // The summary follows the clinic filter, and the status filter where it narrows things.
  const base = filters.status === "all" || filters.status === "needs_action" ? inClinics : shown;
  const summary = {
    total: base.length,
    confirmed: base.filter((r) => r.status === "confirmed").length,
    unconfirmed: base.filter((r) => r.status === "unconfirmed" || r.status === "unreachable").length,
    red: base.filter((r) => r.urgency === "red").length,
  };

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-line bg-panel px-4 py-2.5">
        <Image src="/logo.png" alt="" width={24} height={24} className="rounded-md" />
        <span className="font-semibold">Confirmations</span>
        <span className="text-xs text-muted">Unconfirmed calendars · 34h to 3h before each appointment · updates every 5 minutes</span>
        <div className="ml-auto flex items-center gap-3 text-sm">
          {me.role === "owner" ? <Link href="/overview" className="text-muted hover:text-ink">← Genexa OS</Link> : null}
          <span className="text-muted">{me.name}</span>
          <form action="/auth/signout" method="post">
            <button type="submit" className="cursor-pointer rounded border border-line px-2.5 py-1 text-xs hover:border-muted">Log out</button>
          </form>
        </div>
      </header>

      <main className="flex flex-col gap-3 p-4">
        <DeskFilters clinics={clinics} selected={filters.clinics} status={filters.status} statuses={STATUS_FILTERS} />
        <div className="flex flex-wrap gap-2 text-sm">
          {[
            { label: "In window", value: summary.total, tone: "text-ink" },
            { label: "Confirmed", value: summary.confirmed, tone: "text-good" },
            { label: "Unconfirmed", value: summary.unconfirmed, tone: "text-warn" },
            { label: "Under 12h, not confirmed", value: summary.red, tone: "text-bad" },
          ].map((t) => (
            <div key={t.label} className="rounded-md border border-line bg-panel px-3 py-1.5">
              <span className="text-xs text-muted">{t.label}</span> <span className={`ml-1 font-semibold tabular-nums ${t.tone}`}>{t.value}</span>
            </div>
          ))}
        </div>
        <DeskTable rows={shown} />
      </main>
    </div>
  );
}
