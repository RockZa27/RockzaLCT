import type { TaurusVideoSources } from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';

export function SourcesCard({ sources }: { sources: TaurusVideoSources | null }) {
  const { t } = useI18n();
  const list = sources?.sources ?? [];
  const activeName = sources ? list.find((s) => (sources.active ?? sources.current) === (s.internal ? 'internal' : 'hdmi'))?.name : undefined;
  return (
    <div className="card" data-testid="taurus-sources">
      <h2>{t('taurus.src.title')}</h2>
      {sources === null || list.length === 0 ? (
        <p className="muted">{t('taurus.src.empty')}</p>
      ) : (
        <>
          {activeName && <p data-testid="taurus-active-source">{t('taurus.src.active', { name: activeName })}</p>}
          <table aria-label={t('taurus.src.title')}>
            <thead>
              <tr>
                <th>{t('taurus.src.col.name')}</th>
                <th>{t('taurus.src.col.signal')}</th>
                <th>{t('taurus.src.col.resolution')}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.source}>
                  <td>{s.name}</td>
                  <td>{t(s.connected ? 'taurus.src.signalOn' : 'taurus.src.signalOff')}</td>
                  <td>
                    {s.width} x {s.height} @ {s.frameRate}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {sources.hdmiInput && (
            <p className="muted" data-testid="taurus-hdmi-input">
              {t('taurus.src.hdmiInput', {
                width: sources.hdmiInput.width,
                height: sources.hdmiInput.height,
                rate: sources.hdmiInput.frameRate,
              })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
