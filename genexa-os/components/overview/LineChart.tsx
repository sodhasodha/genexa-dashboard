"use client";

import { useState } from "react";

export type ChartPoint = { label: string; value: number | null; display: string | null; emphasised?: boolean };

/**
 * One series against a goal line. Single axis, starting at zero. Geometry
 * only: every number and label arrives already computed and formatted.
 */
export function LineChart({
  points, goal, goalLabel, color, ariaLabel, ticks,
}: {
  points: ChartPoint[]; goal: number | null; goalLabel: string | null; color: string; ariaLabel: string;
  ticks: { value: number; label: string }[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 560, H = 220, L = 44, R = 16, T = 16, B = 26;
  const max = Math.max(goal ?? 0, ...points.map((p) => p.value ?? 0), 1) * 1.08;
  const x = (i: number) => L + (points.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (points.length - 1));
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const known = points.map((p, i) => ({ ...p, i })).filter((p) => p.value !== null);
  const path = known.map((p, k) => `${k === 0 ? "M" : "L"}${x(p.i).toFixed(1)},${y(p.value as number).toFixed(1)}`).join(" ");
  const last = known[known.length - 1];
  const step = points.length > 1 ? (W - L - R) / (points.length - 1) : W - L - R;
  const labelEvery = Math.ceil(points.length / 8);
  const h = hover !== null ? points[hover] : null;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={ariaLabel} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t.value}>
            <line x1={L} x2={W - R} y1={y(t.value)} y2={y(t.value)} stroke="var(--color-line)" strokeWidth="1" />
            <text x={L - 6} y={y(t.value) + 3} textAnchor="end" fontSize="10" fill="var(--color-muted)">{t.label}</text>
          </g>
        ))}
        {goal !== null ? (
          <g>
            <line x1={L} x2={W - R} y1={y(goal)} y2={y(goal)} stroke="var(--color-muted)" strokeWidth="1.5" strokeDasharray="5 4" />
            {goalLabel ? <text x={W - R} y={y(goal) - 5} textAnchor="end" fontSize="10" fill="var(--color-muted)">{goalLabel}</text> : null}
          </g>
        ) : null}
        {points.map((p, i) =>
          i % labelEvery === 0 || i === points.length - 1 ? (
            <text key={p.label} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill={p.emphasised ? "var(--color-ink)" : "var(--color-muted)"}>{p.label}</text>
          ) : null,
        )}
        {known.length > 1 ? <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /> : null}
        {known.map((p) =>
          known.length <= 12 || p.i === last.i || p.i === hover ? (
            <circle key={p.i} cx={x(p.i)} cy={y(p.value as number)} r={p.i === hover ? 5 : 4} fill={color} stroke="var(--color-panel)" strokeWidth="2" />
          ) : null,
        )}
        {last && hover === null ? (
          <text x={Math.min(x(last.i), W - R - 4)} y={y(last.value as number) - 10} textAnchor={x(last.i) > W - 80 ? "end" : "middle"} fontSize="11" fontWeight="600" fill="var(--color-ink)">
            {last.display}
          </text>
        ) : null}
        {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke="var(--color-muted)" strokeWidth="1" /> : null}
        {points.map((p, i) => (
          <rect key={p.label} x={x(i) - step / 2} y={T} width={step} height={H - T - B} fill="transparent" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0} aria-label={`${p.label}: ${p.display ?? "no data"}`} />
        ))}
      </svg>
      {h && hover !== null ? (
        <div
          className="pointer-events-none absolute top-1 rounded border border-line bg-raised px-2 py-1 text-xs shadow"
          style={{ left: `${(x(hover) / W) * 100}%`, transform: x(hover) > W * 0.7 ? "translateX(-105%)" : "translateX(8px)" }}
        >
          <div className="text-muted">{h.label}</div>
          <div className="font-semibold">{h.display ?? "no data"}</div>
        </div>
      ) : null}
    </div>
  );
}
