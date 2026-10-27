import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  CHIP_TYPE_NAMES,
  COLOR_NAMES,
  DECODE_TYPE_NAMES,
  SMART_BASIC_FIELDS,
  SMART_LIMITS,
  basicChanges,
  computeRgbCode,
  decideOePolarity,
  diffSmartValues,
  profileFromSmartValues,
  smartChangesBetween,
  smartValuesFromProfile,
  smartValuesOf,
  validateModuleProfile,
  validateSmartChanges,
  type ColorName,
  type ColorObservation,
  type ModuleProfile,
  type OeObservation,
  type ReceiverTarget,
  type RgbCode,
  type RgbConvention,
  type RgbObservations,
  type SaveToHardwareResult,
  type SmartChanges,
  type SmartField,
  type SmartSnapshot,
  type SmartValues,
  type SmartWriteFailure,
  type SmartWriteResult,
  type TestPattern,
} from '@rockzalct/shared';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/dictionary';
import { useApp } from '../state/AppContext';
import { loadLibrary, saveLibrary, withProfile } from './moduleLibrary';
import { ConfirmDialog } from './persist/ConfirmDialog';

type StepId = 'snapshot' | 'basics' | 'rgb' | 'oe' | 'finish';
const STEPS: readonly StepId[] = ['snapshot', 'basics', 'rgb', 'oe', 'finish'];

const FIELD_LABEL: Record<SmartField, MessageKey> = {
  moduleWidth: 'smart.f.moduleWidth',
  moduleHeight: 'smart.f.moduleHeight',
  scanMode: 'smart.f.scanMode',
  dataGroups: 'smart.f.dataGroups',
  driverIc: 'smart.f.driverIc',
  decodeType: 'smart.f.decodeType',
  dataDirection: 'smart.f.dataDirection',
  oePolarity: 'smart.f.oePolarity',
  rgb: 'smart.f.rgb',
};

const COLOR_PATTERN: Record<ColorName, TestPattern> = { red: 'red', green: 'green', blue: 'blue' };
const COLOR_KEY: Record<ColorName, MessageKey> = { red: 'smart.color.red', green: 'smart.color.green', blue: 'smart.color.blue' };

/** What a confirmation dialog is about; the values are frozen when the dialog opens. */
type Pending =
  | { kind: 'basics'; changes: SmartChanges }
  | { kind: 'rgb'; changes: SmartChanges; retry: RgbTry }
  | { kind: 'oe'; changes: SmartChanges }
  | { kind: 'revert' }
  | { kind: 'flash' };

/** The code and answers an RGB write was computed from, so the opposite mapping can be tried afterwards. */
interface RgbTry {
  base: RgbCode;
  obs: RgbObservations;
  convention: RgbConvention;
}

const cardKey = (port: number, card: number): string => `${port}:${card}`;
const NAME_MAX = 64;

export function SmartSettingsPage() {
  const { t } = useI18n();
  const { api, connectedId, info, level, run, pushInfo, setPattern } = useApp();
  const advanced = level === 'advanced';
  const cards = useMemo(() => info?.receivingCards ?? [], [info]);

  const [selected, setSelected] = useState('');
  const [step, setStep] = useState<StepId>('snapshot');
  const [snapshot, setSnapshot] = useState<SmartSnapshot | null>(null);
  /** What the card holds now, as far as the wizard knows (the snapshot plus every successful write). */
  const [applied, setApplied] = useState<SmartValues | null>(null);
  /** True after a write that failed midway: the card state is not fully known until a revert. */
  const [uncertain, setUncertain] = useState(false);
  const [report, setReport] = useState<{ written: SmartField[]; failed?: SmartWriteFailure } | null>(null);
  const [draft, setDraft] = useState<SmartValues | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [rgbObs, setRgbObs] = useState<Partial<Record<ColorName, ColorObservation>>>({});
  const [rgbTry, setRgbTry] = useState<RgbTry | null>(null);
  const [oeObs, setOeObs] = useState<OeObservation | null>(null);
  const [oeWritten, setOeWritten] = useState(false);
  const [kept, setKept] = useState(false);
  const [saveResult, setSaveResult] = useState<SaveToHardwareResult | null>(null);
  const [library, setLibrary] = useState<ModuleProfile[]>(loadLibrary);
  const [prefill, setPrefill] = useState('');
  const [profileName, setProfileName] = useState('');
  const [profileError, setProfileError] = useState(false);

  // Only the newest snapshot read may fill the wizard.
  const readToken = useRef(0);
  const patternOn = useRef(false);
  const setPatternRef = useRef(setPattern);
  setPatternRef.current = setPattern;

  const card = useMemo(() => {
    const [p, c] = selected.split(':').map(Number);
    return cards.find((x) => x.portIndex === p && x.cardIndex === c) ?? null;
  }, [cards, selected]);

  const dirty = snapshot !== null && applied !== null && (uncertain || diffSmartValues(snapshot, applied).length > 0);

  const resetWizard = () => {
    readToken.current++;
    setStep('snapshot');
    setSnapshot(null);
    setApplied(null);
    setDraft(null);
    setUncertain(false);
    setReport(null);
    setPending(null);
    setRgbObs({});
    setRgbTry(null);
    setOeObs(null);
    setOeWritten(false);
    setKept(false);
    setSaveResult(null);
    setProfileError(false);
  };

  // A new connection (new card list): start over with the first card.
  useEffect(() => {
    const first = cards[0];
    setSelected(first ? cardKey(first.portIndex, first.cardIndex) : '');
    resetWizard();
  }, [cards]);

  // Do not leave a test colour on the screen when the page closes.
  useEffect(
    () => () => {
      if (patternOn.current) void setPatternRef.current('off');
    },
    [],
  );

  const showPattern = async (p: TestPattern) => {
    patternOn.current = p !== 'off';
    await setPattern(p);
  };
  /** Switch a test pattern this page started off; does nothing when none is on. */
  const patternOff = async () => {
    if (patternOn.current) await showPattern('off');
  };

  const target = (): ReceiverTarget | null =>
    card ? { scope: 'card', portIndex: card.portIndex, cardIndex: card.cardIndex } : null;

  const targetText = (): string =>
    card ? t('smart.target', { port: card.portIndex + 1, card: card.cardIndex + 1 }) : '-';

  // ---- Step 1: snapshot ------------------------------------------------------------------------

  const readSnapshot = async () => {
    if (!connectedId || !card) return;
    const token = ++readToken.current;
    setReading(true);
    try {
      const snap = await run(() => api.readSmartSnapshot(connectedId, card.portIndex, card.cardIndex));
      if (token !== readToken.current) return;
      if (snap) {
        await patternOff();
        setSnapshot(snap);
        setApplied(smartValuesOf(snap));
        setDraft(smartValuesOf(snap));
        setUncertain(false);
        setReport(null);
        setRgbObs({});
        setRgbTry(null);
        setOeObs(null);
        setOeWritten(false);
        setKept(false);
        setSaveResult(null);
      }
    } finally {
      if (token === readToken.current) setReading(false);
    }
  };

  // ---- Writing ---------------------------------------------------------------------------------

  /** Write, merge the written fields into `applied`, and report a partial failure. */
  const write = async (changes: SmartChanges, restore = false): Promise<SmartWriteResult | undefined> => {
    const tg = target();
    if (!connectedId || !tg) return undefined;
    setBusy(true);
    try {
      const res = await run(() => api.writeSmartSettings(connectedId, tg, changes, restore ? { restore: true } : undefined));
      if (!res) {
        // Rejected: nothing was written. (If the failure is a lost connection the next read tells.)
        return undefined;
      }
      setApplied((cur) =>
        cur ? smartValuesOf({ ...cur, ...Object.fromEntries(res.written.map((f) => [f, changes[f]])) } as SmartValues) : cur,
      );
      if (res.ok) {
        setReport(null);
        setKept(false);
      } else {
        setUncertain(true);
        setReport({ written: res.written, ...(res.failed ? { failed: res.failed } : {}) });
      }
      return res;
    } finally {
      setBusy(false);
    }
  };

  const confirmPending = async () => {
    const p = pending;
    setPending(null);
    if (!p || !snapshot) return;
    if (p.kind === 'basics') {
      const res = await write(p.changes);
      if (res?.ok) {
        pushInfo(t('smart.written', { count: res.written.length }));
      }
    } else if (p.kind === 'rgb') {
      const res = await write(p.changes);
      if (res?.ok) {
        setRgbObs({});
        setRgbTry(p.retry);
        pushInfo(t('smart.rgb.written'));
      }
    } else if (p.kind === 'oe') {
      const res = await write(p.changes);
      if (res?.ok) {
        setOeObs(null);
        setOeWritten(true);
        pushInfo(t('smart.oe.written'));
      }
    } else if (p.kind === 'revert') {
      await doRevert(snapshot);
    } else {
      await saveToFlash();
    }
  };

  const doRevert = async (snap: SmartSnapshot) => {
    // Every register is written back (not only the ones the wizard changed): after a failed write
    // its state is unknown. `restore` lets values outside the wizard limits (e.g. driver IC 255) through.
    const res = await write(smartValuesOf(snap), true);
    if (res?.ok) {
      await patternOff();
      setUncertain(false);
      setReport(null);
      setDraft(smartValuesOf(snap));
      setRgbObs({});
      setRgbTry(null);
      setOeObs(null);
      setOeWritten(false);
      setKept(false);
      pushInfo(t('smart.reverted'));
    }
  };

  const saveToFlash = async () => {
    const tg = target();
    if (!connectedId || !tg) return;
    setBusy(true);
    setSaveResult(null);
    try {
      // The existing save flow: this page never saves implicitly, and never touches the sending card.
      const res = await run(() => api.saveToHardware(connectedId, tg, { includeSender: false }));
      if (res) {
        setSaveResult(res);
        if (res.ok) {
          await patternOff();
          pushInfo(t('persist.save.ok', { count: res.cards.length }));
        }
      }
    } finally {
      setBusy(false);
    }
  };

  // ---- Step 2: basics --------------------------------------------------------------------------

  const setDraftField = <K extends Exclude<SmartField, 'rgb' | 'oePolarity'>>(field: K, value: number) =>
    setDraft((d) => (d ? { ...d, [field]: value } : d));

  const invalidFields: SmartField[] = useMemo(() => {
    if (!draft) return [];
    return SMART_BASIC_FIELDS.filter((f) => validateSmartChanges({ [f]: draft[f] }) !== null);
  }, [draft]);

  const basicsChanges: SmartChanges = applied && draft ? basicChanges(applied, draft) : {};
  const basicsCount = Object.keys(basicsChanges).length;

  const numberInput = (field: 'moduleWidth' | 'moduleHeight' | 'scanMode' | 'dataGroups', range: { readonly min: number; readonly max: number }) => (
    <label className="field">
      {t(FIELD_LABEL[field])}
      <input
        type="number"
        min={range.min}
        max={range.max}
        step={1}
        value={draft ? draft[field] : ''}
        aria-invalid={invalidFields.includes(field)}
        disabled={!advanced || !draft || busy}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(n)) setDraftField(field, Math.round(n));
        }}
      />
    </label>
  );

  /** `<option>` list for an enum-like field: the known names plus the current value when it is not one of them. */
  const enumOptions = (names: Readonly<Record<number, string>>, current: number | undefined, prefix: string) => {
    const values = Object.keys(names).map(Number);
    if (current !== undefined && !values.includes(current)) values.push(current);
    values.sort((a, b) => a - b);
    return values.map((v) => (
      <option key={v} value={v}>
        {names[v] !== undefined ? `${v} - ${prefix}${names[v]}` : t('smart.codeOnly', { code: v })}
      </option>
    ));
  };

  const valueText = (field: SmartField, v: SmartValues[SmartField]): string => {
    if (typeof v === 'object') return t('smart.rgbText', { red: v.red, green: v.green, blue: v.blue, virtual: v.virtualRed });
    if (field === 'driverIc') return CHIP_TYPE_NAMES[v] ? `${v} (${CHIP_TYPE_NAMES[v]})` : String(v);
    if (field === 'decodeType') return DECODE_TYPE_NAMES[v] ? `${v} (${DECODE_TYPE_NAMES[v]})` : String(v);
    if (field === 'dataDirection') return v === 0 ? t('smart.dir.0') : v === 1 ? t('smart.dir.1') : String(v);
    if (field === 'oePolarity') return v === 0 ? t('smart.oe.0') : v === 1 ? t('smart.oe.1') : String(v);
    return String(v);
  };

  const valuesTable = (values: SmartValues, testid: string) => (
    <dl className="kv" data-testid={testid}>
      {(['moduleWidth', 'moduleHeight', 'scanMode', 'dataGroups', 'driverIc', 'decodeType', 'dataDirection', 'rgb', 'oePolarity'] as SmartField[]).map(
        (f) => (
          <Fragment key={f}>
            <dt>{t(FIELD_LABEL[f])}</dt>
            <dd data-testid={`${testid}-${f}`}>{valueText(f, values[f])}</dd>
          </Fragment>
        ),
      )}
    </dl>
  );

  const changeList = (changes: SmartChanges, from: SmartValues) => (
    <ul>
      {diffSmartValues(from, { ...from, ...changes }).map((d) => (
        <li key={d.field}>
          {t(FIELD_LABEL[d.field])}: {valueText(d.field, d.before)} {'→'} {valueText(d.field, d.after)}
        </li>
      ))}
    </ul>
  );

  // ---- Step 3: RGB -----------------------------------------------------------------------------

  const allAnswered = COLOR_NAMES.every((c) => rgbObs[c] !== undefined);
  const rgbComputation = useMemo(
    () => (applied && allAnswered ? computeRgbCode(applied.rgb, rgbObs as RgbObservations) : null),
    [applied, allAnswered, rgbObs],
  );

  // ---- Step 4: OE ------------------------------------------------------------------------------

  const oeDecision = applied && oeObs ? decideOePolarity(applied.oePolarity, oeObs) : null;

  // ---- Step 5: profile -------------------------------------------------------------------------

  const saveProfile = async () => {
    if (!connectedId || !card || !applied) return;
    const params = await run(() => api.getReceiverParameters(connectedId, card.portIndex, card.cardIndex));
    if (!params) return;
    const res = validateModuleProfile(profileFromSmartValues(profileName, applied, params));
    if (!res.ok) {
      setProfileError(true);
      return;
    }
    setProfileError(false);
    const next = withProfile(library, res.profile);
    setLibrary(next);
    saveLibrary(next);
    pushInfo(t('rcv.lib.saved', { name: res.profile.name }));
  };

  // ---- Render ----------------------------------------------------------------------------------

  const disconnected = connectedId === null;
  const writeBlocked = !advanced || !snapshot || busy;
  const stepIndex = STEPS.indexOf(step);
  const goto = (s: StepId) => {
    if (s !== 'snapshot' && !snapshot) return;
    setStep(s);
  };
  const nav = (
    <div className="row">
      <button type="button" disabled={stepIndex === 0} onClick={() => goto(STEPS[stepIndex - 1]!)}>
        {t('smart.back')}
      </button>
      <button type="button" disabled={stepIndex === STEPS.length - 1 || !snapshot} onClick={() => goto(STEPS[stepIndex + 1]!)}>
        {t('smart.next')}
      </button>
    </div>
  );

  const stopPattern = (
    <button type="button" disabled={disconnected} onClick={() => void showPattern('off')}>
      {t('smart.pattern.off')}
    </button>
  );

  return (
    <section>
      <h1>{t('smart.title')}</h1>
      {disconnected && <p className="muted">{t('rcv.needConnect')}</p>}
      {!disconnected && cards.length === 0 && <p className="muted">{t('rcv.noCards')}</p>}
      <p className="muted" data-testid="smart-limit-note">
        {t('smart.limitNote')}
      </p>
      {!advanced && <p className="muted">{t('smart.locked')}</p>}

      <nav aria-label={t('smart.steps')}>
        <ol className="row" style={{ listStyle: 'none', padding: 0, flexWrap: 'wrap' }}>
          {STEPS.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                className={'choice' + (step === s ? ' selected' : '')}
                aria-current={step === s ? 'step' : undefined}
                disabled={disconnected || (s !== 'snapshot' && !snapshot)}
                onClick={() => goto(s)}
              >
                {i + 1}. {t(`smart.step.${s}` as MessageKey)}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      {snapshot && step !== 'finish' && (
        <div className="card row" data-testid="smart-revert-bar">
          <span className={dirty ? 'field-error' : 'muted'} data-testid="smart-dirty">
            {dirty ? t('smart.dirty') : t('smart.clean')}
          </span>
          <button type="button" disabled={writeBlocked} onClick={() => setPending({ kind: 'revert' })}>
            {t('smart.revert')}
          </button>
        </div>
      )}

      {report && (
        <div className="card" role="alert" data-testid="smart-partial">
          <p className="field-error">{t('smart.partial')}</p>
          <p>
            {t('smart.partial.written', {
              fields: report.written.length > 0 ? report.written.map((f) => t(FIELD_LABEL[f])).join(', ') : t('smart.none'),
            })}
          </p>
          {report.failed && (
            <p>
              {t('smart.partial.failed', {
                field: t(FIELD_LABEL[report.failed.field]),
                message: `${t(`error.${report.failed.code}` as MessageKey)} (${report.failed.message})`,
              })}
            </p>
          )}
          <p>{t('smart.partial.offerRevert')}</p>
        </div>
      )}

      {step === 'snapshot' && (
        <div className="card" role="group" aria-label={t('smart.step.snapshot')}>
          <h2>{t('smart.step.snapshot')}</h2>
          <p className="muted">{t('smart.snapshot.desc')}</p>
          <label className="field">
            {t('rcv.picker')}
            <select
              value={selected}
              disabled={disconnected || cards.length === 0 || reading || dirty}
              onChange={(e) => {
                setSelected(e.target.value);
                resetWizard();
              }}
            >
              {cards.map((c) => (
                <option key={cardKey(c.portIndex, c.cardIndex)} value={cardKey(c.portIndex, c.cardIndex)}>
                  {t('rcv.pickerOption', { port: c.portIndex + 1, card: c.cardIndex + 1, model: c.model })}
                </option>
              ))}
            </select>
          </label>
          {dirty && <p className="muted">{t('smart.cardLocked')}</p>}
          <p className="muted">{t('smart.broadcastNote')}</p>
          <div className="row">
            <button type="button" className="primary" disabled={disconnected || !card || reading || dirty} onClick={() => void readSnapshot()}>
              {reading ? t('rcv.loading') : snapshot ? t('smart.snapshot.reread') : t('smart.snapshot.read')}
            </button>
          </div>
          {snapshot && (
            <>
              <p data-testid="smart-snapshot-ok">{t('smart.snapshot.ok', { target: targetText() })}</p>
              {valuesTable(smartValuesOf(snapshot), 'snap')}
              {nav}
            </>
          )}
        </div>
      )}

      {step === 'basics' && snapshot && applied && draft && (
        <div className="card" role="group" aria-label={t('smart.step.basics')}>
          <h2>{t('smart.step.basics')}</h2>
          <p className="muted">{t('smart.basics.desc')}</p>
          {library.length > 0 && (
            <div className="row">
              <label className="field">
                {t('smart.basics.prefill')}
                <select value={prefill} disabled={!advanced || busy} onChange={(e) => setPrefill(e.target.value)}>
                  <option value="">-</option>
                  {library.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name} ({p.width} × {p.height})
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={!advanced || busy || prefill === ''}
                onClick={() => {
                  const p = library.find((x) => x.name === prefill);
                  if (p) setDraft((d) => smartValuesFromProfile(p, d ?? applied));
                }}
              >
                {t('smart.basics.prefillButton')}
              </button>
            </div>
          )}
          <label className="field">
            {t('smart.f.driverIc')}
            <select
              value={draft.driverIc}
              disabled={!advanced || busy}
              aria-invalid={invalidFields.includes('driverIc')}
              onChange={(e) => setDraftField('driverIc', Number(e.target.value))}
            >
              {enumOptions(CHIP_TYPE_NAMES, draft.driverIc, '')}
            </select>
          </label>
          {numberInput('moduleWidth', SMART_LIMITS.size)}
          {numberInput('moduleHeight', SMART_LIMITS.size)}
          {numberInput('scanMode', SMART_LIMITS.scanMode)}
          {numberInput('dataGroups', SMART_LIMITS.dataGroups)}
          <label className="field">
            {t('smart.f.decodeType')}
            <select
              value={draft.decodeType}
              disabled={!advanced || busy}
              aria-invalid={invalidFields.includes('decodeType')}
              onChange={(e) => setDraftField('decodeType', Number(e.target.value))}
            >
              {enumOptions(DECODE_TYPE_NAMES, draft.decodeType, '')}
            </select>
          </label>
          <label className="field">
            {t('smart.f.dataDirection')}
            <select
              value={draft.dataDirection}
              disabled={!advanced || busy}
              aria-invalid={invalidFields.includes('dataDirection')}
              onChange={(e) => setDraftField('dataDirection', Number(e.target.value))}
            >
              <option value={0}>{t('smart.dir.0')}</option>
              <option value={1}>{t('smart.dir.1')}</option>
              {draft.dataDirection > 1 && <option value={draft.dataDirection}>{t('smart.codeOnly', { code: draft.dataDirection })}</option>}
            </select>
          </label>
          <p className="muted">{t('smart.unverified.direction')}</p>
          {invalidFields.length > 0 && (
            <p className="field-error" role="alert">
              {t('rcv.lib.invalid', { fields: invalidFields.map((f) => t(FIELD_LABEL[f])).join(', ') })}
            </p>
          )}
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={writeBlocked || invalidFields.length > 0 || basicsCount === 0}
              onClick={() => setPending({ kind: 'basics', changes: basicsChanges })}
            >
              {t('smart.basics.apply')}
            </button>
            <span className="muted">{basicsCount === 0 ? t('smart.noChanges') : t('smart.changesCount', { count: basicsCount })}</span>
          </div>
          {nav}
        </div>
      )}

      {step === 'rgb' && snapshot && applied && (
        <div className="card" role="group" aria-label={t('smart.step.rgb')}>
          <h2>{t('smart.step.rgb')}</h2>
          <p className="muted">{t('smart.rgb.desc')}</p>
          <p className="muted">{t('smart.pattern.global')}</p>
          <p>{t('smart.rgb.current', { code: valueText('rgb', applied.rgb) })}</p>
          {COLOR_NAMES.map((c) => (
            <fieldset key={c} className="field">
              <legend>{t('smart.rgb.row', { color: t(COLOR_KEY[c]) })}</legend>
              <div className="row">
                <button type="button" disabled={disconnected || busy} onClick={() => void showPattern(COLOR_PATTERN[c])}>
                  {t('smart.rgb.show', { color: t(COLOR_KEY[c]) })}
                </button>
                {(['red', 'green', 'blue', 'none'] as ColorObservation[]).map((o) => (
                  <label key={o} className="row">
                    <input
                      type="radio"
                      name={`rgb-${c}`}
                      checked={rgbObs[c] === o}
                      disabled={busy}
                      aria-label={t('smart.rgb.sees', { shown: t(COLOR_KEY[c]), seen: o === 'none' ? t('smart.color.none') : t(COLOR_KEY[o]) })}
                      onChange={() => setRgbObs((s) => ({ ...s, [c]: o }))}
                    />
                    {o === 'none' ? t('smart.color.none') : t(COLOR_KEY[o])}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          {allAnswered && rgbComputation && !rgbComputation.ok && (
            <p className="field-error" role="alert" data-testid="smart-rgb-invalid">
              {t('smart.rgb.invalid')}
            </p>
          )}
          {rgbComputation?.ok && rgbComputation.unchanged && (
            <p data-testid="smart-rgb-ok">{t('smart.rgb.unchanged')}</p>
          )}
          {rgbComputation?.ok && !rgbComputation.unchanged && (
            <>
              <p data-testid="smart-rgb-preview">{t('smart.rgb.preview', { code: valueText('rgb', rgbComputation.code) })}</p>
              {rgbComputation.baseAssumed && <p className="muted">{t('smart.rgb.baseAssumed')}</p>}
              <p className="muted">{t('smart.unverified.rgb')}</p>
              <div className="row">
                <button
                  type="button"
                  className="primary"
                  disabled={writeBlocked}
                  onClick={() => {
                    setPending({
                      kind: 'rgb',
                      changes: { rgb: rgbComputation.code },
                      retry: { base: applied.rgb, obs: rgbObs as RgbObservations, convention: 'normal' },
                    });
                  }}
                >
                  {t('smart.rgb.write')}
                </button>
              </div>
            </>
          )}
          {rgbTry && (
            <div data-testid="smart-rgb-retry">
              <p>{t('smart.rgb.recheck')}</p>
              {rgbTry.convention === 'normal' && (
                <button
                  type="button"
                  disabled={writeBlocked}
                  onClick={() => {
                    const alt = computeRgbCode(rgbTry.base, rgbTry.obs, 'inverse');
                    if (alt.ok) {
                      setPending({ kind: 'rgb', changes: { rgb: alt.code }, retry: { ...rgbTry, convention: 'inverse' } });
                    }
                  }}
                >
                  {t('smart.rgb.opposite')}
                </button>
              )}
            </div>
          )}
          <div className="row">{stopPattern}</div>
          {nav}
        </div>
      )}

      {step === 'oe' && snapshot && applied && (
        <div className="card" role="group" aria-label={t('smart.step.oe')}>
          <h2>{t('smart.step.oe')}</h2>
          <p className="muted">{t('smart.oe.desc')}</p>
          <p className="muted">{t('smart.pattern.global')}</p>
          <p>{t('smart.oe.current', { value: valueText('oePolarity', applied.oePolarity) })}</p>
          <div className="row">
            <button type="button" disabled={disconnected || busy} onClick={() => void showPattern('white')}>
              {t('smart.oe.showWhite')}
            </button>
            {stopPattern}
          </div>
          <fieldset className="field">
            <legend>{t('smart.oe.question')}</legend>
            {(['normal', 'inverted'] as OeObservation[]).map((o) => (
              <label key={o} className="row">
                <input type="radio" name="oe-obs" checked={oeObs === o} disabled={busy} onChange={() => setOeObs(o)} />
                {t(o === 'normal' ? 'smart.oe.normal' : 'smart.oe.inverted')}
              </label>
            ))}
          </fieldset>
          {oeDecision && !oeDecision.ok && (
            <p className="field-error" role="alert">
              {t('smart.oe.invalidCurrent')}
            </p>
          )}
          {oeDecision?.ok && !oeDecision.change && <p data-testid="smart-oe-ok">{t('smart.oe.keep')}</p>}
          {oeDecision?.ok && oeDecision.change && (
            <>
              <p data-testid="smart-oe-preview">
                {t('smart.oe.preview', { from: valueText('oePolarity', applied.oePolarity), to: valueText('oePolarity', oeDecision.value) })}
              </p>
              <p className="muted">{t('smart.unverified.oe')}</p>
              <div className="row">
                <button
                  type="button"
                  className="primary"
                  disabled={writeBlocked}
                  onClick={() => setPending({ kind: 'oe', changes: { oePolarity: oeDecision.value } })}
                >
                  {t('smart.oe.write')}
                </button>
              </div>
            </>
          )}
          {oeWritten && <p data-testid="smart-oe-recheck">{t('smart.oe.recheck')}</p>}
          {nav}
        </div>
      )}

      {step === 'finish' && snapshot && applied && (
        <div className="card" role="group" aria-label={t('smart.step.finish')}>
          <h2>{t('smart.step.finish')}</h2>
          <p className="muted">{t('smart.finish.desc')}</p>
          <h3>{t('smart.finish.diff')}</h3>
          {diffSmartValues(snapshot, applied).length === 0 ? (
            <p data-testid="smart-diff-empty">{t('smart.finish.noDiff')}</p>
          ) : (
            <table aria-label={t('smart.finish.diff')} data-testid="smart-diff">
              <thead>
                <tr>
                  <th>{t('smart.finish.field')}</th>
                  <th>{t('smart.finish.before')}</th>
                  <th>{t('smart.finish.after')}</th>
                </tr>
              </thead>
              <tbody>
                {diffSmartValues(snapshot, applied).map((d) => (
                  <tr key={d.field}>
                    <td>{t(FIELD_LABEL[d.field])}</td>
                    <td>{valueText(d.field, d.before)}</td>
                    <td>{valueText(d.field, d.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {uncertain && (
            <p className="field-error" role="alert">
              {t('smart.finish.uncertain')}
            </p>
          )}
          <div className="row">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void patternOff();
                setKept(true);
                pushInfo(t('smart.finish.keptInfo'));
              }}
            >
              {t('smart.finish.keep')}
            </button>
            <button type="button" disabled={writeBlocked} onClick={() => setPending({ kind: 'revert' })}>
              {t('smart.revert')}
            </button>
            <button
              type="button"
              className="primary"
              disabled={writeBlocked || uncertain}
              onClick={() => setPending({ kind: 'flash' })}
            >
              {t('smart.finish.flash')}
            </button>
          </div>
          {kept && <p data-testid="smart-kept">{t('smart.finish.kept')}</p>}
          <p className="muted">{t('persist.save.unverified')}</p>
          {saveResult && (
            <div data-testid="smart-save-result">
              {saveResult.ok ? (
                <p>{t('persist.save.ok', { count: saveResult.cards.length })}</p>
              ) : (
                <>
                  <p className="field-error" role="alert">
                    {t('persist.save.partial')}
                  </p>
                  <ul>
                    {saveResult.cards
                      .filter((c) => !c.ok)
                      .map((c) => (
                        <li key={`${c.portIndex}:${c.cardIndex}`}>
                          {t('persist.save.cardFailed', {
                            port: c.portIndex === undefined ? '' : c.portIndex + 1,
                            card: c.cardIndex === undefined ? '' : c.cardIndex + 1,
                            message: c.message ?? '',
                          })}
                        </li>
                      ))}
                  </ul>
                </>
              )}
            </div>
          )}

          <h3>{t('smart.finish.profile')}</h3>
          <p className="muted">{t('smart.finish.profileDesc')}</p>
          <label className="field">
            {t('rcv.lib.field.name')}
            <input
              type="text"
              maxLength={NAME_MAX}
              value={profileName}
              aria-invalid={profileError}
              onChange={(e) => setProfileName(e.target.value)}
            />
          </label>
          {profileError && (
            <p className="field-error" role="alert">
              {t('rcv.lib.invalid', { fields: t('rcv.lib.field.name') })}
            </p>
          )}
          <div className="row">
            <button type="button" disabled={disconnected || busy || profileName.trim() === ''} onClick={() => void saveProfile()}>
              {t('smart.finish.saveProfile')}
            </button>
          </div>
          {nav}
        </div>
      )}

      {pending && snapshot && applied && (
        <ConfirmDialog
          title={t(
            pending.kind === 'basics'
              ? 'smart.confirm.basicsTitle'
              : pending.kind === 'rgb'
                ? 'smart.confirm.rgbTitle'
                : pending.kind === 'oe'
                  ? 'smart.confirm.oeTitle'
                  : pending.kind === 'revert'
                    ? 'smart.confirm.revertTitle'
                    : 'persist.save.confirmTitle',
          )}
          onCancel={() => setPending(null)}
          onConfirm={() => void confirmPending()}
        >
          <p data-testid="smart-confirm-target">
            {pending.kind === 'flash'
              ? t('persist.save.confirmBody', {
                  target: card ? t('persist.save.targetCard', { port: card.portIndex + 1, card: card.cardIndex + 1 }) : '-',
                })
              : pending.kind === 'revert'
                ? t('smart.confirm.revertBody', { target: targetText() })
                : t('smart.confirm.body', { target: targetText() })}
          </p>
          {pending.kind === 'revert'
            ? changeList(smartChangesBetween(applied, smartValuesOf(snapshot)), applied)
            : pending.kind !== 'flash' && changeList(pending.changes, applied)}
        </ConfirmDialog>
      )}
    </section>
  );
}
