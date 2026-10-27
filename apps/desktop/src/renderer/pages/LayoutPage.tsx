import { useEffect, useMemo, useState } from 'react';
import {
  LAYOUT_DEFAULT_PORT_CAPACITY,
  LAYOUT_MAX_COORD,
  WIRING_PATTERNS,
  appendCabinet,
  autoWire,
  autoWireByCapacity,
  cabinetSize,
  clearLayoutPort,
  computeCardPlacements,
  computeLayoutPortLoads,
  createLayoutScreen,
  findCabinetPort,
  inferLayout,
  isComplexLayoutScreen,
  isWiringPattern,
  layoutHasErrors,
  layoutScreenBounds,
  planLayoutWrite,
  pruneChains,
  resizeLayoutScreen,
  rewireChain,
  setCabinetSize,
  toggleCabinet,
  validateLayout,
  type CabinetRef,
  type LayoutModel,
  type LayoutScreen,
  type LayoutSplitAxis,
  type PortChain,
  type WiringPattern,
} from '@rockzalct/shared';
import { useI18n } from '../i18n/I18nProvider';
import { useApp } from '../state/AppContext';
import { issueText } from './layout/helpers';
import { LAYOUT_CSS } from './layout/layoutStyles';
import { NumberField } from './layout/NumberField';
import { PortPanel } from './layout/PortPanel';
import { ScreenCanvas, type CanvasTool } from './layout/ScreenCanvas';

const MAX_GRID = 200;
const DEFAULT_PORTS = 4;

const initialScreen = (): LayoutScreen => createLayoutScreen(2, 4, 128, 128);

export function LayoutPage() {
  const { t } = useI18n();
  const { api, connectedId, info, level, run, pushInfo, pendingLayout, setPendingLayout } = useApp();
  const connected = connectedId !== null;
  const advanced = level === 'advanced';

  const [screen, setScreen] = useState<LayoutScreen>(initialScreen);
  const [ports, setPorts] = useState<PortChain[]>(() =>
    autoWire(initialScreen(), { pattern: 'left-top-horizontal', ports: 2, split: 'rows' }),
  );
  const [capacity, setCapacity] = useState(LAYOUT_DEFAULT_PORT_CAPACITY);
  const [activePort, setActivePort] = useState(0);
  const [tool, setTool] = useState<CanvasTool>('wire');
  const [selected, setSelected] = useState<CabinetRef | null>(null);
  const [sizeDraft, setSizeDraft] = useState({ width: 0, height: 0 });
  const [autoPattern, setAutoPattern] = useState<WiringPattern>('left-top-horizontal');
  const [autoPorts, setAutoPorts] = useState(2);
  const [autoSplit, setAutoSplit] = useState<LayoutSplitAxis>('rows');
  const [busy, setBusy] = useState<'read' | 'send' | 'numbers' | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [numbersShown, setNumbersShown] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // A layout handed over by the .scr import replaces the working layout (nothing is written until Send).
  useEffect(() => {
    if (!pendingLayout) return;
    setScreen(pendingLayout.screen);
    setPorts(pendingLayout.ports);
    setActivePort(0);
    setSelected(null);
    setNotice(null);
    setPendingLayout(null);
  }, [pendingLayout, setPendingLayout]);

  // A different (or no) controller invalidates what we know about the wall.
  useEffect(() => {
    setNumbersShown(false);
    setNotice(null);
  }, [connectedId]);

  const hwPorts = info?.outputPorts ?? DEFAULT_PORTS;
  const usedMax = ports.reduce((m, p) => Math.max(m, p.port), -1);
  const portCount = Math.max(1, hwPorts, usedMax + 1);

  const model = useMemo<LayoutModel>(() => ({ screen, ports }), [screen, ports]);
  const issues = useMemo(
    () => validateLayout(model, { portCapacity: capacity, ...(info ? { maxPorts: info.outputPorts } : {}) }),
    [model, capacity, info],
  );
  const placements = useMemo(() => computeCardPlacements(model), [model]);
  const loads = useMemo(() => computeLayoutPortLoads(model, capacity), [model, capacity]);
  const bounds = layoutScreenBounds(screen);
  const errorFree = !layoutHasErrors(issues);

  const updateScreen = (next: LayoutScreen): void => {
    setScreen(next);
    setPorts((p) => pruneChains(next, p));
    setSelected((s) => (s && s.row < next.rows && s.col < next.cols ? s : null));
  };

  const onCabinet = (ref: CabinetRef, via: 'click' | 'drag'): void => {
    if (tool === 'size') {
      if (via !== 'click') return;
      const s = cabinetSize(screen, ref.row, ref.col);
      setSelected(ref);
      setSizeDraft(s);
      return;
    }
    if (via === 'drag') {
      // painting only ever extends the active chain
      if (findCabinetPort(ports, ref)?.port !== activePort) setPorts((p) => appendCabinet(p, activePort, ref));
      return;
    }
    setPorts((p) => toggleCabinet(p, activePort, ref));
  };

  const applyPattern = (port: number, pattern: WiringPattern): void => {
    const chain = ports.find((p) => p.port === port);
    if (!chain || chain.cabinets.length === 0) return;
    const source = chain.cabinets;
    const next = rewireChain(pattern, source);
    if (!next) {
      setNotice(t('layout.port.notRect', { n: port + 1 }));
      return;
    }
    setNotice(null);
    setPorts((p) => p.map((c) => (c.port === port ? { ...c, cabinets: next } : c)));
  };

  const doAutoWire = (byCapacity: boolean): void => {
    setNotice(null);
    const wired = byCapacity
      ? autoWireByCapacity(screen, { pattern: autoPattern, capacity, split: autoSplit })
      : autoWire(screen, { pattern: autoPattern, ports: Math.min(autoPorts, portCount), split: autoSplit });
    setPorts(wired);
    setActivePort(0);
  };

  const readFromHardware = async (): Promise<void> => {
    if (!connectedId) return;
    setBusy('read');
    setNotice(null);
    try {
      const hw = await run(() => api.readLayout(connectedId));
      if (!hw) return;
      const result = inferLayout(hw);
      const messages: string[] = [];
      for (const i of result.issues) {
        if (i.code === 'no-cards') messages.push(t('layout.read.none'));
        else if (i.code === 'not-a-grid') messages.push(t('layout.read.notGrid'));
        else messages.push(t('layout.read.unsized', { count: i.params?.count ?? 0 }));
      }
      setNotice(messages.length > 0 ? messages.join(' ') : null);
      if (result.model) {
        setScreen(result.model.screen);
        setPorts(result.model.ports);
        setSelected(null);
        pushInfo(t('layout.read.done'));
      }
    } finally {
      setBusy(null);
    }
  };

  const sendToHardware = async (): Promise<void> => {
    if (!connectedId) return;
    setConfirmOpen(false);
    setBusy('send');
    try {
      const result = await run(() => api.writeLayout(connectedId, model, { portCapacity: capacity }));
      if (result) pushInfo(t('layout.sent', { ports: result.portsWritten, cards: result.cardsWritten }));
    } finally {
      setBusy(null);
    }
  };

  const toggleNumbers = async (): Promise<void> => {
    if (!connectedId) return;
    const next = !numbersShown;
    setBusy('numbers');
    try {
      const ok = await run(async () => {
        await api.showCabinetNumbers(connectedId, model, next);
        return true;
      });
      if (ok) {
        setNumbersShown(next);
        pushInfo(t(next ? 'layout.numbers.shown' : 'layout.numbers.hidden'));
      }
    } finally {
      setBusy(null);
    }
  };

  const sendDisabled = !connected || !advanced || !errorFree || busy !== null;
  const sendHint = !advanced ? t('layout.send.locked') : !errorFree ? t('layout.send.invalid') : null;
  const plan = planLayoutWrite(model);
  const sizeDefault = selected ? cabinetSize({ ...screen, overrides: [] }, selected.row, selected.col) : null;

  return (
    <section>
      <style>{LAYOUT_CSS}</style>
      <h1>{t('layout.title')}</h1>
      {!connected && <p className="muted">{t('layout.needConnect')}</p>}

      <div className="card layout-wide">
        <h2>{t('layout.hw')}</h2>
        <div className="layout-toolbar">
          <button type="button" disabled={!connected || busy !== null} onClick={() => void readFromHardware()}>
            {busy === 'read' ? t('layout.reading') : t('layout.read')}
          </button>
          <button type="button" className="primary" disabled={sendDisabled} onClick={() => setConfirmOpen(true)}>
            {busy === 'send' ? t('layout.sending') : t('layout.send')}
          </button>
          <button
            type="button"
            aria-pressed={numbersShown}
            disabled={!connected || !advanced || !errorFree || busy !== null}
            onClick={() => void toggleNumbers()}
          >
            {t(numbersShown ? 'layout.hideNumbers' : 'layout.showNumbers')}
          </button>
          {connected && sendHint && <span className="muted">{sendHint}</span>}
        </div>
        {numbersShown && <p className="layout-notice">{t('layout.numbersOn')}</p>}
        {notice && (
          <p className="layout-notice" role="status">
            {notice}
          </p>
        )}
      </div>

      <div className="layout-grid">
        <div>
          <div className="card layout-wide">
            <div className="layout-toolbar" role="group" aria-label={t('layout.tool')} style={{ marginBottom: 8 }}>
              {(['wire', 'size'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={'choice' + (tool === k ? ' selected' : '')}
                  aria-pressed={tool === k}
                  onClick={() => setTool(k)}
                >
                  {t(`layout.tool.${k}`)}
                </button>
              ))}
              <span className="muted">{t('layout.totalSize', { w: bounds.width, h: bounds.height, n: screen.rows * screen.cols })}</span>
            </div>
            <p className="muted" style={{ marginTop: 0 }}>
              {t(tool === 'wire' ? 'layout.hint.wire' : 'layout.hint.size')}
            </p>
            <ScreenCanvas
              screen={screen}
              ports={ports}
              placements={placements}
              tool={tool}
              selected={tool === 'size' ? selected : null}
              t={t}
              onCabinet={onCabinet}
            />
            {tool === 'size' && selected && (
              <div className="layout-toolbar" style={{ marginTop: 10 }}>
                <strong>{t('layout.selected', { row: selected.row + 1, col: selected.col + 1 })}</strong>
                <NumberField label={t('layout.cabW')} value={sizeDraft.width} min={1} max={LAYOUT_MAX_COORD} onCommit={(n) => setSizeDraft((d) => ({ ...d, width: n }))} />
                <NumberField label={t('layout.cabH')} value={sizeDraft.height} min={1} max={LAYOUT_MAX_COORD} onCommit={(n) => setSizeDraft((d) => ({ ...d, height: n }))} />
                <button
                  type="button"
                  className="primary"
                  onClick={() => updateScreen(setCabinetSize(screen, selected.row, selected.col, sizeDraft.width, sizeDraft.height))}
                >
                  {t('layout.applySize')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!sizeDefault) return;
                    setSizeDraft(sizeDefault);
                    updateScreen(setCabinetSize(screen, selected.row, selected.col, sizeDefault.width, sizeDefault.height));
                  }}
                >
                  {t('layout.resetSize')}
                </button>
              </div>
            )}
          </div>

          <div className="card layout-wide layout-card">
            <h2>{t('layout.validation')}</h2>
            {issues.length === 0 ? (
              <p className="layout-ok" role="status">
                {t('layout.valid')}
              </p>
            ) : (
              <ul className="layout-issues" aria-live="polite">
                {issues.slice(0, 30).map((issue, i) => (
                  <li key={i} className={'layout-issue ' + issue.severity}>
                    <strong>{t(issue.severity === 'error' ? 'layout.error' : 'layout.warning')}:</strong> {issueText(t, issue)}
                  </li>
                ))}
                {issues.length > 30 && <li className="muted">… +{issues.length - 30}</li>}
              </ul>
            )}
          </div>
        </div>

        <div>
          <div className="card layout-wide layout-card">
            <h2>{t('layout.screen')}</h2>
            <div className="layout-fields">
              <NumberField label={t('layout.rows')} value={screen.rows} min={1} max={MAX_GRID} onCommit={(n) => updateScreen(resizeLayoutScreen(screen, { rows: n }))} />
              <NumberField label={t('layout.cols')} value={screen.cols} min={1} max={MAX_GRID} onCommit={(n) => updateScreen(resizeLayoutScreen(screen, { cols: n }))} />
              <NumberField label={t('layout.cabW')} value={screen.cabinetWidth} min={1} max={LAYOUT_MAX_COORD} onCommit={(n) => updateScreen(resizeLayoutScreen(screen, { cabinetWidth: n }))} />
              <NumberField label={t('layout.cabH')} value={screen.cabinetHeight} min={1} max={LAYOUT_MAX_COORD} onCommit={(n) => updateScreen(resizeLayoutScreen(screen, { cabinetHeight: n }))} />
              <label className="field">
                {t('layout.kind')}
                <select
                  value={isComplexLayoutScreen(screen) ? 'complex' : 'standard'}
                  onChange={(e) =>
                    updateScreen(
                      e.target.value === 'complex'
                        ? { ...screen, kind: 'complex' }
                        : { ...screen, kind: 'standard', overrides: [] },
                    )
                  }
                >
                  <option value="standard">{t('layout.kind.standard')}</option>
                  <option value="complex">{t('layout.kind.complex')}</option>
                </select>
              </label>
              <NumberField label={t('layout.capacity')} value={capacity} min={1} max={100_000_000} onCommit={setCapacity} />
            </div>
          </div>

          <div className="card layout-wide layout-card">
            <h2>{t('layout.auto')}</h2>
            <div className="layout-fields">
              <label className="field">
                {t('layout.auto.pattern')}
                <select
                  value={autoPattern}
                  onChange={(e) => {
                    if (isWiringPattern(e.target.value)) setAutoPattern(e.target.value);
                  }}
                >
                  {WIRING_PATTERNS.map((p) => (
                    <option key={p} value={p}>
                      {t(`layout.pattern.${p}`)}
                    </option>
                  ))}
                </select>
              </label>
              <NumberField label={t('layout.auto.ports')} value={Math.min(autoPorts, portCount)} min={1} max={portCount} onCommit={setAutoPorts} />
              <label className="field">
                {t('layout.auto.split')}
                <select value={autoSplit} onChange={(e) => setAutoSplit(e.target.value === 'columns' ? 'columns' : 'rows')}>
                  <option value="rows">{t('layout.auto.rows')}</option>
                  <option value="columns">{t('layout.auto.columns')}</option>
                </select>
              </label>
            </div>
            <div className="row">
              <button type="button" className="primary" onClick={() => doAutoWire(false)}>
                {t('layout.auto.apply')}
              </button>
              <button type="button" onClick={() => doAutoWire(true)}>
                {t('layout.auto.capacity')}
              </button>
              <button type="button" onClick={() => setPorts([])}>
                {t('layout.auto.clear')}
              </button>
            </div>
          </div>

          <div className="card layout-wide layout-card">
            <h2>{t('layout.ports')}</h2>
            <PortPanel
              portCount={portCount}
              ports={ports}
              loads={loads}
              capacity={capacity}
              activePort={activePort}
              t={t}
              onSelect={setActivePort}
              onPattern={applyPattern}
              onClear={(port) => setPorts((p) => clearLayoutPort(p, port))}
            />
          </div>
        </div>
      </div>

      {confirmOpen && (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-label={t('layout.confirm.title')}>
            <h2>{t('layout.confirm.title')}</h2>
            <p style={{ margin: 0 }}>{t('layout.confirm.body', { cards: plan.cards.length, ports: plan.ports.length })}</p>
            <div className="row end">
              <button type="button" onClick={() => setConfirmOpen(false)}>
                {t('layout.confirm.cancel')}
              </button>
              <button type="button" className="primary" onClick={() => void sendToHardware()}>
                {t('layout.confirm.send')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
