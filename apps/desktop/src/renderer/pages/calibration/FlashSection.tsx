import { useState } from 'react';
import type { CoefficientSet } from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';
import type { MessageKey } from '../../i18n/dictionary';
import { useApp } from '../../state/AppContext';
import { ConfirmDialog } from './ConfirmDialog';
import type { CardRef } from './StateSection';

type Action = 'save' | 'reload' | 'erase';

/** Store the active coefficients to flash, reload them from flash, or erase the flash copy (advanced level only). */
export function FlashSection({ card }: { card: CardRef | null }) {
  const { t } = useI18n();
  const { api, connectedId, level, run, pushInfo } = useApp();
  const advanced = level === 'advanced';
  const [set, setSet] = useState<CoefficientSet>('standard');
  const [pending, setPending] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);

  const target = card ? t('cal.target.card', { port: card.portIndex + 1, card: card.cardIndex + 1 }) : '';
  const setText = t(`cal.flash.set.${set}` as MessageKey);

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

  const disabled = !advanced || !connectedId || !card || busy;
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
      <div className="row">
        <button type="button" disabled={disabled} onClick={() => setPending('save')}>
          {t('cal.flash.save')}
        </button>
        <button type="button" disabled={disabled} onClick={() => setPending('reload')}>
          {t('cal.flash.reload')}
        </button>
        <button type="button" disabled={disabled} onClick={() => setPending('erase')}>
          {t('cal.flash.erase')}
        </button>
      </div>

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
        <ConfirmDialog title={t('cal.flash.eraseTitle')} onCancel={() => setPending(null)} onConfirm={() => void execute()}>
          <p>{t('cal.flash.eraseBody', { target })}</p>
          <p className="muted">{t('cal.flash.eraseUnverified')}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
