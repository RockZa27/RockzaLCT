import { useEffect, useState } from 'react';
import {
  buildCoefficientFile,
  checkCoefficientFileTarget,
  coefficientIoFromApi,
  downloadCoefficients,
  parseCoefficientFileJson,
  serializeCoefficientFile,
  uploadCoefficients,
  type CoefficientFile,
  type CoefficientTransferResult,
} from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';
import { useApp } from '../../state/AppContext';
import { ConfirmDialog } from './ConfirmDialog';
import { coefficientFileName, downloadTextFile, readFileText } from './fileIo';
import { ProgressBar } from './ProgressBar';
import { failureReason, hex } from './reason';
import type { CardRef } from './StateSection';
import { useTransfer } from './useTransfer';

interface Loaded {
  file: CoefficientFile;
  bytes: Uint8Array;
}

type Outcome =
  | { kind: 'ok'; bytes: number; port: number; card: number }
  | { kind: 'backup-failed'; reason: string }
  | { kind: 'partial'; reason: string; result: CoefficientTransferResult };

/**
 * Upload a coefficient file to the selected card (advanced level only). The default is to back the
 * card's current coefficients up to a file first; the backup must complete before anything is written.
 */
export function UploadSection({
  card,
  onBusy,
  onBackedUp,
}: {
  card: CardRef | null;
  onBusy(busy: boolean): void;
  onBackedUp(card: CardRef): void;
}) {
  const { t } = useI18n();
  const { api, connectedId, info, level } = useApp();
  const advanced = level === 'advanced';
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [fileError, setFileError] = useState('');
  const [allowOther, setAllowOther] = useState(false);
  const [backup, setBackup] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const transfer = useTransfer();
  const running = transfer.progress !== null;
  useEffect(() => {
    onBusy(running);
    return () => onBusy(false);
  }, [running, onBusy]);

  const mismatch = loaded && card ? checkCoefficientFileTarget(loaded.file, card.portIndex, card.cardIndex) : null;
  const canUpload = advanced && !!connectedId && !!card && !!loaded && (!mismatch || allowOther) && !running;

  const pick = async (file: File | undefined) => {
    setLoaded(null);
    setFileError('');
    setAllowOther(false);
    setOutcome(null);
    setNotes([]);
    if (!file) return;
    let text: string;
    try {
      text = await readFileText(file);
    } catch {
      setFileError(t('cal.up.invalid', { reason: file.name }));
      return;
    }
    const res = parseCoefficientFileJson(text);
    if (!res.ok) {
      setFileError(t('cal.up.invalid', { reason: res.errors.map((e) => e.message).join('; ') }));
      return;
    }
    setLoaded({ file: res.file, bytes: res.bytes });
  };

  const targetText = card ? t('cal.target.card', { port: card.portIndex + 1, card: card.cardIndex + 1 }) : '';

  const doUpload = async () => {
    setConfirming(false);
    if (!connectedId || !card || !loaded) return;
    const { offset, length } = loaded.file.region;
    const io = coefficientIoFromApi(api, connectedId, card.portIndex, card.cardIndex);
    const done: string[] = [];
    setOutcome(null);
    setNotes([]);
    try {
      if (backup) {
        const read = await downloadCoefficients(io, offset, length, transfer.start('backup', length));
        if (!read.ok) {
          setOutcome({
            kind: 'backup-failed',
            reason: read.failed ? failureReason(t, read.failed) : t('cal.up.cancelledReason'),
          });
          return;
        }
        const name = coefficientFileName(card.portIndex, card.cardIndex, 'backup');
        downloadTextFile(
          name,
          serializeCoefficientFile(
            buildCoefficientFile({
              controller: { model: info?.model ?? '', firmwareVersion: info?.firmwareVersion ?? '' },
              portIndex: card.portIndex,
              cardIndex: card.cardIndex,
              offset,
              data: read.data,
            }),
          ),
        );
        onBackedUp(card);
        done.push(t('cal.up.backupSaved', { file: name }));
        setNotes([...done]);
      }
      const result = await uploadCoefficients(io, offset, loaded.bytes, transfer.start('upload', length));
      if (result.ok) setOutcome({ kind: 'ok', bytes: length, port: card.portIndex, card: card.cardIndex });
      else {
        setOutcome({
          kind: 'partial',
          reason: result.failed ? failureReason(t, result.failed) : t('cal.up.cancelledReason'),
          result,
        });
      }
    } finally {
      transfer.stop();
    }
  };

  return (
    <div className="card" role="group" aria-label={t('cal.up.title')}>
      <h2>{t('cal.up.title')}</h2>
      <label className="field">
        {t('cal.up.file')}
        <input
          type="file"
          accept=".json,application/json"
          disabled={!connectedId || running}
          onChange={(e) => void pick(e.target.files?.[0])}
        />
      </label>
      {fileError && (
        <p className="field-error" role="alert" data-testid="cal-file-error">
          {fileError}
        </p>
      )}
      {loaded && (
        <p data-testid="cal-file-summary">
          {t('cal.up.summary', {
            when: loaded.file.savedAt,
            model: loaded.file.controller.model || '?',
            firmware: loaded.file.controller.firmwareVersion || '?',
            port: loaded.file.card.portIndex + 1,
            card: loaded.file.card.cardIndex + 1,
            offset: loaded.file.region.offset,
            bytes: loaded.file.region.length,
          })}
        </p>
      )}
      {mismatch && (
        <label className="row">
          <input type="checkbox" checked={allowOther} onChange={(e) => setAllowOther(e.target.checked)} />
          {t('cal.up.otherCard', { reason: mismatch })}
        </label>
      )}
      <label className="row">
        <input type="checkbox" checked={backup} disabled={running} onChange={(e) => setBackup(e.target.checked)} />
        {t('cal.up.backup')}
      </label>
      {!backup && <p className="field-error">{t('cal.up.noBackupWarn')}</p>}
      {!advanced && <p className="muted">{t('cal.advancedOnly')}</p>}
      <div className="row">
        <button type="button" className="primary" disabled={!canUpload} onClick={() => setConfirming(true)}>
          {t('cal.up.button')}
        </button>
      </div>

      {transfer.progress && <ProgressBar progress={transfer.progress} onCancel={transfer.cancel} />}
      {notes.map((n) => (
        <p key={n} role="status">
          {n}
        </p>
      ))}
      {outcome?.kind === 'ok' && (
        <p role="status" data-testid="cal-up-result">
          {t('cal.up.ok', { bytes: outcome.bytes, target: t('cal.target.card', { port: outcome.port + 1, card: outcome.card + 1 }) })}
        </p>
      )}
      {outcome?.kind === 'backup-failed' && (
        <p className="field-error" role="alert" data-testid="cal-up-result">
          {t('cal.up.backupFailed', { reason: outcome.reason })}
        </p>
      )}
      {outcome?.kind === 'partial' && (
        <div className="field-error" role="alert" data-testid="cal-up-result">
          <p>{t('cal.up.partial', { reason: outcome.reason })}</p>
          <p data-testid="cal-up-written">
            {outcome.result.ranges.length === 0
              ? t('cal.up.nothingWritten')
              : t('cal.up.written', {
                  ranges: outcome.result.ranges.map((r) => `${hex(r.offset)}–${hex(r.offset + r.length)}`).join(', '),
                })}
          </p>
          {outcome.result.failed && (
            <p>
              {t('cal.up.failedBlock', {
                offset: outcome.result.failed.offset,
                length: outcome.result.failed.length,
                reason: failureReason(t, outcome.result.failed),
              })}
            </p>
          )}
          {outcome.result.ranges.length > 0 && <p>{t('cal.up.recover')}</p>}
        </div>
      )}

      {confirming && loaded && (
        <ConfirmDialog title={t('cal.up.confirmTitle')} onCancel={() => setConfirming(false)} onConfirm={() => void doUpload()}>
          <p>{t('cal.up.confirmBody', { target: targetText, bytes: loaded.file.region.length })}</p>
          <p>{backup ? t('cal.up.confirmBackup') : t('cal.up.confirmNoBackup')}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
