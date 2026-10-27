import { useState } from 'react';
import { DEFAULT_MONITOR_THRESHOLDS, validateThresholds, type MonitorThresholds } from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';
import type { MonitorSettings } from './settings';

type Fields = { [K in keyof MonitorThresholds]: string };

const toFields = (t: MonitorThresholds): Fields => ({
  temperatureWarnRaw: t.temperatureWarnRaw === null ? '' : String(t.temperatureWarnRaw),
  temperatureCriticalRaw: t.temperatureCriticalRaw === null ? '' : String(t.temperatureCriticalRaw),
  voltageLowRaw: t.voltageLowRaw === null ? '' : String(t.voltageLowRaw),
  voltageHighRaw: t.voltageHighRaw === null ? '' : String(t.voltageHighRaw),
});

/** Empty -> null (limit off); anything else -> a number (NaN if it is not numeric, caught by validation). */
const parseField = (s: string): number | null => (s.trim() === '' ? null : Number(s));

export function SettingsPanel({
  settings,
  onChange,
  onSaved,
}: {
  settings: MonitorSettings;
  onChange(next: MonitorSettings): void;
  onSaved(): void;
}) {
  const { t } = useI18n();
  const [fields, setFields] = useState<Fields>(() => toFields(settings.thresholds));
  const [funcAddr, setFuncAddr] = useState(settings.functionCardAddress === null ? '' : String(settings.functionCardAddress));
  const [problems, setProblems] = useState<string[]>([]);

  const save = (): void => {
    const thresholds: MonitorThresholds = {
      temperatureWarnRaw: parseField(fields.temperatureWarnRaw),
      temperatureCriticalRaw: parseField(fields.temperatureCriticalRaw),
      voltageLowRaw: parseField(fields.voltageLowRaw),
      voltageHighRaw: parseField(fields.voltageHighRaw),
    };
    const errors = validateThresholds(thresholds);
    const addr = parseField(funcAddr);
    if (addr !== null && (!Number.isInteger(addr) || addr < 0 || addr > 255)) {
      errors.push('functionCardAddress must be an integer 0..255 or empty');
    }
    setProblems(errors);
    if (errors.length > 0) return;
    onChange({ ...settings, thresholds, functionCardAddress: addr });
    onSaved();
  };

  const reset = (): void => {
    setFields(toFields(DEFAULT_MONITOR_THRESHOLDS));
    setProblems([]);
    onChange({ ...settings, thresholds: { ...DEFAULT_MONITOR_THRESHOLDS } });
    onSaved();
  };

  const input = (key: keyof Fields, label: string) => (
    <label className="field">
      {label}
      <input
        type="number"
        min={0}
        max={255}
        value={fields[key]}
        aria-label={label}
        onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
      />
    </label>
  );

  return (
    <div className="card" data-testid="monitor-settings">
      <h2>{t('monitor.settings')}</h2>
      <p className="muted">{t('monitor.settings.hint')}</p>
      <div className="mon-settings-grid">
        {input('temperatureWarnRaw', t('monitor.settings.tempWarn'))}
        {input('temperatureCriticalRaw', t('monitor.settings.tempCritical'))}
        {input('voltageLowRaw', t('monitor.settings.voltLow'))}
        {input('voltageHighRaw', t('monitor.settings.voltHigh'))}
        <label className="field">
          {t('monitor.settings.funcAddr')}
          <input
            type="number"
            min={0}
            max={255}
            value={funcAddr}
            aria-label={t('monitor.settings.funcAddr')}
            onChange={(e) => setFuncAddr(e.target.value)}
          />
        </label>
      </div>
      <label className="mon-check">
        <input
          type="checkbox"
          checked={settings.includeBitErrorRate}
          onChange={(e) => onChange({ ...settings, includeBitErrorRate: e.target.checked })}
        />
        {t('monitor.settings.ber')}
      </label>
      {problems.length > 0 && (
        <p className="field-error" role="alert" data-testid="settings-problems">
          {t('monitor.settings.invalid', { problems: problems.join('; ') })}
        </p>
      )}
      <div className="row">
        <button type="button" className="primary" onClick={save}>
          {t('monitor.settings.save')}
        </button>
        <button type="button" onClick={reset}>
          {t('monitor.settings.reset')}
        </button>
      </div>
    </div>
  );
}
