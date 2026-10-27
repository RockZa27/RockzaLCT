import { useEffect, useMemo, useState } from 'react';
import type { ReceiverTarget, SaveToHardwareResult } from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';
import { useApp } from '../../state/AppContext';
import { ConfirmDialog } from './ConfirmDialog';

/** PLAN.md phase 6: make the cards' current parameters permanent (flash). Advanced only. */
export function SaveSection() {
  const { t } = useI18n();
  const { api, connectedId, info, level, run, pushInfo } = useApp();
  const advanced = level === 'advanced';
  const cards = useMemo(() => info?.receivingCards ?? [], [info]);

  const [target, setTarget] = useState('all');
  const [includeSender, setIncludeSender] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SaveToHardwareResult | null>(null);

  useEffect(() => {
    setTarget('all');
    setIncludeSender(true);
    setConfirming(false);
    setResult(null);
  }, [connectedId]);

  const receiverTarget = (): ReceiverTarget => {
    if (target === 'all') return { scope: 'all' };
    const [portIndex, cardIndex] = target.split(':').map(Number) as [number, number];
    return { scope: 'card', portIndex, cardIndex };
  };

  const targetText = (): string => {
    const tg = receiverTarget();
    return tg.scope === 'all'
      ? t('persist.save.targetAll')
      : t('persist.save.targetCard', { port: tg.portIndex + 1, card: tg.cardIndex + 1 });
  };

  const save = async () => {
    setConfirming(false);
    if (!connectedId) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await run(() => api.saveToHardware(connectedId, receiverTarget(), { includeSender }));
      if (res) {
        setResult(res);
        if (res.ok) pushInfo(t('persist.save.ok', { count: res.cards.length }));
      }
    } finally {
      setBusy(false);
    }
  };

  const disabled = connectedId === null || !advanced || busy;
  const failures = result ? [...result.cards.filter((c) => !c.ok)] : [];

  return (
    <div className="card" aria-labelledby="persist-save-title" role="group">
      <h2 id="persist-save-title">{t('persist.save.title')}</h2>
      <p className="muted">{t('persist.save.desc')}</p>
      <label className="field">
        {t('persist.save.target')}
        <select
          value={target}
          disabled={connectedId === null || busy}
          onChange={(e) => {
            setTarget(e.target.value);
            setIncludeSender(e.target.value === 'all');
          }}
        >
          <option value="all">{t('persist.save.all')}</option>
          {cards.map((c) => (
            <option key={`${c.portIndex}:${c.cardIndex}`} value={`${c.portIndex}:${c.cardIndex}`}>
              {t('persist.save.card', { port: c.portIndex + 1, card: c.cardIndex + 1 })}
            </option>
          ))}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={includeSender}
          disabled={connectedId === null || busy}
          onChange={(e) => setIncludeSender(e.target.checked)}
        />{' '}
        {t('persist.save.includeSender')}
      </label>
      {!advanced && <p className="muted">{t('persist.advancedOnly')}</p>}
      <p className="muted">{t('persist.save.unverified')}</p>
      <div className="row">
        <button type="button" className="primary" disabled={disabled} onClick={() => setConfirming(true)}>
          {busy ? t('persist.save.running') : t('persist.save.button')}
        </button>
      </div>

      {result && (
        <div data-testid="save-result">
          {result.ok ? (
            <p>
              {t('persist.save.ok', { count: result.cards.length })}
              {result.sender?.ok ? ` ${t('persist.save.senderOk')}` : ''}
            </p>
          ) : (
            <>
              <p className="field-error" role="alert">
                {t('persist.save.partial')}
              </p>
              <ul>
                {failures.map((f) => (
                  <li key={`${f.portIndex}:${f.cardIndex}`}>
                    {t('persist.save.cardFailed', { port: f.portIndex === undefined ? '' : f.portIndex + 1, card: f.cardIndex === undefined ? '' : f.cardIndex + 1, message: f.message ?? '' })}
                  </li>
                ))}
                {result.sender && !result.sender.ok && (
                  <li>{t('persist.save.senderFailed', { message: result.sender.message ?? '' })}</li>
                )}
              </ul>
            </>
          )}
        </div>
      )}

      {confirming && (
        <ConfirmDialog title={t('persist.save.confirmTitle')} onConfirm={() => void save()} onCancel={() => setConfirming(false)}>
          <p>{t('persist.save.confirmBody', { target: targetText() })}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
