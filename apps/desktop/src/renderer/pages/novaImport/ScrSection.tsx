import { useState, type ChangeEvent } from 'react';
import { type NovaFileErrorReason, type ScrInfo, type ScrScreen } from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';
import type { MessageKey } from '../../i18n/dictionary';
import { useApp } from '../../state/AppContext';
import { readFileBytes } from './fileBytes';

const MAX_REGIONS_SHOWN = 24;

export function ScrSection({ onOpenLayout }: { onOpenLayout(): void }) {
  const { t } = useI18n();
  const { api, run, setPendingLayout, pushInfo } = useApp();
  const [info, setInfo] = useState<ScrInfo | null>(null);
  const [error, setError] = useState<{ reason: NovaFileErrorReason; message: string } | null>(null);

  const onFile = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setInfo(null);
    setError(null);
    let bytes: Uint8Array;
    try {
      bytes = await readFileBytes(file);
    } catch {
      setError({ reason: 'scr-invalid', message: 'cannot read file' });
      return;
    }
    const res = await run(() => api.parseScreenFile({ name: file.name, bytes }));
    if (!res) return;
    if (res.ok) setInfo(res.info);
    else setError({ reason: res.reason, message: res.message });
  };

  const open = (): void => {
    if (!info || !info.layout.ok) return;
    setPendingLayout(info.layout.model);
    pushInfo(t('imp.scr.opened'));
    onOpenLayout();
  };

  const screenLine = (s: ScrScreen, n: number): string =>
    t('imp.scr.screen', {
      n,
      kind: t(`imp.scr.kind.${s.kind}` as MessageKey),
      cols: s.cols,
      rows: s.rows,
      x: s.x,
      y: s.y,
      name: s.name ? ` "${s.name}"` : '',
    });

  const layout = info?.layout;
  return (
    <div className="card" role="group" aria-labelledby="imp-scr-title">
      <h2 id="imp-scr-title">{t('imp.scr.title')}</h2>
      <label className="field">
        {t('imp.choose')}
        <input type="file" accept=".scr" data-testid="imp-scr-file" onChange={(e) => void onFile(e)} />
      </label>

      {error && (
        <div data-testid="imp-scr-error">
          <p className="field-error" role="alert">
            {t(`imp.err.${error.reason}` as MessageKey)}
          </p>
          <p className="muted">{t('imp.err.detail', { message: error.message })}</p>
        </div>
      )}

      {info && layout && (
        <div data-testid="imp-scr-summary">
          <p>{t('imp.scr.file', { name: info.fileName, size: info.fileSize, version: info.version })}</p>
          <p>{t('imp.scr.dvi', { w: info.dvi.width, h: info.dvi.height, cols: info.dvi.cols, rows: info.dvi.rows })}</p>
          <p>{t('imp.scr.screens', { count: info.screens.length })}</p>
          {info.screens.map((s, i) => (
            <div key={i}>
              <p>{screenLine(s, i + 1)}</p>
              <details>
                <summary>{t('imp.scr.regions')}</summary>
                <ul>
                  {s.regions.slice(0, MAX_REGIONS_SHOWN).map((r, j) => (
                    <li key={j}>
                      {t('imp.scr.region', { sender: r.senderIndex + 1, port: r.portIndex + 1, card: r.connectIndex + 1, x: r.x, y: r.y, w: r.width, h: r.height })}
                    </li>
                  ))}
                  {s.regions.length > MAX_REGIONS_SHOWN && <li>{t('imp.scr.regionsMore', { count: s.regions.length - MAX_REGIONS_SHOWN })}</li>}
                </ul>
              </details>
            </div>
          ))}

          {layout.ok ? (
            <div data-testid="imp-scr-mapped">
              <p>
                {t('imp.scr.mapped', {
                  rows: layout.model.screen.rows,
                  cols: layout.model.screen.cols,
                  w: layout.model.screen.cabinetWidth,
                  h: layout.model.screen.cabinetHeight,
                  ports: layout.model.ports.length,
                })}
              </p>
              <p className="muted">{t('imp.scr.openHint')}</p>
              <div className="row">
                <button type="button" className="primary" onClick={open}>
                  {t('imp.scr.open')}
                </button>
              </div>
            </div>
          ) : (
            <div data-testid="imp-scr-readonly">
              <p className="field-error" role="alert">
                {t('imp.scr.readOnly')}
              </p>
              <ul>
                {layout.reasons.map((r) => (
                  <li key={r}>{t(`imp.scr.reason.${r}` as MessageKey, { detail: layout.details.join('; ') })}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
