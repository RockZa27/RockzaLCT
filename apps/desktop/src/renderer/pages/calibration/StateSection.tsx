import { useCallback, useEffect, useState } from 'react';
import type { CalibrationCardState, CalibrationType, ReceiverTarget } from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';
import type { MessageKey } from '../../i18n/dictionary';
import { useApp } from '../../state/AppContext';

export interface CardRef {
  portIndex: number;
  cardIndex: number;
}

/** Read the calibration state of the selected card and switch calibration on / off (both allowed at the normal level). */
export function StateSection({ card }: { card: CardRef | null }) {
  const { t } = useI18n();
  const { api, connectedId, run, pushInfo } = useApp();
  const [state, setState] = useState<CalibrationCardState | null>(null);
  const [loading, setLoading] = useState(false);
  const [type, setType] = useState<CalibrationType>('chroma');
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!connectedId || !card) return;
    setLoading(true);
    try {
      const s = await run(() => api.getCalibrationState(connectedId, card.portIndex, card.cardIndex));
      if (s) {
        setState(s);
        setType(s.type);
      }
    } finally {
      setLoading(false);
    }
  }, [api, connectedId, card, run]);

  useEffect(() => {
    setState(null);
    void load();
  }, [load]);

  const apply = async (enabled: boolean) => {
    if (!connectedId || !card) return;
    const target: ReceiverTarget = all
      ? { scope: 'all' }
      : { scope: 'card', portIndex: card.portIndex, cardIndex: card.cardIndex };
    setBusy(true);
    try {
      const ok = await run(async () => {
        await api.setCalibrationEnabled(connectedId, target, enabled, enabled ? type : undefined);
        return true;
      });
      if (ok) {
        const where = all
          ? t('cal.target.all')
          : t('cal.target.card', { port: card.portIndex + 1, card: card.cardIndex + 1 });
        pushInfo(t(enabled ? 'cal.enable.onDone' : 'cal.enable.offDone', { target: where }));
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  const dash = t('cal.unavailable');
  const disabled = !connectedId || !card;

  return (
    <>
      <div className="card" data-testid="cal-state">
        <div className="row">
          <h2>{t('cal.state.title')}</h2>
          <button type="button" disabled={disabled || loading} onClick={() => void load()}>
            {loading ? t('cal.state.loading') : t('cal.state.reload')}
          </button>
        </div>
        {state && (
          <dl className="kv">
            <dt>{t('cal.state.enabled')}</dt>
            <dd data-testid="cal-enabled">{t(state.enabled ? 'cal.state.on' : 'cal.state.off')}</dd>
            <dt>{t('cal.state.type')}</dt>
            <dd data-testid="cal-type">{t(`cal.type.${state.type}` as MessageKey)}</dd>
            <dt>{t('cal.state.source')}</dt>
            <dd data-testid="cal-source">
              {state.coefficientSource ? t(`cal.source.${state.coefficientSource}` as MessageKey) : dash}
            </dd>
            <dt>{t('cal.state.data')}</dt>
            <dd data-testid="cal-data">
              {state.coefficientData ? t(`cal.data.${state.coefficientData}` as MessageKey) : dash}
            </dd>
            <dt>{t('cal.state.raw')}</dt>
            <dd data-testid="cal-raw">0x{state.stateRaw.toString(16).toUpperCase().padStart(2, '0')}</dd>
          </dl>
        )}
        <p className="muted">{t('cal.state.unverified')}</p>
      </div>

      <div className="card" role="group" aria-label={t('cal.enable.title')}>
        <h2>{t('cal.enable.title')}</h2>
        <label className="field">
          {t('cal.enable.type')}
          <select value={type} disabled={disabled} onChange={(e) => setType(e.target.value as CalibrationType)}>
            <option value="chroma">{t('cal.type.chroma')}</option>
            <option value="brightness">{t('cal.type.brightness')}</option>
          </select>
        </label>
        <label className="row">
          <input type="checkbox" checked={all} disabled={disabled} onChange={(e) => setAll(e.target.checked)} />
          {t('cal.enable.all')}
        </label>
        <div className="row">
          <button type="button" className="primary" disabled={disabled || busy} onClick={() => void apply(true)}>
            {t('cal.enable.on')}
          </button>
          <button type="button" disabled={disabled || busy} onClick={() => void apply(false)}>
            {t('cal.enable.off')}
          </button>
        </div>
      </div>
    </>
  );
}
