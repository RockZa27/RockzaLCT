import { DEFAULT_HARDWARE_OVERRIDES, type HardwareOverrides, type ScannerXyOrder } from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';
import type { MessageKey } from '../../i18n/dictionary';
import { BIT_CHOICES, descKey, formatValue, labelKey, type OverrideMeta } from './meta';

/** One setting: label, UNVERIFIED tag, explanation, checklist step, current / default value and the editor. */
export function OverrideRow({
  meta,
  current,
  draft,
  onChange,
  disabled,
  error,
}: {
  meta: OverrideMeta;
  current: HardwareOverrides;
  /** Text of the editor (bytes: the typed number; bits: the mask; xy: the order). */
  draft: string;
  onChange(text: string): void;
  disabled: boolean;
  error: MessageKey | null;
}) {
  const { t } = useI18n();
  const { key } = meta;
  const label = t(labelKey(key));
  const isDefault = current[key] === DEFAULT_HARDWARE_OVERRIDES[key];
  const errId = `adv-err-${key}`;

  return (
    <div className="adv-row" data-testid={`adv-row-${key}`}>
      <div className="adv-head">
        <strong>{label}</strong>
        <span className="tag-unverified">{t('adv.unverified')}</span>
        {!isDefault && <span className="tag-modified">{t('adv.modified')}</span>}
      </div>
      <p className="muted adv-desc">{t(descKey(key))}</p>
      <p className="muted adv-desc" data-testid={`adv-step-${key}`}>
        {meta.steps === null ? t('adv.noStep') : t('adv.step', { steps: meta.steps })}
      </p>
      <div className="adv-values">
        <span>
          {t('adv.current')}: <b data-testid={`adv-current-${key}`}>{formatValue(meta, current[key], t)}</b>
        </span>
        <span>
          {t('adv.default')}: <span data-testid={`adv-default-${key}`}>{formatValue(meta, DEFAULT_HARDWARE_OVERRIDES[key], t)}</span>
        </span>
        <label className="adv-edit">
          <span>{t('adv.newValue')}</span>
          {meta.kind === 'byte' ? (
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={255}
              step={1}
              aria-label={label}
              aria-invalid={error !== null}
              aria-describedby={error ? errId : undefined}
              value={draft}
              disabled={disabled}
              onChange={(e) => onChange(e.target.value)}
            />
          ) : meta.kind === 'bit' ? (
            <select aria-label={label} aria-invalid={error !== null} aria-describedby={error ? errId : undefined} value={draft} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
              {BIT_CHOICES.map((b) => (
                <option key={b} value={String(b)}>
                  {formatValue(meta, b, t)}
                </option>
              ))}
            </select>
          ) : (
            <select aria-label={label} aria-invalid={error !== null} aria-describedby={error ? errId : undefined} value={draft} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
              {(['x-high', 'x-low'] as ScannerXyOrder[]).map((o) => (
                <option key={o} value={o}>
                  {formatValue(meta, o, t)}
                </option>
              ))}
            </select>
          )}
        </label>
      </div>
      {error && (
        <p id={errId} className="field-error" role="alert">
          {t(error)}
        </p>
      )}
    </div>
  );
}
