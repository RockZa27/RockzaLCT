import { useEffect, useState } from 'react';
import {
  COEFFICIENT_REGION,
  buildCoefficientFile,
  coefficientIoFromApi,
  downloadCoefficients,
  serializeCoefficientFile,
  validateCoefficientRange,
} from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';
import { useApp } from '../../state/AppContext';
import { coefficientFileName, downloadTextFile } from './fileIo';
import { ProgressBar } from './ProgressBar';
import { failureReason } from './reason';
import type { CardRef } from './StateSection';
import { useTransfer } from './useTransfer';

/** Read the card's coefficient memory block by block and save it as a coefficient file. Allowed at the normal level. */
export function DownloadSection({ card, onBusy }: { card: CardRef | null; onBusy(busy: boolean): void }) {
  const { t } = useI18n();
  const { api, connectedId, info } = useApp();
  const [offset, setOffset] = useState('0');
  const [length, setLength] = useState(String(COEFFICIENT_REGION.sizeBytes));
  const [message, setMessage] = useState('');
  const transfer = useTransfer();
  const running = transfer.progress !== null;
  useEffect(() => {
    onBusy(running);
    return () => onBusy(false);
  }, [running, onBusy]);

  const start = async () => {
    if (!connectedId || !card) return;
    const off = Number(offset);
    const len = Number(length);
    if (validateCoefficientRange(off, len) !== null) {
      setMessage(t('cal.dl.invalidRange', { size: COEFFICIENT_REGION.sizeBytes }));
      return;
    }
    setMessage('');
    const options = transfer.start('download', len);
    try {
      const io = coefficientIoFromApi(api, connectedId, card.portIndex, card.cardIndex);
      const res = await downloadCoefficients(io, off, len, options);
      if (res.ok) {
        const file = buildCoefficientFile({
          controller: { model: info?.model ?? '', firmwareVersion: info?.firmwareVersion ?? '' },
          portIndex: card.portIndex,
          cardIndex: card.cardIndex,
          offset: off,
          data: res.data,
        });
        const name = coefficientFileName(card.portIndex, card.cardIndex);
        downloadTextFile(name, serializeCoefficientFile(file));
        setMessage(t('cal.dl.done', { bytes: len, file: name }));
      } else if (res.failed) {
        setMessage(t('cal.dl.failed', { offset: res.failed.offset, reason: failureReason(t, res.failed) }));
      } else {
        setMessage(t('cal.dl.stopped', { done: res.doneBytes, total: len }));
      }
    } finally {
      transfer.stop();
    }
  };

  const disabled = !connectedId || !card || running;
  return (
    <div className="card" role="group" aria-label={t('cal.dl.title')}>
      <h2>{t('cal.dl.title')}</h2>
      <p className="muted">{t('cal.dl.desc')}</p>
      <label className="field">
        {t('cal.dl.offset')}
        <input type="number" min={0} step={1} value={offset} disabled={disabled} onChange={(e) => setOffset(e.target.value)} />
      </label>
      <label className="field">
        {t('cal.dl.length')}
        <input type="number" min={1} step={1} value={length} disabled={disabled} onChange={(e) => setLength(e.target.value)} />
      </label>
      <div className="row">
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setOffset('0');
            setLength(String(COEFFICIENT_REGION.sizeBytes));
          }}
        >
          {t('cal.dl.full', { size: COEFFICIENT_REGION.sizeBytes })}
        </button>
        <button type="button" className="primary" disabled={disabled} onClick={() => void start()}>
          {t('cal.dl.button')}
        </button>
      </div>
      {transfer.progress && <ProgressBar progress={transfer.progress} onCancel={transfer.cancel} />}
      {message && (
        <p role="status" data-testid="cal-dl-result">
          {message}
        </p>
      )}
    </div>
  );
}
