/** Shown on pages whose phase has not shipped. States that plainly; shows no numbers. */
export function NotBuiltYet({ title, phase }: { title: string; phase: number }) {
  return (
    <div className="p-4">
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="mt-2 max-w-prose text-muted">
        Not built yet. This page ships in Phase {phase} (see PLAN.md). Nothing is shown here until it
        reads real data.
      </p>
    </div>
  );
}
