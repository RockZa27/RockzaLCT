import { WIRING_PATTERNS, isWiringPattern, type LayoutPortLoad, type PortChain, type WiringPattern } from '@rockzalct/shared';
import type { I18n } from '../../i18n/I18nProvider';
import { portColor } from './helpers';

interface Props {
  portCount: number;
  ports: readonly PortChain[];
  loads: readonly LayoutPortLoad[];
  capacity: number;
  activePort: number;
  t: I18n['t'];
  onSelect(port: number): void;
  onPattern(port: number, pattern: WiringPattern): void;
  onClear(port: number): void;
}

/** One row per output port: select it for manual wiring, re-wire it with a pattern, see its load. */
export function PortPanel({ portCount, ports, loads, capacity, activePort, t, onSelect, onPattern, onClear }: Props) {
  return (
    <ul className="layout-ports" aria-label={t('layout.ports')}>
      {Array.from({ length: portCount }, (_, port) => {
        const chain = ports.find((p) => p.port === port);
        const load = loads.find((l) => l.port === port);
        const pixels = load?.pixels ?? 0;
        const ratio = capacity > 0 ? pixels / capacity : 0;
        const n = port + 1;
        const over = ratio > 1;
        return (
          <li key={port} className={'layout-port' + (port === activePort ? ' active' : '')} data-port={port}>
            <button
              type="button"
              className="layout-port-select"
              aria-pressed={port === activePort}
              aria-label={t('layout.port.select', { n })}
              onClick={() => onSelect(port)}
            >
              <span className="layout-swatch" style={{ background: portColor(port) }} aria-hidden="true" />
              {t('layout.port', { n })}
            </button>
            <span className="muted layout-port-count">{t('layout.port.cabinets', { n: chain?.cabinets.length ?? 0 })}</span>
            <div
              className={'layout-bar' + (over ? ' over' : '')}
              role="progressbar"
              aria-label={t('layout.port.load', { n, pixels, capacity })}
              aria-valuemin={0}
              aria-valuemax={capacity}
              aria-valuenow={pixels}
            >
              <div
                className="layout-bar-fill"
                style={{ width: `${Math.min(100, ratio * 100)}%`, background: over ? 'var(--err)' : portColor(port) }}
              />
            </div>
            <span className={'layout-pct' + (over ? ' over' : '')}>{Math.round(ratio * 100)}%</span>
            <select
              aria-label={t('layout.port.pattern', { n })}
              value=""
              onChange={(e) => {
                if (isWiringPattern(e.target.value)) onPattern(port, e.target.value);
              }}
            >
              <option value="">{t('layout.port.patternPlaceholder')}</option>
              {WIRING_PATTERNS.map((p) => (
                <option key={p} value={p}>
                  {t(`layout.pattern.${p}`)}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-label={t('layout.port.clear', { n })}
              disabled={!chain || chain.cabinets.length === 0}
              onClick={() => onClear(port)}
            >
              ×
            </button>
          </li>
        );
      })}
    </ul>
  );
}
