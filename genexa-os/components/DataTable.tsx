/** Plain dense table. Null cells render as "no data". */
export function DataTable({ columns, rows }: { columns: string[]; rows: (string | null)[][] }) {
  if (rows.length === 0) return <p className="rounded border border-line bg-panel px-4 py-6 text-sm text-muted">No rows.</p>;
  return (
    <div className="overflow-x-auto rounded border border-line bg-panel">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-line text-xs text-muted">
          <tr>{columns.map((c) => <th key={c} className="whitespace-nowrap px-3 py-2 font-normal">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line last:border-0">
              {r.map((cell, j) => (
                <td key={j} className="whitespace-nowrap px-3 py-1.5 tabular-nums">{cell ?? <span className="text-stale">no data</span>}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
