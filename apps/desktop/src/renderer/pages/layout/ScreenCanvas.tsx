import type { KeyboardEvent, PointerEvent } from 'react';
import {
  allCabinets,
  cabinetKey,
  cabinetRect,
  layoutScreenBounds,
  type CabinetRef,
  type LayoutCardPlacement,
  type LayoutScreen,
  type PortChain,
} from '@rockzalct/shared';
import type { I18n } from '../../i18n/I18nProvider';
import { portColor } from './helpers';

export type CanvasTool = 'wire' | 'size';

interface Props {
  screen: LayoutScreen;
  ports: readonly PortChain[];
  placements: readonly LayoutCardPlacement[];
  tool: CanvasTool;
  selected: CabinetRef | null;
  t: I18n['t'];
  /** `drag` fires while the primary button is held and the pointer enters another cabinet. */
  onCabinet(ref: CabinetRef, via: 'click' | 'drag'): void;
}

/** SVG drawing of the grid with one coloured, arrowed polyline per port chain. */
export function ScreenCanvas({ screen, ports, placements, tool, selected, t, onCabinet }: Props) {
  const bounds = layoutScreenBounds(screen);
  const w = Math.max(1, bounds.width);
  const h = Math.max(1, bounds.height);
  const unit = Math.min(screen.cabinetWidth, screen.cabinetHeight) || 1;
  const byKey = new Map(placements.map((p) => [cabinetKey(p), p]));
  const usedPorts = ports.filter((p) => p.cabinets.length > 0);

  const center = (c: CabinetRef): { x: number; y: number } => {
    const r = cabinetRect(screen, c.row, c.col);
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };

  const label = (c: CabinetRef): string => {
    const p = byKey.get(cabinetKey(c));
    return p
      ? t('layout.cabinet.assigned', { row: c.row + 1, col: c.col + 1, port: p.port + 1, number: p.cabinetNumber })
      : t('layout.cabinet', { row: c.row + 1, col: c.col + 1 });
  };

  return (
    <svg
      className="layout-canvas"
      role="group"
      aria-label={t('layout.canvas')}
      viewBox={`-${unit * 0.05} -${unit * 0.05} ${w + unit * 0.1} ${h + unit * 0.1}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ width: '100%', maxHeight: 520, touchAction: 'none', userSelect: 'none' }}
    >
      <defs>
        {usedPorts.map((p) => (
          <marker
            key={p.port}
            id={`layout-arrow-${p.port}`}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerUnits="userSpaceOnUse"
            markerWidth={unit * 0.22}
            markerHeight={unit * 0.22}
            orient="auto"
          >
            <path d="M0,0 L10,5 L0,10 z" fill={portColor(p.port)} />
          </marker>
        ))}
      </defs>

      {allCabinets(screen).map((c) => {
        const r = cabinetRect(screen, c.row, c.col);
        const p = byKey.get(cabinetKey(c));
        const isSelected = selected !== null && selected.row === c.row && selected.col === c.col;
        return (
          <g
            key={cabinetKey(c)}
            role="button"
            tabIndex={0}
            aria-label={label(c)}
            aria-pressed={tool === 'size' ? isSelected : undefined}
            data-row={c.row}
            data-col={c.col}
            style={{ cursor: 'pointer' }}
            onPointerDown={(e: PointerEvent) => {
              e.preventDefault();
              onCabinet(c, 'click');
            }}
            onPointerEnter={(e: PointerEvent) => {
              if (e.buttons === 1) onCabinet(c, 'drag');
            }}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onCabinet(c, 'click');
              }
            }}
          >
            <rect
              x={r.x}
              y={r.y}
              width={r.width}
              height={r.height}
              fill={p ? portColor(p.port) : '#2a3140'}
              fillOpacity={p ? 0.28 : 1}
              stroke={isSelected ? '#ffffff' : '#5b677c'}
              strokeWidth={unit * (isSelected ? 0.06 : 0.02)}
            />
            <text
              x={r.x + r.width / 2}
              y={r.y + r.height / 2}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={unit * 0.3}
              fill="#e8ecf3"
              pointerEvents="none"
            >
              {p ? p.cabinetNumber : '·'}
            </text>
          </g>
        );
      })}

      <g pointerEvents="none" data-testid="chains">
        {usedPorts.map((p) => {
          const color = portColor(p.port);
          const pts = p.cabinets.map(center);
          return (
            <g key={p.port} data-port={p.port}>
              {pts.slice(1).map((to, i) => {
                const from = pts[i]!;
                // stop short of the centre so the arrow head stays visible
                const dx = to.x - from.x;
                const dy = to.y - from.y;
                const len = Math.hypot(dx, dy) || 1;
                const shorten = Math.min(unit * 0.12, len / 3);
                return (
                  <line
                    key={i}
                    x1={from.x}
                    y1={from.y}
                    x2={to.x - (dx / len) * shorten}
                    y2={to.y - (dy / len) * shorten}
                    stroke={color}
                    strokeWidth={unit * 0.05}
                    strokeLinecap="round"
                    markerEnd={`url(#layout-arrow-${p.port})`}
                  />
                );
              })}
              <circle cx={pts[0]!.x} cy={pts[0]!.y} r={unit * 0.09} fill={color} stroke="#12151c" strokeWidth={unit * 0.02} />
            </g>
          );
        })}
      </g>
    </svg>
  );
}
