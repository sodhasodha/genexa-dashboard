import Link from "next/link";
import { z } from "zod";
import { AccountsTable } from "@/components/media/AccountsTable";
import { AdExceptions } from "@/components/media/AdExceptions";
import { AdsTable } from "@/components/media/AdsTable";
import { ClinicDaily } from "@/components/media/ClinicDaily";
import { Scorecards } from "@/components/media/Scorecard";
import { requireStaff } from "@/lib/auth/staff";
import { AD_PAGE_SIZE, WINDOWS, getAccounts, getAdExceptions, getAds, getClinicDaily, getNotConnected, getScorecards, getThresholds, parseWindow } from "@/lib/queries/media";
import { etToday } from "@/lib/time";

export default async function MediaBuyingPage({ searchParams }: PageProps<"/media-buying">) {
  const me = await requireStaff();
  const params = await searchParams;
  const today = etToday();
  const windowKey = parseWindow(params.window);
  const windowLabel = WINDOWS.find((w) => w.key === windowKey)?.label ?? "";
  const clientParam = z.uuid().safeParse(params.client);
  const adPeriod = windowKey === "all" ? "all" : "7d";

  const [accounts, notConnected, exceptions, scorecards, thresholds] = await Promise.all([
    getAccounts(windowKey), getNotConnected(), getAdExceptions(), getScorecards(today), getThresholds(),
  ]);
  // Only a clinic on the accounts list can be opened.
  const clinic = clientParam.success ? (accounts.find((a) => a.client_id === clientParam.data) ?? null) : null;
  // Per-ad table: active ads by default, 50 a page.
  const allAds = params.ads === "all";
  const adPage = Number(typeof params.adpage === "string" ? params.adpage : "1") || 1;
  const [adList, daily] = await Promise.all([
    clinic && (clinic.campaign_scoped || clinic.unverified)
      ? Promise.resolve({ rows: [], total: 0, page: 1, pages: 1 })
      : getAds(clinic?.client_id ?? null, adPeriod, { activeOnly: !allAds, page: adPage }),
    clinic ? getClinicDaily(clinic.client_id, windowKey, today) : Promise.resolve(null),
  ]);

  const ads = adList.rows;
  const href = (w: string, client: string | null, hash = "") => `/media-buying?window=${w}${client ? `&client=${client}` : ""}${hash}`;
  const adsHref = (all: boolean, page: number) => `/media-buying?window=${windowKey}${clinic ? `&client=${clinic.client_id}` : ""}${all ? "&ads=all" : ""}${page > 1 ? `&adpage=${page}` : ""}#ads`;
  const range = accounts.find((a) => !a.unverified && a.window_from && a.window_to);
  const adsUnavailable = !clinic ? null
    : clinic.unverified ? "Unverified: this clinic's ads are left out until its Cortana business is confirmed."
    : clinic.campaign_scoped ? "Ad-level data not available for this clinic. Its numbers are limited to campaigns by name, and Cortana's ad rows carry no campaign."
    : null;

  return (
    <div className="flex flex-col gap-5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Media Buying</h1>
          <p className="text-xs text-muted">
            {windowKey === "all" ? "Everything loaded from Cortana" : `Last ${windowLabel.toLowerCase()}, complete days only${range ? ` · ${range.window_from} to ${range.window_to} (ET)` : ""}`}
          </p>
        </div>
        <div className="flex overflow-hidden rounded-md border border-line">
          {WINDOWS.map((w) => (
            <Link
              key={w.key} href={href(w.key, clinic?.client_id ?? null)}
              className={`px-3 py-1.5 text-xs ${w.key === windowKey ? "bg-accent font-medium text-white" : "bg-panel text-muted hover:text-ink"}`}
            >
              {w.label}
            </Link>
          ))}
        </div>
      </div>

      <AdExceptions exceptions={exceptions} meId={me.id} isOwner={me.role === "owner"} slaNote={thresholds.media_exception_sla_hours ?? null} />
      <Scorecards cards={scorecards} />
      <AccountsTable
        rows={accounts} notConnected={notConnected} thresholds={thresholds} selected={clinic?.client_id ?? null}
        clinicHref={(id) => href(windowKey, id, "#daily")}
      />

      {clinic && daily ? (
        <ClinicDaily name={clinic.name} windowLabel={windowLabel} daily={daily} closeHref={href(windowKey, null)} unverified={clinic.unverified} />
      ) : null}

      <form action="/media-buying" className="flex flex-wrap items-center gap-2 text-xs">
        <input type="hidden" name="window" value={windowKey} />
        <label htmlFor="client" className="text-muted">Ads for</label>
        <select id="client" name="client" defaultValue={clinic?.client_id ?? ""} className="rounded border border-line px-1.5 py-1">
          <option value="">All clinics</option>
          {accounts.map((a) => <option key={a.client_id} value={a.client_id}>{a.name}</option>)}
        </select>
        <button className="cursor-pointer rounded border border-line bg-raised px-2 py-1 hover:border-muted">Show</button>
      </form>
      <div id="ads" className="flex flex-wrap items-center gap-3 text-xs">
        <div className="flex overflow-hidden rounded-md border border-line">
          <Link href={adsHref(false, 1)} className={`px-3 py-1.5 ${!allAds ? "bg-accent font-medium text-white" : "bg-panel text-muted hover:text-ink"}`}>Active ads</Link>
          <Link href={adsHref(true, 1)} className={`px-3 py-1.5 ${allAds ? "bg-accent font-medium text-white" : "bg-panel text-muted hover:text-ink"}`}>All ads</Link>
        </div>
        <span className="text-muted">
          {adList.total === 0 ? "No ads" : `Ads ${(adList.page - 1) * AD_PAGE_SIZE + 1}–${Math.min(adList.page * AD_PAGE_SIZE, adList.total)} of ${adList.total}`}
        </span>
        {adList.page > 1 ? <Link href={adsHref(allAds, adList.page - 1)} className="rounded border border-line bg-raised px-2 py-1 hover:border-muted">← Previous</Link> : null}
        {adList.page < adList.pages ? <Link href={adsHref(allAds, adList.page + 1)} className="rounded border border-line bg-raised px-2 py-1 hover:border-muted">Next →</Link> : null}
      </div>
      <AdsTable
        rows={ads} periodLabel={adPeriod === "all" ? "all time" : windowKey === "3d" ? "7 days (Cortana has no 3-day ad figures)" : "7 days"}
        thresholds={thresholds} showClinic={!clinic} unavailable={adsUnavailable}
        scopedNames={clinic ? [] : accounts.filter((a) => a.campaign_scoped && !a.unverified).map((a) => a.name)}
        truncatedAt={null}
      />
    </div>
  );
}
