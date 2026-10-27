import type { TrendPoint } from '@rockzalct/shared';

const W = 360;
const H = 110;
const PAD = { left: 34, right: 10, top: 10, bottom: 18 };

/**
 * Small inline-SVG line chart of raw values over time. A null value (card offline / invalid
 * reading) leaves a gap in the line. Needs at least two points to draw a line.
 */
export function TrendChart({ points, label }: { points: readonly TrendPoint[]; label: string }) {
  const known = points.filter((p): p is { at: number; value: number } => p.value !== null);
  const values = known.map((p) => p.value);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  // Keep a visible span so a flat line does not fill the chart.
  const span = Math.max(max - min, 4);
  const lo = min - (span - (max - min)) / 2;
  const hi = lo + span;

  const t0 = points.length ? points[0]!.at : 0;
  const t1 = points.length ? points[points.length - 1]!.at : 1;
  const x = (at: number): number =>
    PAD.left + (t1 === t0 ? 0 : ((at - t0) / (t1 - t0)) * (W - PAD.left - PAD.right));
  const y = (v: number): number => PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);

  // Split into runs of consecutive known points.
  const runs: Array<Array<{ at: number; value: number }>> = [];
  let current: Array<{ at: number; value: number }> = [];
  for (const p of points) {
    if (p.value === null) {
      if (current.length) runs.push(current);
      current = [];
    } else {
      current.push({ at: p.at, value: p.value });
    }
  }
  if (current.length) runs.push(current);

  const last = known[known.length - 1];
  return (
    <svg
      className="mon-trend"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={label}
      data-testid="trend-chart"
      data-points={known.length}
    >
      <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={H - PAD.bottom} className="mon-axis" />
      <line x1={PAD.left} y1={H - PAD.bottom} x2={W - PAD.right} y2={H - PAD.bottom} className="mon-axis" />
      {known.length > 0 && (
        <>
          <text x={PAD.left - 4} y={PAD.top + 4} textAnchor="end" className="mon-tick">
            {Math.round(hi)}
          </text>
          <text x={PAD.left - 4} y={H - PAD.bottom} textAnchor="end" className="mon-tick">
            {Math.round(lo)}
          </text>
        </>
      )}
      {runs.map((run, i) =>
        run.length > 1 ? (
          <polyline
            key={i}
            className="mon-line"
            fill="none"
            points={run.map((p) => `${x(p.at).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')}
          />
        ) : null,
      )}
      {last && <circle cx={x(last.at)} cy={y(last.value)} r={3} className="mon-dot" />}
    </svg>
  );
}
