import { useEffect, useState } from 'react';
import { COEFFICIENT_REGION, type CoefficientSet } from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';
import type { MessageKey } from '../../i18n/dictionary';
import { useApp } from '../../state/AppContext';
import { backupCard } from './backup';
import { ConfirmDialog } from './ConfirmDialog';
import { ProgressBar } from './ProgressBar';
import { failureReason } from './reason';
import type { CardRef } from './StateSection';
import { useTransfer } from './useTransfer';

type Action = 'save' | 'reload' | 'erase';

/**
 * Store the active coefficients to flash, reload them from flash, or erase the flash copy (advanced
 * level only). Store and erase overwrite the flash copy for good, so they stay disabled until the
 * coefficients of THIS card were downloaded to a file in this session (`backedUp`); erase also needs
 * the card position typed in.
 */
export function FlashSection({
  card,
  backedUp,
  onBackedUp,
  onBusy,
}: {
  card: CardRef | null;
  backedUp: boolean;
  onBackedUp(card: CardRef, range: { offset: number; length: number }): void;
  onBusy(busy: boolean): void;
}) {
  const { t } = useI18n();
  const { api, connectedId, info, level, run, pushInfo } = useApp();
  const advanced = level === 'advanced';
  const [set, setSet] = useState<CoefficientSet>('standard');
  const [pending, setPending] = useState<Action | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const transfer = useTransfer();
  const running = transfer.progress !== null;
  useEffect(() => {
    onBusy(running);
    return () => onBusy(false);
  }, [running, onBusy]);

  const target = card ? t('cal.target.card', { port: card.portIndex + 1, card: card.cardIndex + 1 }) : '';
  const code = card ? `${card.portIndex + 1}-${card.cardIndex + 1}` : '';
  const setText = t(`cal.flash.set.${set}` as MessageKey);

  const open = (action: Action) => {
    setTyped('');
    setPending(action);
  };

  const execute = async () => {
    const action = pending;
    setPending(null);
    if (!action || !connectedId || !card) return;
    setBusy(true);
    try {
      const ok = await run(async () => {
        if (action === 'save') await api.saveCoefficientsToFlash(connectedId, card.portIndex, card.cardIndex, set);
        else if (action === 'reload') await api.reloadCoefficientsFromFlash(connectedId, card.portIndex, card.cardIndex, set);
        else await api.eraseCoefficientsInFlash(connectedId, card.portIndex, card.cardIndex);
        return true;
      });
      if (ok) pushInfo(t('cal.flash.done', { target }));
    } finally {
      setBusy(false);
    }
  };

  const backUpNow = async () => {
    if (!connectedId || !card) return;
    setMessage('');
    const options = transfer.start('download', COEFFICIENT_REGION.sizeBytes);
    try {
      const { result, fileName } = await backupCard(api, connectedId, info, card, 0, COEFFICIENT_REGION.sizeBytes, options);
      if (result.ok && fileName) {
        onBackedUp(card, { offset: 0, length: COEFFICIENT_REGION.sizeBytes });
        setMessage(t('cal.dl.done', { bytes: COEFFICIENT_REGION.sizeBytes, file: fileName }));
      } else if (result.failed) {
        setMessage(t('cal.dl.failed', { offset: result.failed.offset, reason: failureReason(t, result.failed) }));
      } else {
        setMessage(t('cal.dl.stopped', { done: result.doneBytes, total: COEFFICIENT_REGION.sizeBytes }));
      }
    } finally {
      transfer.stop();
    }
  };

  const disabled = !advanced || !connectedId || !card || busy || running;
  const gated = disabled || !backedUp;
  return (
    <div className="card" role="group" aria-label={t('cal.flash.title')}>
      <h2>{t('cal.flash.title')}</h2>
      <p className="muted">{t('cal.flash.desc')}</p>
      {!advanced && <p className="muted">{t('cal.advancedOnly')}</p>}
      <label className="field">
        {t('cal.flash.set')}
        <select value={set} disabled={disabled} onChange={(e) => setSet(e.target.value as CoefficientSet)}>
          <option value="standard">{t('cal.flash.set.standard')}</option>
          <option value="multi-layer">{t('cal.flash.set.multi-layer')}</option>
        </select>
      </label>
      {advanced && !backedUp && (
        <p className="field-error" data-testid="cal-needs-backup">
          {t('cal.flash.needBackup', { target })}
        </p>
      )}
      <div className="row">
        <button type="button" disabled={gated} title={backedUp ? undefined : t('cal.flash.needBackup', { target })} onClick={() => open('save')}>
          {t('cal.flash.save')}
        </button>
        <button type="button" disabled={disabled} onClick={() => open('reload')}>
          {t('cal.flash.reload')}
        </button>
        <button type="button" disabled={gated} title={backedUp ? undefined : t('cal.flash.needBackup', { target })} onClick={() => open('erase')}>
          {t('cal.flash.erase')}
        </button>
        {!backedUp && (
          <button type="button" className="primary" disabled={disabled} onClick={() => void backUpNow()}>
            {t('cal.flash.backupNow')}
          </button>
        )}
      </div>
      {transfer.progress && <ProgressBar progress={transfer.progress} onCancel={transfer.cancel} />}
      {message && (
        <p role="status" data-testid="cal-flash-backup-result">
          {message}
        </p>
      )}

      {pending === 'save' && (
        <ConfirmDialog title={t('cal.flash.saveTitle')} onCancel={() => setPending(null)} onConfirm={() => void execute()}>
          <p>{t('cal.flash.saveBody', { target, set: setText })}</p>
        </ConfirmDialog>
      )}
      {pending === 'reload' && (
        <ConfirmDialog title={t('cal.flash.reloadTitle')} onCancel={() => setPending(null)} onConfirm={() => void execute()}>
          <p>{t('cal.flash.reloadBody', { target, set: setText })}</p>
        </ConfirmDialog>
      )}
      {pending === 'erase' && (
        <ConfirmDialog
          title={t('cal.flash.eraseTitle')}
          onCancel={() => setPending(null)}
          onConfirm={() => void execute()}
          confirmDisabled={typed.trim() !== code}
        >
          <p>{t('cal.flash.eraseBody', { target })}</p>
          <p className="muted">{t('cal.flash.eraseUnverified')}</p>
          <label>
            {t('cal.flash.typeConfirm', { code })}
            <input type="text" value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
          </label>
        </ConfirmDialog>
      )}
    </div>
  );
}
