import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  autoCreate,
  buildFinalImage,
  clearMarks,
  collectMarking,
  emptyMarking,
  isInvalidCell,
  markCell,
  markInvalid,
  markingProgress,
  nextStep,
  planPixelMapping,
  undoMark,
  type CascadeDirection,
  type MarkRejection,
  type MarkingChange,
  type MarkingState,
  type PixelDisplay,
  type PixelMappingInputs,
  type PixelMappingPlan,
  type PixelMappingSnapshot,
  type PixelMappingFailure,
  type PixelMappingUndoStep,
  type SmartValues,
} from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';
import type { MessageKey } from '../../i18n/dictionary';
import { useApp } from '../../state/AppContext';
import type { PageId } from '../../components/Layout';
import { ConfirmDialog } from '../persist/ConfirmDialog';

/** Cells drawn at most; a bigger grid cannot be shown comfortably. */
const MAX_GRID_CELLS = 20000;
/** Cells with a number written in them. */
const MAX_NUMBERED_CELLS = 4000;
const SCAN_MAX = 64;

type Stage = 'setup' | 'marking' | 'undo-needed' | 'sent';
type Confirm = 'start' | 'send' | 'cancel';

const hex = (b: ArrayLike<number>): string => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join(' ');

export interface PixelMappingStepProps {
  card: { portIndex: number; cardIndex: number } | null;
  /** What the card holds now as far as the wizard knows (null = no snapshot yet). */
  applied: SmartValues | null;
  advanced: boolean;
  /** "Port 1 / Card 1" */
  targetText: string;
  /** Tells the page that the controller is owned by the wizard (other steps and writes must stay off). */
  onActiveChange(active: boolean): void;
  onNavigate?(page: PageId): void;
  onGoFinish(): void;
}

interface Form {
  moduleWidth: number;
  moduleHeight: number;
  scanCount: number;
  dataGroups: number;
  dataDirection: number;
  pointsPerDriver: string;
  modulesAcross: number;
  modulesDown: number;
  cascade: CascadeDirection;
  lineBias: number;
  display: number;
  originX: number;
  originY: number;
}

const formFrom = (v: SmartValues | null): Form => ({
  moduleWidth: v?.moduleWidth ?? 32,
  moduleHeight: v?.moduleHeight ?? 16,
  scanCount: Math.min(v?.scanMode ?? 8, SCAN_MAX),
  dataGroups: Math.min(Math.max(v?.dataGroups ?? 1, 1), 8),
  dataDirection: v?.dataDirection === 1 ? 1 : 0,
  pointsPerDriver: '',
  modulesAcross: 1,
  modulesDown: 1,
  cascade: 'horizontal',
  lineBias: 0,
  display: 0,
  originX: 0,
  originY: 0,
});

export function PixelMappingStep(props: PixelMappingStepProps) {
  const { card, applied, advanced, targetText, onActiveChange, onNavigate, onGoFinish } = props;
  const { t } = useI18n();
  const { api, connectedId, run, pushInfo } = useApp();

  const [form, setForm] = useState<Form>(() => formFrom(applied));
  const displayTouched = useRef(false);
  const [displays, setDisplays] = useState<PixelDisplay[]>([]);
  const [broadcast, setBroadcast] = useState(false);
  const [stage, setStage] = useState<Stage>('setup');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [frozen, setFrozen] = useState<{ plan: PixelMappingPlan; broadcast: boolean } | null>(null);
  const [marking, setMarking] = useState<MarkingState>(emptyMarking());
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [lit, setLit] = useState<{ x: number; y: number } | null>(null);
  const [litFailed, setLitFailed] = useState(false);
  const [rejection, setRejection] = useState<MarkRejection | null>(null);
  const [autoAdded, setAutoAdded] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<PixelMappingSnapshot | null>(null);
  const [failure, setFailure] = useState<{ written: string[]; failed?: PixelMappingFailure } | null>(null);
  const [undoSteps, setUndoSteps] = useState<PixelMappingUndoStep[] | null>(null);
  const [undone, setUndone] = useState(false);

  // ---- plan --------------------------------------------------------------------------------------

  const inputs: PixelMappingInputs = useMemo(() => {
    const m = form.pointsPerDriver.trim();
    return {
      moduleWidth: form.moduleWidth,
      moduleHeight: form.moduleHeight,
      scanCount: form.scanCount,
      dataGroups: form.dataGroups,
      dataDirection: form.dataDirection,
      modulesAcross: form.modulesAcross,
      modulesDown: form.modulesDown,
      cascade: form.cascade,
      lineBias: form.lineBias,
      ...(m !== '' ? { pointsPerDriver: Number(m) } : {}),
    };
  }, [form]);
  const planned = useMemo(() => planPixelMapping(inputs), [inputs]);
  // While the wizard runs, the plan the card was started with is the one that counts.
  const plan: PixelMappingPlan | null = frozen ? frozen.plan : planned.ok ? planned.plan : null;
  const gridCells = plan ? plan.grid.cols * plan.grid.rows : 0;

  // ---- lifecycle ---------------------------------------------------------------------------------

  const live = useRef({ active: false, id: connectedId });
  live.current = { active: stage === 'marking' || stage === 'undo-needed', id: connectedId };
  const apiRef = useRef(api);
  apiRef.current = api;
  const onActiveRef = useRef(onActiveChange);
  onActiveRef.current = onActiveChange;

  useEffect(() => {
    onActiveRef.current(stage === 'marking' || stage === 'undo-needed');
  }, [stage]);

  // Leaving the page while the wizard owns the controller undoes it (the card would stay in smart mode otherwise).
  useEffect(
    () => () => {
      const { active, id } = live.current;
      if (active && id) void Promise.resolve(apiRef.current.cancelPixelMapping(id)).catch(() => undefined);
      onActiveRef.current(false);
    },
    [],
  );

  // A different connection ends the wizard here (the old controller's hold is gone with its connection).
  useEffect(() => {
    setStage('setup');
    setFrozen(null);
    setMarking(emptyMarking());
    setFailure(null);
    setUndoSteps(null);
    setUndone(false);
    setConfirm(null);
  }, [connectedId]);

  useEffect(() => {
    if (!connectedId) {
      setDisplays([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const list = await run(() => api.listPixelDisplays(connectedId));
      if (cancelled || !list) return;
      setDisplays(list);
      // The sender is usually fed by a second display: offer that one first (the operator can change it).
      if (!displayTouched.current) setForm((f) => ({ ...f, display: (list.find((d) => !d.primary) ?? list[0])?.index ?? 0 }));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedId, api]);

  const setNum = <K extends keyof Form>(key: K, value: number) => setForm((f) => ({ ...f, [key]: value }));

  // ---- lighting ----------------------------------------------------------------------------------

  const light = async (index: number) => {
    if (!connectedId) return;
    const res = await run(() => api.lightPixelMappingStep(connectedId, index));
    setLitFailed(res === undefined);
    if (res) setLit({ ...res.pixel });
  };

  // ---- actions -----------------------------------------------------------------------------------

  const target = broadcast ? ({ scope: 'all' } as const) : card ? ({ scope: 'card', portIndex: card.portIndex, cardIndex: card.cardIndex } as const) : null;

  const doStart = async () => {
    if (!connectedId || !card || !target || !planned.ok) return;
    setBusy(true);
    setFailure(null);
    setUndoSteps(null);
    setUndone(false);
    try {
      const res = await run(() =>
        api.startPixelMapping(connectedId, {
          target,
          reference: { portIndex: card.portIndex, cardIndex: card.cardIndex },
          inputs,
          display: form.display,
          origin: { x: form.originX, y: form.originY },
          ...(broadcast ? { confirmBroadcast: true } : {}),
        }),
      );
      if (!res) return; // rejected: nothing was written, the error toast says why
      setSnapshot(res.snapshot);
      setFrozen({ plan: planned.plan, broadcast });
      setMarking(emptyMarking());
      setRejection(null);
      setAutoAdded(null);
      setCursor({ x: 0, y: 0 });
      if (res.ok) {
        setStage('marking');
        pushInfo(t('pmap.started'));
        await light(0);
      } else {
        setStage('undo-needed');
        setFailure({ written: res.written, ...(res.failed ? { failed: res.failed } : {}) });
      }
    } finally {
      setBusy(false);
    }
  };

  const doSend = async () => {
    if (!connectedId || !plan) return;
    setBusy(true);
    try {
      const res = await run(() => api.finishPixelMapping(connectedId, marking.marks as { x: number; y: number }[]));
      if (!res) return; // rejected before anything was sent: still marking
      if (res.ok) {
        setStage('sent');
        setFrozen(null);
        setFailure(null);
        pushInfo(t('pmap.sent'));
      } else {
        setStage('undo-needed');
        setFailure({ written: res.written, ...(res.failed ? { failed: res.failed } : {}) });
      }
    } finally {
      setBusy(false);
    }
  };

  const doCancel = async () => {
    if (!connectedId) return;
    setBusy(true);
    try {
      const res = await run(() => api.cancelPixelMapping(connectedId));
      if (!res) return;
      setUndoSteps(res.steps);
      if (res.ok) {
        setUndone(true);
        setStage('setup');
        setFrozen(null);
        setFailure(null);
        setMarking(emptyMarking());
        setLit(null);
        pushInfo(t('pmap.undone'));
      } else {
        setStage('undo-needed');
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmNow = () => {
    const c = confirm;
    setConfirm(null);
    setUnderstood(false);
    if (c === 'start') void doStart();
    else if (c === 'send') void doSend();
    else if (c === 'cancel') void doCancel();
  };

  // ---- marking -----------------------------------------------------------------------------------

  const apply = (change: MarkingChange) => {
    if (!change.ok) {
      setRejection(change.reason);
      return;
    }
    setRejection(null);
    setAutoAdded(change.added ?? null);
    setMarking(change.state);
    if (plan && change.state.marks.length < plan.steps.length) void light(change.state.marks.length);
  };

  const markAt = (x: number, y: number) => {
    if (stage !== 'marking' || busy || !plan) return;
    setCursor({ x, y });
    apply(markCell(plan, marking, { x, y }));
  };
  const onUndo = () => {
    if (stage === 'marking' && !busy) apply(undoMark(marking));
  };
  const onClear = () => {
    if (stage !== 'marking' || busy) return;
    apply({ ok: true, state: clearMarks() });
    void light(0);
  };
  const onAuto = () => {
    if (stage === 'marking' && !busy && plan) apply(autoCreate(plan, marking));
  };
  const onInvalid = () => {
    if (stage === 'marking' && !busy && plan) apply(markInvalid(plan, marking));
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!plan || stage !== 'marking') return;
    const { cols, rows } = plan.grid;
    const move = (dx: number, dy: number) => {
      e.preventDefault();
      setCursor((c) => ({ x: Math.min(cols - 1, Math.max(0, c.x + dx)), y: Math.min(rows - 1, Math.max(0, c.y + dy)) }));
    };
    if (e.key === 'ArrowRight') move(1, 0);
    else if (e.key === 'ArrowLeft') move(-1, 0);
    else if (e.key === 'ArrowDown') move(0, 1);
    else if (e.key === 'ArrowUp') move(0, -1);
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      markAt(cursor.x, cursor.y);
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      onUndo();
    }
  };

  // ---- derived -----------------------------------------------------------------------------------

  const progress = plan ? markingProgress(plan, marking) : null;
  const next = plan ? nextStep(plan, marking) : null;
  const marked = useMemo(() => {
    const m = new Map<string, number>();
    marking.marks.forEach((c, i) => {
      if (!isInvalidCell(c)) m.set(`${c.x},${c.y}`, i + 1);
    });
    return m;
  }, [marking]);

  const collected = useMemo(() => (plan && progress && progress.phase === 'done' ? collectMarking(plan, marking) : null), [plan, progress, marking]);
  const image = useMemo(() => {
    if (!plan || !collected || !collected.ok) return null;
    try {
      return { ok: true as const, value: buildFinalImage(plan, collected.marking) };
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) };
    }
  }, [plan, collected]);

  const running = stage === 'marking' || stage === 'undo-needed';
  const canStart = advanced && applied !== null && card !== null && !!connectedId && planned.ok && gridCells <= MAX_GRID_CELLS && displays.length > 0 && !busy && stage !== 'marking' && stage !== 'undo-needed';
  const formOff = !advanced || running || busy;

  const num = (key: 'moduleWidth' | 'moduleHeight' | 'scanCount' | 'dataGroups' | 'modulesAcross' | 'modulesDown' | 'lineBias' | 'originX' | 'originY', label: MessageKey, min: number, max: number) => (
    <label className="field">
      {t(label)}
      <input
        type="number"
        min={min}
        max={max}
        step={1}
        value={form[key]}
        disabled={formOff}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(n)) setNum(key, Math.round(n));
        }}
      />
    </label>
  );

  const failureBlock = failure && (
    <div className="card" role="alert" data-testid="pmap-partial">
      <p className="field-error">{t('pmap.partial')}</p>
      <p>{t('pmap.partial.written', { steps: failure.written.length > 0 ? failure.written.join(', ') : t('smart.none') })}</p>
      {failure.failed && (
        <p>
          {t('pmap.partial.failed', {
            step: failure.failed.step,
            message: `${t(`error.${failure.failed.code}` as MessageKey)} (${failure.failed.message})`,
          })}
        </p>
      )}
    </div>
  );

  const stepsBlock = undoSteps && undoSteps.length > 0 && (
    <ul data-testid="pmap-undo-steps">
      {undoSteps.map((s, i) => (
        <li key={`${s.step}-${i}`}>{t('pmap.undo.step', { step: s.step, result: s.ok ? t('pmap.undo.ok') : t('pmap.undo.fail', { message: s.message ?? '' }) })}</li>
      ))}
    </ul>
  );

  return (
    <div className="card" role="group" aria-label={t('smart.step.pixels')}>
      <h2>{t('pmap.title')}</h2>
      <p className="muted">{t('pmap.desc')}</p>
      <p data-testid="pmap-chip-note">{t('pmap.chipNote')}</p>
      {onNavigate && (
        <p>
          <button type="button" onClick={() => onNavigate('import')}>
            {t('pmap.importLink')}
          </button>
        </p>
      )}
      <p className="muted">{t('pmap.gen3')}</p>
      <p className="muted">{t('pmap.ramOnly')}</p>
      {!applied && <p className="muted">{t('pmap.needSnapshot')}</p>}
      {!advanced && <p className="muted">{t('smart.locked')}</p>}

      {(stage === 'setup' || stage === 'sent') && (
        <>
          {stage === 'sent' && (
            <div data-testid="pmap-sent">
              <p>{t('pmap.sent')}</p>
              <button type="button" className="primary" onClick={onGoFinish}>
                {t('pmap.goFinish')}
              </button>
            </div>
          )}
          {undone && (
            <div data-testid="pmap-undone">
              <p>{t('pmap.undone')}</p>
              {stepsBlock}
            </div>
          )}
          {failureBlock}

          <fieldset disabled={formOff}>
            <legend>{t('pmap.in.legend')}</legend>
            {num('moduleWidth', 'smart.f.moduleWidth', 1, 255)}
            {num('moduleHeight', 'smart.f.moduleHeight', 1, 255)}
            {num('scanCount', 'smart.f.scanMode', 1, SCAN_MAX)}
            {num('dataGroups', 'smart.f.dataGroups', 1, 8)}
            <label className="field">
              {t('smart.f.dataDirection')}
              <select value={form.dataDirection} disabled={formOff} onChange={(e) => setNum('dataDirection', Number(e.target.value))}>
                <option value={0}>{t('smart.dir.0')}</option>
                <option value={1}>{t('smart.dir.1')}</option>
              </select>
            </label>
            <label className="field">
              {t('pmap.in.points')}
              <input type="number" min={1} max={65535} value={form.pointsPerDriver} disabled={formOff} onChange={(e) => setForm((f) => ({ ...f, pointsPerDriver: e.target.value }))} />
            </label>
            {num('modulesAcross', 'pmap.in.across', 1, 16)}
            {num('modulesDown', 'pmap.in.down', 1, 16)}
            <label className="field">
              {t('pmap.in.cascade')}
              <select value={form.cascade} disabled={formOff} onChange={(e) => setForm((f) => ({ ...f, cascade: e.target.value === 'vertical' ? 'vertical' : 'horizontal' }))}>
                <option value="horizontal">{t('pmap.in.cascade.horizontal')}</option>
                <option value="vertical">{t('pmap.in.cascade.vertical')}</option>
              </select>
            </label>
            {num('lineBias', 'pmap.in.lineBias', 0, 255)}
            <label className="field">
              {t('pmap.in.display')}
              <select value={form.display} disabled={formOff || displays.length === 0} onChange={(e) => {
                  displayTouched.current = true;
                  setNum('display', Number(e.target.value));
                }}
              >
                {displays.map((d) => (
                  <option key={d.index} value={d.index}>
                    {d.label} ({d.width} x {d.height})
                  </option>
                ))}
              </select>
            </label>
            {displays.length === 0 && connectedId && <p className="field-error">{t('pmap.in.noDisplays')}</p>}
            {num('originX', 'pmap.in.originX', 0, 65535)}
            {num('originY', 'pmap.in.originY', 0, 65535)}
            <p className="muted">{t('pmap.in.displayHint')}</p>
          </fieldset>

          {planned.ok ? (
            <>
              <p data-testid="pmap-plan">
                {t('pmap.plan.summary', {
                  total: planned.plan.totalPoints,
                  cols: planned.plan.grid.cols,
                  rows: planned.plan.grid.rows,
                  steps: planned.plan.steps.length,
                  width: planned.plan.controlWidth,
                  height: planned.plan.controlHeight,
                })}
              </p>
              {gridCells > MAX_GRID_CELLS && <p className="field-error">{t('pmap.plan.tooBig', { cells: gridCells })}</p>}
            </>
          ) : (
            <p className="field-error" role="alert" data-testid="pmap-plan-invalid">
              {t('pmap.plan.invalid', { errors: planned.errors.join('; ') })}
            </p>
          )}

          <fieldset disabled={formOff}>
            <label className="row">
              <input type="radio" name="pmap-target" checked={!broadcast} disabled={formOff} onChange={() => setBroadcast(false)} />
              {t('pmap.target.one', { target: targetText })}
            </label>
            <label className="row">
              <input type="radio" name="pmap-target" checked={broadcast} disabled={formOff} onChange={() => setBroadcast(true)} />
              {t('pmap.target.all')}
            </label>
            {broadcast && (
              <p className="field-error" role="alert" data-testid="pmap-broadcast-warn">
                {t('pmap.broadcast.warn', { target: targetText })}
              </p>
            )}
          </fieldset>

          <div className="row">
            <button type="button" className="primary" disabled={!canStart} onClick={() => setConfirm('start')}>
              {t('pmap.start')}
            </button>
          </div>
        </>
      )}

      {running && plan && progress && (
        <>
          {snapshot && (
            <p className="muted" data-testid="pmap-snapshot">
              {t('pmap.snapshotTaken', { width: snapshot.controlWidth, height: snapshot.controlHeight, total: snapshot.totalPointInTable, mode: snapshot.smartSetMode })}
            </p>
          )}
          {failureBlock}
          {stage === 'undo-needed' && undoSteps && !undone && (
            <div role="alert" data-testid="pmap-undo-failed">
              <p className="field-error">{t('pmap.undoFailed')}</p>
              {stepsBlock}
            </div>
          )}

          {stage === 'marking' && (
            <>
              <p role="status" data-testid="pmap-progress">
                {t('pmap.step', { i: progress.current, n: progress.total })}
              </p>
              <p className="muted" data-testid="pmap-counts">
                {t('pmap.counts', { done: progress.done, total: progress.total, invalid: progress.invalid })}
              </p>
              {next && (
                <p data-testid="pmap-instruction">
                  {next.phase === 'A' ? t('pmap.phase.A', { i: next.index + 1, t: plan.totalPoints }) : t('pmap.phase.B', { s: next.scan + 1 })}
                </p>
              )}
              {lit && next && (
                <p className="muted" data-testid="pmap-lit">
                  {t('pmap.pixelNow', { x: lit.x, y: lit.y })}
                </p>
              )}
              {litFailed && (
                <p className="field-error" role="alert" data-testid="pmap-lit-failed">
                  {t('pmap.lightFailed')}
                </p>
              )}
              {rejection && (
                <p className="field-error" role="alert" data-testid="pmap-rejection">
                  {t(`pmap.rej.${rejection}` as MessageKey)}
                </p>
              )}
              {autoAdded !== null && <p data-testid="pmap-auto-added">{t('pmap.auto.added', { count: autoAdded })}</p>}

              <div
                role="grid"
                tabIndex={0}
                className="pmap-grid"
                data-testid="pmap-grid"
                aria-label={t('pmap.grid.label', { cols: plan.grid.cols, rows: plan.grid.rows })}
                aria-activedescendant={`pmap-cell-${cursor.x}-${cursor.y}`}
                style={{ gridTemplateColumns: `repeat(${plan.grid.cols}, 1.6rem)` }}
                onKeyDown={onGridKey}
              >
                {Array.from({ length: plan.grid.rows }, (_, y) => (
                  <div role="row" key={y} style={{ display: 'contents' }}>
                    {Array.from({ length: plan.grid.cols }, (_, x) => {
                      const n = marked.get(`${x},${y}`);
                      return (
                        <div
                          key={x}
                          role="gridcell"
                          id={`pmap-cell-${x}-${y}`}
                          data-testid={`pmap-cell-${x}-${y}`}
                          aria-selected={n !== undefined}
                          aria-label={n !== undefined ? t('pmap.cell.marked', { x, y, n }) : t('pmap.cell', { x, y })}
                          className={'pmap-cell' + (n !== undefined ? ' marked' : '') + (cursor.x === x && cursor.y === y ? ' cursor' : '')}
                          onClick={() => markAt(x, y)}
                        >
                          {n !== undefined && gridCells <= MAX_NUMBERED_CELLS ? n : ''}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>

              <div className="row">
                <button type="button" disabled={busy || marking.marks.length === 0} onClick={onUndo}>
                  {t('pmap.undo')}
                </button>
                <button type="button" disabled={busy || marking.marks.length === 0} onClick={onClear}>
                  {t('pmap.clear')}
                </button>
                <button type="button" disabled={busy || progress.phase !== 'A' || marking.marks.length < 2} onClick={onAuto}>
                  {t('pmap.auto')}
                </button>
                <button type="button" disabled={busy || progress.phase === 'done'} onClick={onInvalid}>
                  {t('pmap.invalid')}
                </button>
                <button type="button" disabled={busy || progress.phase === 'done'} onClick={() => void light(marking.marks.length)}>
                  {t('pmap.relight')}
                </button>
              </div>

              {progress.phase === 'done' && (
                <div data-testid="pmap-preview">
                  <h3>{t('pmap.preview.title')}</h3>
                  {collected && !collected.ok && (
                    <div role="alert">
                      <p className="field-error">{t('pmap.preview.errors')}</p>
                      <ul>
                        {collected.errors.map((e) => (
                          <li key={e}>{e}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {image && !image.ok && (
                    <p className="field-error" role="alert">
                      {image.message}
                    </p>
                  )}
                  {collected?.ok && image?.ok && (
                    <>
                      <p>
                        {t('pmap.preview.summary', {
                          entries: collected.marking.pointTable.length,
                          bytes: image.value.pointTable.length,
                          scan: image.value.scanSequence.length,
                          direction: collected.marking.ascending ? t('pmap.preview.asc') : t('pmap.preview.desc'),
                        })}
                      </p>
                      <p>{t('pmap.preview.table')}</p>
                      <code className="pmap-hex" data-testid="pmap-preview-table">
                        {hex(image.value.pointTable)}
                      </code>
                      <p>{t('pmap.preview.scan')}</p>
                      <code className="pmap-hex" data-testid="pmap-preview-scan">
                        {hex(image.value.scanSequence)}
                      </code>
                      <p>{t('pmap.preview.registers')}</p>
                      <ul data-testid="pmap-preview-registers">
                        {image.value.geometry.map((g) => (
                          <li key={g.key}>
                            {g.key}: {hex(g.data)}
                          </li>
                        ))}
                      </ul>
                      <div className="row">
                        <button type="button" className="primary" disabled={busy} onClick={() => setConfirm('send')}>
                          {t('pmap.send')}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          )}

          <div className="row">
            <button type="button" disabled={busy || !advanced} onClick={() => setConfirm('cancel')}>
              {t('pmap.cancel')}
            </button>
            <span className="muted">{t('pmap.cancelHelp')}</span>
          </div>
        </>
      )}

      {confirm && (
        <ConfirmDialog
          title={t(confirm === 'start' ? 'pmap.confirm.startTitle' : confirm === 'send' ? 'pmap.confirm.sendTitle' : 'pmap.confirm.cancelTitle')}
          onCancel={() => {
            setConfirm(null);
            setUnderstood(false);
          }}
          onConfirm={confirmNow}
          confirmDisabled={confirm === 'start' && broadcast && !understood}
        >
          <p data-testid="pmap-confirm-body">
            {confirm === 'start'
              ? t('pmap.confirm.startBody', { target: broadcast ? t('pmap.target.all') : targetText })
              : confirm === 'send'
                ? t('pmap.confirm.sendBody', { target: frozen?.broadcast ? t('pmap.target.all') : targetText })
                : t('pmap.confirm.cancelBody', { target: frozen?.broadcast ? t('pmap.target.all') : targetText })}
          </p>
          {confirm === 'start' && (
            <>
              <p>{t('pmap.chipNote')}</p>
              <p data-testid="pmap-confirm-undo">{t('pmap.confirm.undoNote')}</p>
              {planned.ok && applied && (
                <p className="muted" data-testid="pmap-confirm-size">
                  {t('pmap.plan.cardNow', { width: planned.plan.controlWidth, height: planned.plan.controlHeight, total: planned.plan.totalPoints, moduleWidth: applied.moduleWidth, moduleHeight: applied.moduleHeight })}{' '}
                  {t('pmap.plan.sizeChange')}
                </p>
              )}
              {broadcast && (
                <>
                  <p className="field-error" role="alert">
                    {t('pmap.confirm.broadcastBody')}
                  </p>
                  <label className="row">
                    <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
                    {t('pmap.confirm.broadcastTick')}
                  </label>
                </>
              )}
            </>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}
