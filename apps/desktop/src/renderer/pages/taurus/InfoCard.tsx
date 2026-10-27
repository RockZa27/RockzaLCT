import type { TaurusInfo, TaurusLightSensor, TaurusScreenConfig } from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';

export function InfoCard({
  info,
  light,
  screens,
}: {
  info: TaurusInfo | null;
  light: TaurusLightSensor | null;
  screens: TaurusScreenConfig | null;
}) {
  const { t } = useI18n();
  return (
    <>
      <div className="card" data-testid="taurus-info">
        <h2>{t('taurus.info.title')}</h2>
        {info && (
          <dl className="kv">
            <dt>{t('taurus.info.model')}</dt>
            <dd data-testid="taurus-model">{info.productName || '-'}</dd>
            <dt>{t('taurus.info.sn')}</dt>
            <dd>{info.sn}</dd>
            <dt>{t('taurus.info.address')}</dt>
            <dd>{info.address}</dd>
            <dt>{t('taurus.info.port')}</dt>
            <dd>{info.tcpPort}</dd>
            <dt>{t('taurus.info.privacy')}</dt>
            <dd>{t(info.privacy ? 'taurus.info.on' : 'taurus.info.off')}</dd>
            <dt>{t('taurus.info.light')}</dt>
            <dd data-testid="taurus-light">
              {light === null
                ? '-'
                : light.available
                  ? t('taurus.info.lightValue', { value: light.value ?? '-' })
                  : t('taurus.info.lightNone')}
            </dd>
          </dl>
        )}
      </div>

      <div className="card" data-testid="taurus-screens">
        <h2>{t('taurus.screen.title')}</h2>
        {screens === null || screens.screens.length === 0 ? (
          <p className="muted">{t('taurus.screen.empty')}</p>
        ) : (
          <table aria-label={t('taurus.screen.title')}>
            <thead>
              <tr>
                <th>{t('taurus.screen.col.id')}</th>
                <th>{t('taurus.screen.col.grid')}</th>
                <th>{t('taurus.screen.col.size')}</th>
                <th>{t('taurus.screen.col.cards')}</th>
              </tr>
            </thead>
            <tbody>
              {screens.screens.map((s) => (
                <tr key={s.id}>
                  <td>{s.id + 1}</td>
                  <td>
                    {s.columns} x {s.rows}
                  </td>
                  <td data-testid={`taurus-screen-size-${s.id}`}>
                    {s.width} x {s.height}
                  </td>
                  <td>{s.receivingCards}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
