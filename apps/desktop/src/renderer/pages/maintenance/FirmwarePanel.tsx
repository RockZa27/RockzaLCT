import { useEffect, useState } from 'react';
import { FIRMWARE_TARGETS, FIRMWARE_WRITE_MISSING, DEFAULT_DRY_RUN_BLOCK_SIZE, type DryRunResult, type FirmwareTarget } from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';
import { useApp } from '../../state/AppContext';
import { parseHex32 } from './address';

/** Read a picked file as bytes. */
function readFileBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('cannot read file'));
    reader.readAsArrayBuffer(file);
  });
}

export function FirmwarePanel({ address }: { address: number | null }) {
  const { t } = useI18n();
  const { api, connectedId, run } = useApp();
  const [target, setTarget] = useState<FirmwareTarget>('function-card-fpga');
  const [file, setFile] = useState<File | null>(null);
  const [versionText, setVersionText] = useState('');
  const [modelText, setModelText] = useState('');
  const [blockText, setBlockText] = useState(String(DEFAULT_DRY_RUN_BLOCK_SIZE));
  const [result, setResult] = useState<DryRunResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setResult(null), [connectedId]);

  const go = async () => {
    setProblem(null);
    if (!connectedId) return;
    if (!file) return setProblem(t('maint.fw.noFile'));
    const declaredVersion = parseHex32(versionText);
    const declaredModelId = parseHex32(modelText);
    if (declaredVersion === null || declaredModelId === null) return setProblem(t('maint.fw.badHex'));
    const blockSize = Number(blockText);
    if (!/^\d+$/.test(blockText.trim()) || blockSize < 1 || blockSize > 65535) return setProblem(t('maint.fw.badBlock'));
    setBusy(true);
    try {
      const bytes = await readFileBytes(file);
      const res = await run(() =>
        api.dryRunFirmware(connectedId, {
          functionCardAddress: address ?? 0,
          target,
          file: { name: file.name, bytes },
          blockSize,
          ...(declaredVersion !== undefined ? { declaredVersion } : {}),
          ...(declaredModelId !== undefined ? { declaredModelId } : {}),
        }),
      );
      if (res) setResult(res);
    } finally {
      setBusy(false);
    }
  };

  const sev = (s: 'error' | 'warning' | 'info'): string => t(`maint.fw.severity.${s}`);

  return (
    <>
      <div className="card" role="group" aria-labelledby="maint-fw-title">
        <h2 id="maint-fw-title">{t('maint.fw.title')}</h2>
        <p className="muted">{t('maint.fw.desc')}</p>
        <label className="field">
          <span>{t('maint.fw.target')}</span>
          <select value={target} onChange={(e) => setTarget(e.target.value as FirmwareTarget)} aria-label={t('maint.fw.target')}>
            {FIRMWARE_TARGETS.map((k) => (
              <option key={k} value={k}>
                {t(`maint.fw.target.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('maint.fw.file')}</span>
          <input type="file" aria-label={t('maint.fw.file')} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <label className="field">
          <span>{t('maint.fw.declaredVersion')}</span>
          <input value={versionText} onChange={(e) => setVersionText(e.target.value)} aria-label={t('maint.fw.declaredVersion')} />
        </label>
        <label className="field">
          <span>{t('maint.fw.declaredModel')}</span>
          <input value={modelText} onChange={(e) => setModelText(e.target.value)} aria-label={t('maint.fw.declaredModel')} />
        </label>
        <label className="field">
          <span>{t('maint.fw.blockSize')}</span>
          <input inputMode="numeric" value={blockText} onChange={(e) => setBlockText(e.target.value)} aria-label={t('maint.fw.blockSize')} />
        </label>
        <p className="muted">{t('maint.fw.blockSizeNote')}</p>
        {problem && (
          <p className="field-error" role="alert">
            {problem}
          </p>
        )}
        <div className="row">
          <button type="button" className="primary" disabled={connectedId === null || busy} onClick={go}>
            {busy ? t('maint.fw.running') : t('maint.fw.run')}
          </button>
        </div>

        {result && (
          <div data-testid="fw-result">
            <h3>{t('maint.fw.report')}</h3>
            <p>
              {result.report.capacity === null
                ? t('maint.fw.sizeNoCap', { size: result.report.size })
                : t('maint.fw.size', { size: result.report.size, capacity: result.report.capacity })}
              {' - '}
              {t('maint.fw.format', { format: result.report.format })}
            </p>
            <p data-testid="fw-valid">
              <strong>{result.report.valid ? t('maint.fw.valid') : t('maint.fw.invalid')}</strong>
            </p>
            <ul>
              {result.report.findings.map((f, i) => (
                <li key={`r${i}`}>
                  {sev(f.severity)}: {f.message}
                </li>
              ))}
            </ul>
            <h3>{t('maint.fw.compat')}</h3>
            <p data-testid="fw-compat">
              <strong>{result.compatibility.compatible ? t('maint.fw.compatOk') : t('maint.fw.compatBad')}</strong>{' '}
              {t(`maint.fw.versionCmp.${result.compatibility.versionComparison}`)}
            </p>
            <ul>
              {result.compatibility.findings.map((f, i) => (
                <li key={`c${i}`}>
                  {sev(f.severity)}: {f.message}
                </li>
              ))}
            </ul>
            <h3>{t('maint.fw.plan')}</h3>
            {result.plan === null ? (
              <p className="muted">{t('maint.fw.planNone')}</p>
            ) : (
              <div data-testid="fw-plan">
                <p>{t('maint.fw.planBlocks', { count: result.plan.blockCount, size: result.plan.blockSize })}</p>
                <ul>
                  {result.plan.steps.map((s) => (
                    <li key={s.call}>{t('maint.fw.planStep', { call: s.call, address: s.address, length: s.length, note: s.note })}</li>
                  ))}
                  {result.plan.blockSample.map((b) => (
                    <li key={b.index}>{t('maint.fw.planBlock', { index: b.index, offset: b.offset, address: b.address, length: b.length })}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card danger" role="group" aria-labelledby="maint-danger-title" data-testid="fw-danger">
        <h2 id="maint-danger-title">{t('maint.danger.title')}</h2>
        <p>{t('maint.danger.body')}</p>
        <p>{t('maint.danger.missing')}</p>
        <ul>
          {FIRMWARE_WRITE_MISSING.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
        <p className="muted">{t('maint.danger.useNova')}</p>
      </div>
    </>
  );
}
