import { temperatureSeries, type MonitorCardReading, type MonitorSnapshot } from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';
import { TrendChart } from './TrendChart';
import { Reading } from './Reading';
import { bytes, showFan, showHumidity, showList, showSmoke, showTemp, showVoltage } from './format';

const show = (v: number | undefined): string => (v === undefined ? '-' : String(v));

export function CardDetail({
  card,
  history,
}: {
  card: MonitorCardReading | null;
  history: readonly MonitorSnapshot[];
}) {
  const { t } = useI18n();
  if (!card) {
    return (
      <div className="card" data-testid="card-detail">
        <h2>{t('monitor.detail')}</h2>
        <p className="muted">{t('monitor.detail.select')}</p>
      </div>
    );
  }
  const series = temperatureSeries(history, card.portIndex, card.cardIndex);
  const known = series.filter((p) => p.value !== null).map((p) => p.value as number);
  const mc = card.monitorCard;
  return (
    <div className="card" data-testid="card-detail">
      <h2>
        {t('monitor.detail')}: {t('monitor.card.name', { port: card.portIndex + 1, card: card.cardIndex + 1 })}
      </h2>
      <dl className="kv">
        <div className="kv-row">
          <dt>{t('monitor.detail.state')}</dt>
          <dd data-testid="detail-state">{t(`monitor.state.${card.state}`)}</dd>
        </div>
        {card.error && (
          <div className="kv-row">
            <dt>{t('monitor.detail.error')}</dt>
            <dd data-testid="detail-error">{card.error}</dd>
          </div>
        )}
        {card.state === 'online' && (
          <>
            <div className="kv-row">
              <dt>{t('monitor.detail.temperature')}</dt>
              <dd data-testid="detail-temperature">
                <Reading shown={showTemp(card.temperatureFlagsRaw, card.temperatureRaw)} empty={t('monitor.detail.invalid')} />
              </dd>
            </div>
            <div className="kv-row">
              <dt>{t('monitor.detail.humidity')}</dt>
              <dd data-testid="detail-humidity">
                <Reading shown={showHumidity(card.humidityRaw)} />
              </dd>
            </div>
            <div className="kv-row">
              <dt>{t('monitor.detail.voltage')}</dt>
              <dd data-testid="detail-voltage">
                <Reading shown={showVoltage(card.voltageRaw)} />
              </dd>
            </div>
            {card.bitErrorRaw && (
              <div className="kv-row">
                <dt>{t('monitor.detail.bitError')}</dt>
                <dd data-testid="detail-biterror">{bytes(card.bitErrorRaw)}</dd>
              </div>
            )}
          </>
        )}
      </dl>

      {card.state === 'online' && (
        <>
          <h3>{t('monitor.detail.monitorCard')}</h3>
          {mc ? (
            <dl className="kv" data-testid="detail-monitor-card">
              <div className="kv-row">
                <dt>{t('monitor.detail.temperature')}</dt>
                <dd>
                  <Reading shown={showTemp(mc.temperatureFlagsRaw, mc.temperatureRaw)} empty={t('monitor.detail.invalid')} />
                </dd>
              </div>
              <div className="kv-row">
                <dt>{t('monitor.detail.humidity')}</dt>
                <dd>
                  <Reading shown={showHumidity(mc.humidityRaw)} />
                </dd>
              </div>
              <div className="kv-row">
                <dt>{t('monitor.detail.smoke')}</dt>
                <dd data-testid="detail-smoke">
                  <Reading
                    shown={{
                      text: showSmoke(mc.smokeRaw).alarm === null ? null : t(showSmoke(mc.smokeRaw).alarm ? 'monitor.smoke.alarm' : 'monitor.smoke.ok'),
                      raw: showSmoke(mc.smokeRaw).raw,
                    }}
                  />
                </dd>
              </div>
              <div className="kv-row">
                <dt>{t('monitor.detail.fans')}</dt>
                <dd data-testid="detail-fans">
                  <Reading shown={showList(mc.fanRaw, showFan)} />
                </dd>
              </div>
              <div className="kv-row">
                <dt>{t('monitor.detail.voltages')}</dt>
                <dd data-testid="detail-voltages">
                  <Reading shown={showList(mc.voltageRaw, (b) => showVoltage(b))} />
                </dd>
              </div>
              <div className="kv-row">
                <dt>{t('monitor.detail.general')}</dt>
                <dd>{show(mc.generalStatusRaw)}</dd>
              </div>
              <div className="kv-row">
                <dt>{t('monitor.detail.modules')}</dt>
                <dd>{bytes(mc.moduleStatusRaw)}</dd>
              </div>
            </dl>
          ) : (
            <p className="muted">{t('monitor.detail.monitorCard.none')}</p>
          )}
        </>
      )}

      <h3>{t('monitor.trend')}</h3>
      {known.length < 2 ? (
        <p className="muted" data-testid="trend-empty">
          {t('monitor.trend.empty')}
        </p>
      ) : (
        <TrendChart
          points={series}
          label={t('monitor.trend.label', {
            port: card.portIndex + 1,
            card: card.cardIndex + 1,
            min: Math.min(...known).toFixed(1),
            max: Math.max(...known).toFixed(1),
          })}
        />
      )}
    </div>
  );
}
