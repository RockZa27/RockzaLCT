import { useEffect, useState, type ChangeEvent } from 'react';
import {
  diffScreenConfig,
  parseScreenConfigJson,
  type ApplyScreenConfigResult,
  type ConfigDiff,
  type ReadScreenConfigResult,
  type ScreenConfig,
} from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';
import type { MessageKey } from '../../i18n/dictionary';
import { useApp } from '../../state/AppContext';
import { ConfirmDialog } from './ConfirmDialog';
import { DiffTable } from './DiffTable';
import { StepList } from './StepList';
import { mergeModuleLibrary, readFileText } from './fileIo';

interface Loaded {
  name: string;
  config: ScreenConfig;
}

interface Compared {
  current: ReadScreenConfigResult;
  diff: ConfigDiff;
}

type Parts = { receivers: boolean; layout: boolean; sender: boolean };
const PART_KEYS: (keyof Parts)[] = ['receivers', 'layout', 'sender'];
/** Which checkbox governs each diff section. */
const PART_OF = { receiver: 'receivers', layout: 'layout', sender: 'sender' } as const;

/** Open a config file, show its diff against the controller, then apply it (advanced only). */
export function LoadSection() {
  const { t } = useI18n();
  const { api, connectedId, level, run, pushInfo } = useApp();
  const advanced = level === 'advanced';

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [compared, setCompared] = useState<Compared | null>(null);
  const [comparing, setComparing] = useState(false);
  const [parts, setParts] = useState<Parts>({ receivers: true, layout: true, sender: true });
  const [allowModel, setAllowModel] = useState(false);
  const [skipMissing, setSkipMissing] = useState(false);
  const [saveAfter, setSaveAfter] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<ApplyScreenConfigResult | null>(null);

  const resetCompare = () => {
    setCompared(null);
    setApplied(null);
    setAllowModel(false);
    setSkipMissing(false);
    setConfirming(false);
  };

  useEffect(resetCompare, [connectedId]);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // picking the same file again must fire a change again
    if (!file) return;
    resetCompare();
    let text: string;
    try {
      text = await readFileText(file);
    } catch {
      setLoaded(null);
      setErrors(['cannot read file']);
      return;
    }
    const res = parseScreenConfigJson(text);
    if (!res.ok) {
      setLoaded(null);
      setErrors(res.errors.slice(0, 8).map((x) => (x.field ? `${x.field}: ${x.message}` : x.message)));
      return;
    }
    setErrors([]);
    setLoaded({ name: file.name, config: res.config });
  };

  const compare = async () => {
    if (!connectedId || !loaded) return;
    setComparing(true);
    setApplied(null);
    try {
      const current = await run(() => api.readScreenConfig(connectedId));
      if (current) setCompared({ current, diff: diffScreenConfig(loaded.config, current.config) });
    } finally {
      setComparing(false);
    }
  };

  const selectedItems = compared ? compared.diff.items.filter((i) => parts[PART_OF[i.section]]) : [];
  const missing = compared?.diff.missingCards ?? [];
  const mismatch = compared?.diff.modelMismatch === true && compared.current.failures.every((f) => f.part !== 'controller');
  const blockedByModel = mismatch && !allowModel;
  const blockedByMissing = parts.receivers && missing.length > 0 && !skipMissing;
  const nothingToDo = selectedItems.length === 0 && !saveAfter;
  const canApply = advanced && connectedId !== null && compared !== null && !applying && !blockedByModel && !blockedByMissing && !nothingToDo;

  const apply = async () => {
    setConfirming(false);
    if (!connectedId || !loaded) return;
    setApplying(true);
    setApplied(null);
    try {
      const res = await run(() =>
        api.applyScreenConfig(connectedId, loaded.config, {
          parts,
          saveToHardware: saveAfter,
          allowModelMismatch: allowModel,
          skipMissingCards: skipMissing,
        }),
      );
      if (res) {
        setApplied(res);
        setCompared(null); // the controller changed: compare again before applying more
        if (res.ok) pushInfo(t('persist.load.applied', { count: res.steps.filter((s) => s.status === 'written').length }));
      }
    } finally {
      setApplying(false);
    }
  };

  const importLibrary = () => {
    const lib = loaded?.config.moduleLibrary;
    if (!lib) return;
    if (mergeModuleLibrary(lib)) pushInfo(t('persist.load.libraryImported', { count: lib.length }));
  };

  const stepLabel = (s: { kind: string; portIndex?: number; cardIndex?: number }): string =>
    t(`persist.step.${s.kind}` as MessageKey, { port: s.portIndex === undefined ? '' : s.portIndex + 1, card: s.cardIndex === undefined ? '' : s.cardIndex + 1 });

  return (
    <div className="card" role="group" aria-labelledby="persist-load-title">
      <h2 id="persist-load-title">{t('persist.load.title')}</h2>
      <p className="muted">{t('persist.load.desc')}</p>
      <label className="field">
        {t('persist.load.choose')}
        <input type="file" accept=".json,application/json" onChange={(e) => void onFile(e)} />
      </label>

      {errors.length > 0 && (
        <div data-testid="load-errors">
          <p className="field-error" role="alert">
            {t('persist.load.invalid')}
          </p>
          <ul>
            {errors.map((m, n) => (
              <li key={n}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      {loaded && (
        <div data-testid="loaded-file">
          <p>
            {t('persist.load.loaded', {
              name: loaded.name,
              model: loaded.config.controller.model,
              time: loaded.config.savedAt,
              cards: loaded.config.receivers.length,
            })}
          </p>
          {loaded.config.moduleLibrary && loaded.config.moduleLibrary.length > 0 && (
            <div className="row">
              <button type="button" onClick={importLibrary}>
                {t('persist.load.importLibrary', { count: loaded.config.moduleLibrary.length })}
              </button>
            </div>
          )}
          <div className="row">
            <button type="button" disabled={connectedId === null || comparing} onClick={() => void compare()}>
              {comparing ? t('persist.load.comparing') : t('persist.load.compare')}
            </button>
          </div>
        </div>
      )}

      {loaded && compared && (
        <div data-testid="compare-result">
          {mismatch && (
            <>
              <p className="field-error" role="alert">
                {t('persist.load.modelMismatch', { file: loaded.config.controller.model, device: compared.current.config.controller.model })}
              </p>
              <label>
                <input type="checkbox" checked={allowModel} onChange={(e) => setAllowModel(e.target.checked)} /> {t('persist.load.allowModel')}
              </label>
            </>
          )}
          {missing.length > 0 && (
            <>
              <p className="field-error" role="alert">
                {t('persist.load.missingCards', { cards: missing.map((m) => `${m.portIndex + 1}/${m.cardIndex + 1}`).join(', ') })}
              </p>
              <label>
                <input type="checkbox" checked={skipMissing} onChange={(e) => setSkipMissing(e.target.checked)} /> {t('persist.load.skipMissing')}
              </label>
            </>
          )}
          {compared.diff.skippedCards.map((s) => (
            <p key={`${s.portIndex}:${s.cardIndex}`} className="muted">
              {t('persist.load.skippedCards', {
                port: s.portIndex + 1,
                card: s.cardIndex + 1,
                reason: t(`persist.reason.${s.reason}` as MessageKey),
              })}
            </p>
          ))}
          {!compared.current.complete && <p className="muted">{t('persist.load.readIncomplete')}</p>}

          <fieldset>
            <legend>{t('persist.load.parts')}</legend>
            {PART_KEYS.map((k) => (
              <label key={k} style={{ marginRight: 16 }}>
                <input
                  type="checkbox"
                  checked={parts[k]}
                  onChange={(e) => setParts((p) => ({ ...p, [k]: e.target.checked }))}
                />{' '}
                {t(`persist.load.part.${k}` as MessageKey)}
              </label>
            ))}
          </fieldset>

          {selectedItems.length === 0 ? (
            <p data-testid="up-to-date">{t('persist.load.upToDate')}</p>
          ) : (
            <>
              <p>{t('persist.load.changes', { count: selectedItems.length })}</p>
              <DiffTable items={selectedItems} />
            </>
          )}

          <label>
            <input type="checkbox" checked={saveAfter} onChange={(e) => setSaveAfter(e.target.checked)} /> {t('persist.load.saveAfter')}
          </label>
          {!advanced && <p className="muted">{t('persist.advancedOnly')}</p>}
          <div className="row">
            <button type="button" className="primary" disabled={!canApply} onClick={() => setConfirming(true)}>
              {applying ? t('persist.load.applying') : t('persist.load.apply')}
            </button>
          </div>
        </div>
      )}

      {applied && (
        <div data-testid="apply-result">
          {applied.ok ? (
            <p>{t('persist.load.applied', { count: applied.steps.filter((s) => s.status === 'written').length })}</p>
          ) : (
            <p className="field-error" role="alert">
              {t('persist.load.failedAt', { step: applied.failedStep ? stepLabel(applied.failedStep) : '' })}
              {applied.failedStep?.message ? ` ${applied.failedStep.message}` : ''}
            </p>
          )}
          <StepList steps={applied.steps} />
        </div>
      )}

      {confirming && (
        <ConfirmDialog title={t('persist.load.applyConfirmTitle')} onConfirm={() => void apply()} onCancel={() => setConfirming(false)}>
          <p>{t('persist.load.applyConfirmBody', { count: selectedItems.length })}</p>
          {saveAfter && <p>{t('persist.load.applyConfirmSave')}</p>}
        </ConfirmDialog>
      )}
    </div>
  );
}
