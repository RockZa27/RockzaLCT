import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_HARDWARE_OVERRIDES,
  diffHardwareOverrides,
  mergeHardwareOverrides,
  validateHardwareOverrides,
  type HardwareOverrideKey,
  type HardwareOverrides,
} from '@rockzalct/shared';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/dictionary';
import { useApp } from '../state/AppContext';
import { ChangeList } from './advanced/ChangeList';
import { FileSection } from './advanced/FileSection';
import { OverrideRow } from './advanced/OverrideRow';
import { GROUP_ORDER, OVERRIDE_META, groupKey, type OverrideMeta } from './advanced/meta';
import { ConfirmDialog } from './persist/ConfirmDialog';

type Draft = Record<HardwareOverrideKey, string>;

const toDraft = (v: HardwareOverrides): Draft =>
  Object.fromEntries(OVERRIDE_META.map((m) => [m.key, String(v[m.key])])) as Draft;

/** The typed text as a value; a blank or non-numeric byte/bit becomes NaN so validation rejects it. */
const parseDraft = (meta: OverrideMeta, text: string): number | string =>
  meta.kind === 'xy' ? text : text.trim() === '' ? NaN : Number(text);

/**
 * Values the protocol code could not verify on real hardware, editable without a rebuild. Applies
 * to MCTRL / VX only; shown for every family so the owner can find it (it says so for H series / Taurus).
 */
export function AdvancedSettingsPage() {
  const { t } = useI18n();
  const { api, info, level, run, pushInfo } = useApp();
  const advanced = level === 'advanced';
  const [current, setCurrent] = useState<HardwareOverrides | null>(null);
  const [draft, setDraft] = useState<Draft>(() => toDraft(DEFAULT_HARDWARE_OVERRIDES));
  const [confirm, setConfirm] = useState<'save' | 'reset' | null>(null);
  const [busy, setBusy] = useState(false);

  const adopt = useCallback((values: HardwareOverrides) => {
    setCurrent(values);
    setDraft(toDraft(values));
  }, []);

  useEffect(() => {
    let alive = true;
    void run(() => api.getHardwareOverrides()).then((values) => {
      if (alive && values) adopt(values);
    });
    return () => {
      alive = false;
    };
  }, [api, run, adopt]);

  /** Only the values that differ from the current ones, and what the validator says about the result. */
  const edit = useMemo(() => {
    if (!current) return null;
    const partial: Record<string, number | string> = {};
    for (const m of OVERRIDE_META) {
      const v = parseDraft(m, draft[m.key]);
      if (!Object.is(v, current[m.key])) partial[m.key] = v;
    }
    const merged = mergeHardwareOverrides(current, partial as Partial<HardwareOverrides>);
    const errors = validateHardwareOverrides(merged);
    const fieldError = (m: OverrideMeta): MessageKey | null => {
      if (errors.some((e) => e.startsWith(`${m.key}:`))) {
        return m.kind === 'byte' ? 'adv.err.byte' : m.kind === 'bit' ? 'adv.err.bit' : 'adv.err.xy';
      }
      return m.key === 'correctionBrightnessTypeBit' && errors.some((e) => e.startsWith('correctionEnabledBit and'))
        ? 'adv.err.sameBit'
        : null;
    };
    const changes = errors.length === 0 ? diffHardwareOverrides(current, merged) : [];
    const patch = Object.fromEntries(changes.map((c) => [c.key, c.to])) as Partial<HardwareOverrides>;
    return { errors, fieldError, changes, patch };
  }, [current, draft]);

  const toDefaults = useMemo(
    () => (current ? diffHardwareOverrides(current, DEFAULT_HARDWARE_OVERRIDES) : []),
    [current],
  );

  const apply = async (call: () => Promise<HardwareOverrides>, doneText: string) => {
    setConfirm(null);
    setBusy(true);
    try {
      const values = await run(call);
      if (values) {
        adopt(values);
        pushInfo(doneText);
      }
    } finally {
      setBusy(false);
    }
  };

  const onSave = () => {
    if (!edit) return;
    if (edit.changes.length === 0) pushInfo(t('adv.noChanges'));
    else setConfirm('save');
  };
  const onReset = () => {
    if (toDefaults.length === 0) pushInfo(t('adv.resetNothing'));
    else setConfirm('reset');
  };

  const otherFamily = info !== null && (info.family === 'hseries' || info.family === 'taurus');

  return (
    <section>
      <h1>{t('adv.title')}</h1>
      <div className="card">
        <p className="muted">{t('adv.intro')}</p>
        <p data-testid="adv-scope">{t(otherFamily ? 'adv.scope.other' : 'adv.scope.mctrl')}</p>
        {!advanced && (
          <p className="muted" data-testid="adv-need-login">
            {t('adv.needLogin')}
          </p>
        )}
      </div>

      {!current || !edit ? (
        <p className="muted">{t('adv.loading')}</p>
      ) : (
        <>
          {GROUP_ORDER.map((group) => (
            <div className="card" key={group} role="group" aria-label={t(groupKey(group))}>
              <h2>{t(groupKey(group))}</h2>
              {OVERRIDE_META.filter((m) => m.group === group).map((m) => (
                <OverrideRow
                  key={m.key}
                  meta={m}
                  current={current}
                  draft={draft[m.key]}
                  onChange={(text) => setDraft((d) => ({ ...d, [m.key]: text }))}
                  disabled={!advanced || busy}
                  error={edit.fieldError(m)}
                />
              ))}
            </div>
          ))}
          <div className="row">
            <button type="button" className="primary" disabled={!advanced || busy || edit.errors.length > 0} onClick={onSave}>
              {t('adv.save')}
            </button>
            <button type="button" disabled={busy || (edit.changes.length === 0 && edit.errors.length === 0)} onClick={() => setDraft(toDraft(current))}>
              {t('adv.revert')}
            </button>
            <button type="button" disabled={!advanced || busy} onClick={onReset}>
              {t('adv.reset')}
            </button>
          </div>
          <FileSection
            current={current}
            advanced={advanced}
            busy={busy}
            onImport={(values) => apply(() => api.setHardwareOverrides(values), t('adv.file.imported'))}
          />
        </>
      )}

      {confirm === 'save' && edit && (
        <ConfirmDialog
          title={t('adv.saveTitle')}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void apply(() => api.setHardwareOverrides(edit.patch), t('adv.saved'))}
        >
          <p>{t('adv.saveBody')}</p>
          <ChangeList changes={edit.changes} testId="adv-save-changes" />
        </ConfirmDialog>
      )}
      {confirm === 'reset' && (
        <ConfirmDialog
          title={t('adv.resetTitle')}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void apply(() => api.resetHardwareOverrides(), t('adv.resetDone'))}
        >
          <p>{t('adv.resetBody')}</p>
          <ChangeList changes={toDefaults} testId="adv-reset-changes" />
        </ConfirmDialog>
      )}
    </section>
  );
}
