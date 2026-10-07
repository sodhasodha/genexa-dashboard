import { PeriodControls } from "@/components/overview/Controls";
import { NeedsAction } from "@/components/overview/NeedsAction";
import { ClientsStrip, PeopleCards } from "@/components/overview/People";
import { Tile } from "@/components/overview/Tile";
import { Trajectory } from "@/components/overview/Trajectory";
import { requireStaff } from "@/lib/auth/staff";
import { parsePeriod, resolvePeriod } from "@/lib/periods";
import { REVIEW_KINDS, getBottlenecks, getClientOptions, getClientsStrip, getOverview, getPeople, getReview, getTrajectory, type ReviewKind } from "@/lib/queries/overview";
import { etToday } from "@/lib/time";

export default async function OverviewPage({ searchParams }: PageProps<"/overview">) {
  const me = await requireStaff();
  const params = await searchParams;
  const today = etToday();
  const period = resolvePeriod(parsePeriod(params.period), today);
  const [overview, bottlenecks, review, clients, people, strip] = await Promise.all([
    getOverview(period), getBottlenecks(), getReview(), getClientOptions(), getPeople(), getClientsStrip(),
  ]);
  const trajectory = await getTrajectory(today, overview.mrrTarget);
  const queue = (REVIEW_KINDS.find((k) => k.kind === params.queue)?.kind ?? REVIEW_KINDS.find((k) => review.counts[k.kind] > 0)?.kind ?? "anomaly") as ReviewKind;
  const panel = params.panel === "review" ? "review" : "bottlenecks";

  return (
    <div className="flex flex-col gap-5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Command Centre</h1>
          <p className="text-xs text-muted">{period.label} · {period.from === period.to ? period.from : `${period.from} to ${period.to}`} (ET) · compared with {period.prevLabel}</p>
        </div>
        <PeriodControls active={period.key} basePath="/overview" />
      </div>

      <NeedsAction
        bottlenecks={bottlenecks.rows} atRisk={bottlenecks.atRisk} counts={review.counts} items={review.items} clients={clients}
        panel={panel} queue={queue} isOwner={me.role === "owner"} basePath="/overview" periodKey={period.key}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {overview.money.map((t) => <Tile key={t.key} tile={t} prevLabel={period.prevLabel} large />)}
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {overview.profit.map((t) => <Tile key={t.key} tile={t} prevLabel={period.prevLabel} large />)}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        {overview.delivery.map((t) => <Tile key={t.key} tile={t} prevLabel={period.prevLabel} />)}
      </div>

      <Trajectory data={trajectory} />
      <PeopleCards people={people} />
      <ClientsStrip clients={strip} />
    </div>
  );
}
