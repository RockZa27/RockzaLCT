import { useEffect, useState } from 'react';
import type { BrightnessState } from '@rockzalct/shared';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/dictionary';
import { useApp } from '../state/AppContext';

type Channel = keyof BrightnessState;

const CHANNELS: { key: Channel; label: MessageKey }[] = [
  { key: 'percent', label: 'bri.global' },
  { key: 'red', label: 'bri.red' },
  { key: 'green', label: 'bri.green' },
  { key: 'blue', label: 'bri.blue' },
];

const clamp = (n: number) => Math.min(100, Math.max(0, Math.round(n)));

export function BrightnessPage() {
  const { t } = useI18n();
  const { api, connectedId, info, level, run, pushInfo } = useApp();
  // H series (one brightness per screen) and Taurus have no RGB gain: only the global slider is shown.
  const hseries = info?.family === 'hseries';
  const taurus = info?.family === 'taurus';
  const percentOnly = hseries || taurus;
  const channels = percentOnly ? CHANNELS.filter((c) => c.key === 'percent') : CHANNELS;
  const [values, setValues] = useState<BrightnessState>({ percent: 0, red: 100, green: 100, blue: 100 });
  const [readback, setReadback] = useState<BrightnessState | null>(null);
  const [busy, setBusy] = useState(false);
  const disabled = connectedId === null;

  // Load the device's current values whenever a controller becomes active.
  useEffect(() => {
    setReadback(null);
    if (!connectedId) return;
    let cancelled = false;
    void run(() => api.getBrightness(connectedId)).then((b) => {
      if (b && !cancelled) {
        setValues(b);
        setReadback(b);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [api, connectedId, run]);

  const set = (key: Channel, raw: string) => {
    if (raw === '') return;
    const n = Number(raw);
    if (Number.isNaN(n)) return;
    setValues((v) => ({ ...v, [key]: clamp(n) }));
  };

  const apply = async () => {
    if (!connectedId) return;
    setBusy(true);
    try {
      const result = await run(async () => {
        await api.setBrightness(connectedId, percentOnly ? { percent: values.percent } : values);
        return api.getBrightness(connectedId);
      });
      if (result) {
        setReadback(result);
        pushInfo(t('bri.applied'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h1>{t('bri.title')}</h1>
      {disabled && <p className="muted">{t('bri.needConnect')}</p>}
      {hseries && <p className="muted">{t('bri.hseriesNote')}</p>}
      {taurus && <p className="muted">{t('bri.taurusNote')}</p>}
      {percentOnly && level !== 'advanced' && (
        <p className="muted" data-testid="advanced-note">
          {t('hs.advancedOnly')}
        </p>
      )}

      <div className="card">
        {channels.map(({ key, label }) => (
          <div className="slider-row" key={key}>
            <span className="slider-label">{t(label)}</span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={values[key]}
              disabled={disabled}
              aria-label={t(label)}
              onChange={(e) => set(key, e.target.value)}
            />
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              value={values[key]}
              disabled={disabled}
              aria-label={`${t(label)} (number)`}
              onChange={(e) => set(key, e.target.value)}
            />
          </div>
        ))}
        <div className="row">
          <button type="button" className="primary" disabled={disabled || busy} onClick={() => void apply()}>
            {t('bri.apply')}
          </button>
        </div>
      </div>

      {readback && (
        <div className="card" data-testid="readback">
          <h2>{t('bri.readback')}</h2>
          <dl className="kv">
            {channels.map(({ key, label }) => (
              <div className="kv-row" key={key}>
                <dt>{t(label)}</dt>
                <dd data-testid={`readback-${key}`}>{readback[key]}%</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </section>
  );
}
