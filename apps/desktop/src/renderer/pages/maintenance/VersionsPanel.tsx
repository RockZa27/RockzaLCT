import { useEffect, useState } from 'react';
import type { ProgramVersions } from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';
import { useApp } from '../../state/AppContext';

export function VersionsPanel({ address }: { address: number | null }) {
  const { t } = useI18n();
  const { api, connectedId, info, run } = useApp();
  const [versions, setVersions] = useState<ProgramVersions | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setVersions(null), [connectedId]);

  const read = async () => {
    if (!connectedId) return;
    setBusy(true);
    try {
      const cards = (info?.receivingCards ?? []).map((c) => ({ portIndex: c.portIndex, cardIndex: c.cardIndex }));
      const res = await run(() =>
        api.readProgramVersions(connectedId, address === null ? { cards } : { cards, functionCardAddress: address }),
      );
      if (res) setVersions(res);
    } finally {
      setBusy(false);
    }
  };

  const cell = (v: string | null): string => v ?? t('maint.ver.failed');

  return (
    <div className="card" role="group" aria-labelledby="maint-ver-title">
      <h2 id="maint-ver-title">{t('maint.ver.title')}</h2>
      <p className="muted">{t('maint.ver.desc')}</p>
      <div className="row">
        <button type="button" className="primary" disabled={connectedId === null || busy} onClick={read}>
          {t('maint.ver.read')}
        </button>
      </div>
      {versions && (
        <table data-testid="versions-table">
          <thead>
            <tr>
              <th>{t('maint.ver.col.item')}</th>
              <th>{t('maint.ver.col.mcu')}</th>
              <th>{t('maint.ver.col.fpga')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{t('maint.ver.sender')}</td>
              <td>{cell(versions.sender.mcu)}</td>
              <td>{cell(versions.sender.fpga)}</td>
            </tr>
            {versions.receivers.map((r) => (
              <tr key={`${r.portIndex}:${r.cardIndex}`}>
                <td>{t('maint.ver.card', { port: r.portIndex + 1, card: r.cardIndex + 1 })}</td>
                <td>{cell(r.mcu)}</td>
                <td>{cell(r.fpga)}</td>
              </tr>
            ))}
            {versions.functionCard && (
              <tr>
                <td>{t('maint.ver.functionCard')}</td>
                <td>{cell(versions.functionCard.mcu)}</td>
                <td>{cell(versions.functionCard.fpga)}</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
