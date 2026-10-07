import Link from "next/link";
import { formatValue } from "@/lib/format";
import type { Trajectory as Data } from "@/lib/queries/overview";
import { LineChart } from "./LineChart";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const compact = (v: number) => (v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${v}`);

export function Trajectory({ data }: { data: Data }) {
  const goal = data.target;
  const top = Math.max(goal ?? 0, ...data.months.map((m) => m.mrr ?? 0), ...data.cash.map((c) => c.total));
  const stepSize = top > 50_000 ? 25_000 : top > 10_000 ? 5_000 : 1_000;
  const ticks = Array.from({ length: Math.floor(top / stepSize) + 1 }, (_, i) => ({ value: i * stepSize, label: compact(i * stepSize) }));
  const goalLabel = goal !== null ? `Goal ${compact(goal)}/month${data.targetDate ? ` by ${MONTHS[Number(data.targetDate.slice(5, 7)) - 1]}` : ""}` : null;
  const recordedMonths = data.months.filter((m) => m.mrr !== null).length;
  return (
    <section className="rounded-lg border border-line bg-panel p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Trajectory</h2>
        <Link href="/drill/mrr" className="text-xs text-muted underline">View as table</Link>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-1 text-xs text-muted">Recurring MRR by month (Whop memberships)</h3>
          <LineChart
            ariaLabel="MRR by month against the goal"
            color="var(--color-series-1)"
            goal={goal}
            goalLabel={goalLabel}
            ticks={ticks}
            points={data.months.map((m) => ({
              label: `${MONTHS[Number(m.month.slice(5, 7)) - 1]}${m.month.endsWith("-01") ? ` ${m.month.slice(2, 4)}` : ""}`,
              value: m.mrr,
              display: formatValue(m.mrr, "money"),
              emphasised: m.current,
            }))}
          />
          <p className="mt-1 text-xs text-muted">
            {recordedMonths === 0
              ? "no data · Whop not connected yet"
              : "Month-end totals of renewing Whop memberships. Clients paying by one-off link count in the MRR tile but not here."}
          </p>
        </div>
        <div>
          <h3 className="mb-1 text-xs text-muted">Cash collected this month, cumulative</h3>
          {data.cashKnown ? (
            <LineChart
              ariaLabel="Cumulative cash collected this month against the goal"
              color="var(--color-series-2)"
              goal={goal}
              goalLabel={goalLabel}
              ticks={ticks}
              points={Array.from({ length: data.daysInMonth }, (_, i) => {
                const c = data.cash.find((x) => x.day === i + 1);
                return { label: String(i + 1), value: c ? c.total : null, display: c ? formatValue(c.total, "money") : null, emphasised: i + 1 === data.cash.length };
              })}
            />
          ) : (
            <div className="flex h-40 items-center justify-center rounded border border-dashed border-line text-sm text-stale">
              no data · Whop not connected yet
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
