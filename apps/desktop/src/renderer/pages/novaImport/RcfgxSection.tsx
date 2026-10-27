import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  compareCardModel,
  estimateRcfgxMs,
  hex32,
  type CardModelMatch,
  type NovaFileErrorReason,
  type RcfgxInfo,
  type RcfgxProgress,
  type RcfgxTarget,
  type SendRcfgxResult,
} from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';
import type { MessageKey } from '../../i18n/dictionary';
import { useApp } from '../../state/AppContext';
import { ConfirmDialog } from '../persist/ConfirmDialog';
import { SaveSection } from '../persist/SaveSection';
import { formatDuration, readFileBytes } from './fileBytes';

const POLL_MS = 300;

export function RcfgxSection() {
  const { t } = useI18n();
  const { api, connectedId, info: controller, level, run } = useApp();
  const advanced = level === 'advanced';
  const connected = connectedId !== null;

  const [info, setInfo] = useState<RcfgxInfo | null>(null);
  const [error, setError] = useState<{ reason: NovaFileErrorReason; message: string } | null>(null);
  const [target, setTarget] = useState('all');
  const [confirmModel, setConfirmModel] = useState(false);
  const [confirmMismatch, setConfirmMismatch] = useState(false);
  const [ackCommands, setAckCommands] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<RcfgxProgress | null>(null);
  const [result, setResult] = useState<SendRcfgxResult | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const resetChecks = (): void => {
    setConfirmModel(false);
    setConfirmMismatch(false);
    setAckCommands(false);
    setConfirming(false);
    setResult(null);
    setProgress(null);
  };
  useEffect(() => {
    resetChecks();
    setTarget('all');
  }, [connectedId]);
  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  const cards = controller?.receivingCards ?? [];
  const rcTarget = (): RcfgxTarget => {
    if (target === 'all') return { scope: 'all' };
    const [portIndex, cardIndex] = target.split(':').map(Number) as [number, number];
    return { scope: 'card', portIndex, cardIndex };
  };

  const fileModel = info?.properties.cardModel ?? null;
  const modelMatch = useMemo<CardModelMatch>(() => {
    if (!fileModel) return 'unknown';
    const t0 = target === 'all' ? cards : cards.filter((c) => `${c.portIndex}:${c.cardIndex}` === target);
    const states = t0.map((c) => compareCardModel(fileModel, c.model));
    if (states.includes('mismatch')) return 'mismatch';
    return states.length > 0 && states.every((s) => s === 'match') ? 'match' : 'unknown';
  }, [fileModel, cards, target]);
  const mismatchCard = useMemo(() => {
    if (!fileModel) return '';
    const t0 = target === 'all' ? cards : cards.filter((c) => `${c.portIndex}:${c.cardIndex}` === target);
    return t0.find((c) => compareCardModel(fileModel, c.model) === 'mismatch')?.model ?? '';
  }, [fileModel, cards, target]);

  const onFile = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = ''; // picking the same file again must fire a change again
    if (!file) return;
    resetChecks();
    setInfo(null);
    setError(null);
    let bytes: Uint8Array;
    try {
      bytes = await readFileBytes(file);
    } catch {
      setError({ reason: 'not-zip', message: 'cannot read file' });
      return;
    }
    const res = await run(() => api.parseRcfgxFile({ name: file.name, bytes }));
    if (!res) return;
    if (res.ok) setInfo(res.info);
    else setError({ reason: res.reason, message: res.message });
  };

  const needModelConfirm = fileModel !== null;
  const needMismatch = modelMatch === 'mismatch';
  const needCommands = (info?.commandRecords.length ?? 0) > 0;
  const canSend =
    info !== null &&
    connected &&
    advanced &&
    !sending &&
    (!needModelConfirm || confirmModel) &&
    (!needMismatch || confirmMismatch) &&
    (!needCommands || ackCommands);

  const targetText = (): string => {
    const tg = rcTarget();
    return tg.scope === 'all'
      ? t('imp.rc.send.targetAll')
      : t('imp.rc.send.targetCard', { port: tg.portIndex + 1, card: tg.cardIndex + 1 });
  };

  const send = async (): Promise<void> => {
    setConfirming(false);
    if (!connectedId || !info) return;
    setSending(true);
    setResult(null);
    setProgress(null);
    timer.current = setInterval(() => {
      void api
        .getRcfgxProgress(connectedId)
        .then((p) => p && setProgress(p))
        .catch(() => undefined);
    }, POLL_MS);
    try {
      const res = await run(() =>
        api.sendRcfgx(connectedId, info.fileId, rcTarget(), {
          confirmCardModel: info.properties.cardModel ?? '',
          acknowledgeCommands: ackCommands,
        }),
      );
      if (res) setResult(res);
    } finally {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      setSending(false);
    }
  };

  const p = info?.properties;
  const none = t('imp.rc.p.none');
  const val = (v: string | number | null): string => (v === null ? none : String(v));
  const pair = (a: number | null, b: number | null, sep = ' x '): string => (a === null || b === null ? none : `${a}${sep}${b}`);
  const rows: Array<[MessageKey, string]> = p
    ? [
        ['imp.rc.p.novaLctVersion', val(p.novaLctVersion)],
        ['imp.rc.p.formatVersion', val(p.formatVersion)],
        ['imp.rc.p.cardModel', val(p.cardModel)],
        ['imp.rc.p.cardProgramVersion', val(p.cardProgramVersion)],
        ['imp.rc.p.module', pair(p.moduleWidth, p.moduleHeight)],
        ['imp.rc.p.cabinet', pair(p.cabinetWidth, p.cabinetHeight)],
        ['imp.rc.p.moduleGrid', pair(p.moduleCols, p.moduleRows)],
        ['imp.rc.p.chip', val(p.chip)],
        ['imp.rc.p.decoder', val(p.decoder)],
        ['imp.rc.p.scan', val(p.scan)],
        ['imp.rc.p.dataGroups', pair(p.dataGroups, p.physicalDataGroups, ' / ')],
        ['imp.rc.p.direction', val(p.scanDirection)],
        ['imp.rc.p.oe', val(p.oePolarity)],
        ['imp.rc.p.refresh', val(p.refreshNumPerVs)],
        ['imp.rc.p.gray', p.grayDepth === null && p.grayMode === null ? none : `${p.grayDepth ?? '?'} / ${p.grayMode ?? '?'}`],
        ['imp.rc.p.gamma', val(p.gamma)],
      ]
    : [];

  return (
    <div className="card" role="group" aria-labelledby="imp-rc-title">
      <h2 id="imp-rc-title">{t('imp.rc.title')}</h2>
      <label className="field">
        {t('imp.choose')}
        <input type="file" accept=".rcfgx" data-testid="imp-rc-file" disabled={sending} onChange={(e) => void onFile(e)} />
      </label>

      {error && (
        <div data-testid="imp-rc-error">
          <p className="field-error" role="alert">
            {t(`imp.err.${error.reason}` as MessageKey)}
          </p>
          <p className="muted">{t('imp.err.detail', { message: error.message })}</p>
        </div>
      )}

      {info && p && (
        <div data-testid="imp-rc-summary">
          <p>{t('imp.rc.file', { name: info.fileName, size: info.fileSize })}</p>
          <h3>{t('imp.rc.props')}</h3>
          <table>
            <tbody>
              {rows.map(([k, v]) => (
                <tr key={k}>
                  <th scope="row">{t(k)}</th>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>{t('imp.rc.sendList')}</h3>
          <p data-testid="imp-rc-counts">
            {t('imp.rc.sendSummary', { count: info.recordCount, bytes: info.totalBytes, groups: info.groups.length, delay: info.totalDelayMs })}
          </p>
          <table data-testid="imp-rc-groups">
            <thead>
              <tr>
                <th>{t('imp.rc.col.address')}</th>
                <th>{t('imp.rc.col.name')}</th>
                <th>{t('imp.rc.col.kind')}</th>
                <th>{t('imp.rc.col.count')}</th>
                <th>{t('imp.rc.col.bytes')}</th>
              </tr>
            </thead>
            <tbody>
              {info.groups.map((g) => (
                <tr key={g.address}>
                  <td>{hex32(g.address)}</td>
                  <td>{g.name ?? t('imp.rc.unnamed')}</td>
                  <td>{t(`imp.rc.kind.${g.kind}` as MessageKey)}</td>
                  <td>{g.count}</td>
                  <td>{g.bytes}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {needCommands && (
            <div data-testid="imp-rc-commands">
              <h3>{t('imp.rc.cmd.title')}</h3>
              <p className="field-error" role="alert">
                {t('imp.rc.cmd.warn')}
              </p>
              <ul>
                {info.commandRecords.map((r) => (
                  <li key={r.index}>
                    {t('imp.rc.cmd.item', { n: r.index + 1, address: hex32(r.address), name: r.name ?? '', len: r.length, data: r.dataHex ?? '', delay: r.delayMs })}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <h3>{t('imp.rc.send.title')}</h3>
          {!advanced && <p className="muted">{t('imp.rc.send.locked')}</p>}
          <label className="field">
            <span>{t('imp.rc.send.target')}</span>
            <select value={target} onChange={(e) => { setTarget(e.target.value); setConfirmModel(false); setConfirmMismatch(false); }} aria-label={t('imp.rc.send.target')} disabled={sending}>
              <option value="all">{t('imp.rc.send.all')}</option>
              {cards.map((c) => (
                <option key={`${c.portIndex}:${c.cardIndex}`} value={`${c.portIndex}:${c.cardIndex}`}>
                  {t('imp.rc.send.card', { port: c.portIndex + 1, card: c.cardIndex + 1 })}
                </option>
              ))}
            </select>
          </label>
          {target === 'all' && (
            <p className="field-error" data-testid="imp-rc-allwarn">
              {t('imp.rc.send.allWarn', { time: formatDuration(estimateRcfgxMs(info.records, true)) })}
            </p>
          )}

          {fileModel && (
            <div data-testid="imp-rc-model">
              <p>{t('imp.rc.model.file', { model: fileModel })}</p>
              {modelMatch === 'match' && <p className="muted">{t('imp.rc.model.match')}</p>}
              {modelMatch === 'unknown' && <p className="muted">{t('imp.rc.model.unknown')}</p>}
              {modelMatch === 'mismatch' && (
                <p className="field-error" role="alert">
                  {t('imp.rc.model.mismatch', { file: fileModel, card: mismatchCard })}
                </p>
              )}
              <label>
                <input type="checkbox" checked={confirmModel} disabled={sending} onChange={(e) => setConfirmModel(e.target.checked)} /> {t('imp.rc.model.confirm', { model: fileModel })}
              </label>
              {needMismatch && (
                <label style={{ display: 'block' }}>
                  <input type="checkbox" checked={confirmMismatch} disabled={sending} onChange={(e) => setConfirmMismatch(e.target.checked)} /> {t('imp.rc.model.mismatchConfirm')}
                </label>
              )}
            </div>
          )}
          {needCommands && (
            <label style={{ display: 'block' }}>
              <input type="checkbox" checked={ackCommands} disabled={sending} onChange={(e) => setAckCommands(e.target.checked)} /> {t('imp.rc.cmd.ack', { count: info.commandRecords.length })}
            </label>
          )}

          <div className="row">
            <button type="button" className="primary" disabled={!canSend} onClick={() => setConfirming(true)}>
              {sending ? t('imp.rc.send.running') : t('imp.rc.send.button', { count: info.recordCount })}
            </button>
          </div>

          <div className="card" data-testid="imp-rc-undo">
            <h3>{t('imp.rc.undo.title')}</h3>
            <p>{t('imp.rc.undo.body')}</p>
          </div>
        </div>
      )}

      {result && info && (
        <div data-testid="imp-rc-result">
          {result.ok ? (
            <>
              <p>{t('imp.rc.done', { count: result.recordsWritten, bytes: result.bytesWritten, cmd: result.commandRecordsWritten })}</p>
              <h3>{t('imp.rc.save.title')}</h3>
              <p className="muted">{t('imp.rc.save.hint')}</p>
              <SaveSection />
            </>
          ) : (
            <p className="field-error" role="alert">
              {t('imp.rc.failed', {
                n: (result.failed?.recordIndex ?? 0) + 1,
                address: hex32(result.failed?.address ?? 0),
                message: result.failed?.message ?? '',
                written: result.recordsWritten,
                total: result.recordsTotal,
              })}
            </p>
          )}
        </div>
      )}

      {confirming && info && (
        <ConfirmDialog title={t('imp.rc.send.confirmTitle')} onConfirm={() => void send()} onCancel={() => setConfirming(false)}>
          <p>{t('imp.rc.send.confirmBody', { count: info.recordCount, bytes: info.totalBytes, target: targetText() })}</p>
          {needCommands && <p className="field-error">{t('imp.rc.send.confirmCmd', { count: info.commandRecords.length })}</p>}
          <p>{t('imp.rc.send.confirmRam')}</p>
        </ConfirmDialog>
      )}

      {sending && (
        <div className="modal-backdrop" data-testid="imp-rc-busy">
          <div className="modal" role="alertdialog" aria-modal="true" aria-label={t('imp.rc.send.running')}>
            <h2>{t('imp.rc.send.running')}</h2>
            <p>{t('imp.busyOverlay')}</p>
            <progress value={progress?.bytesDone ?? 0} max={Math.max(1, progress?.bytesTotal ?? info?.totalBytes ?? 1)} style={{ width: '100%' }} />
            <p data-testid="imp-rc-progress" role="status">
              {progress
                ? t('imp.rc.progress', {
                    done: progress.recordsDone,
                    total: progress.recordsTotal,
                    bytes: progress.bytesDone,
                    totalBytes: progress.bytesTotal,
                    address: progress.currentAddress === null ? '-' : hex32(progress.currentAddress),
                  })
                : t('imp.rc.progress.wait')}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
