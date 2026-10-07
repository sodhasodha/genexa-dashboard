import Link from "next/link";
import { notFound } from "next/navigation";
import { DataTable } from "@/components/DataTable";
import { PeriodControls } from "@/components/overview/Controls";
import { requireStaff } from "@/lib/auth/staff";
import { parsePeriod, resolvePeriod } from "@/lib/periods";
import { getDrill } from "@/lib/queries/drill";
import { etToday } from "@/lib/time";

export default async function DrillPage({ params, searchParams }: PageProps<"/drill/[metric]">) {
  await requireStaff();
  const { metric } = await params;
  const period = resolvePeriod(parsePeriod((await searchParams).period), etToday());
  const table = await getDrill(metric, period);
  if (!table) notFound();
  return (
    <div className="flex flex-col gap-3 p-4">
      <Link href={`/overview?period=${period.key}`} className="text-xs text-muted underline">← Overview</Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">{table.title}</h1>
        <PeriodControls active={period.key} basePath={`/drill/${metric}`} />
      </div>
      {table.total ? <p className="text-sm">Total: <span className="font-semibold">{table.total}</span> · {table.rows.length} rows</p> : <p className="text-sm text-muted">{table.rows.length} rows</p>}
      {table.note ? <p className="text-xs text-muted">{table.note}</p> : null}
      <DataTable columns={table.columns} rows={table.rows} />
    </div>
  );
}
