import type { MonitorFunctionCardReading, MonitorSenderReading } from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';
import { Reading } from './Reading';
import { showFan, showHumidity, showList, showSmoke, showTemp, showVoltage } from './format';

const show = (v: number | undefined): string => (v === undefined ? '-' : String(v));

export function SenderPanel({
  sender,
  functionCard,
}: {
  sender: MonitorSenderReading;
  functionCard?: MonitorFunctionCardReading;
}) {
  const { t } = useI18n();
  return (
    <div className="card" data-testid="sender-panel">
      <h2>{t('monitor.sender')}</h2>
      {sender.error && (
        <p className="field-error" role="alert">
          {t('monitor.sender.error', { message: sender.error })}
        </p>
      )}
      {sender.portLinks.length > 0 && (
        <table data-testid="port-links">
          <thead>
            <tr>
              <th>{t('monitor.sender.port')}</th>
              <th>{t('monitor.sender.detected')}</th>
              <th>{t('monitor.sender.expected')}</th>
              <th>{t('monitor.sender.status')}</th>
            </tr>
          </thead>
          <tbody>
            {sender.portLinks.map((p) => (
              <tr key={p.portIndex} data-testid={`port-link-${p.portIndex}`}>
                <td>{p.portIndex + 1}</td>
                <td>{p.detected}</td>
                <td>{p.expected ?? t('monitor.sender.unknown')}</td>
                <td className={p.status === 'down' ? 'mon-sev-critical' : p.status === 'partial' ? 'mon-sev-warning' : ''}>
                  {t(`monitor.link.${p.status}`)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <dl className="kv" style={{ marginTop: 12 }}>
        <div className="kv-row">
          <dt>{t('monitor.sender.dvi')}</dt>
          <dd data-testid="sender-dvi">{show(sender.dviStatusRaw)}</dd>
        </div>
        <div className="kv-row">
          <dt>{t('monitor.sender.temperature')}</dt>
          <dd data-testid="sender-temperature">{show(sender.temperatureRaw)}</dd>
        </div>
        <div className="kv-row">
          <dt>{t('monitor.sender.humidity')}</dt>
          <dd>{show(sender.humidityRaw)}</dd>
        </div>
        <div className="kv-row">
          <dt>{t('monitor.sender.fan')}</dt>
          <dd>{show(sender.fanRaw)}</dd>
        </div>
      </dl>

      {functionCard && (
        <div data-testid="function-card">
          <h3>{t('monitor.function')}</h3>
          <dl className="kv">
            <div className="kv-row">
              <dt>{t('monitor.detail.state')}</dt>
              <dd>{t(`monitor.state.${functionCard.state}`)}</dd>
            </div>
            {functionCard.error && (
              <div className="kv-row">
                <dt>{t('monitor.detail.error')}</dt>
                <dd>{functionCard.error}</dd>
              </div>
            )}
            {functionCard.state === 'online' && (
              <>
                <div className="kv-row">
                  <dt>{t('monitor.function.own')}</dt>
                  <dd data-testid="function-own">
                    <Reading shown={showTemp(functionCard.temperatureFlagsRaw, functionCard.temperatureRaw)} /> /{' '}
                    <Reading shown={showHumidity(functionCard.humidityRaw)} /> /{' '}
                    <Reading shown={showVoltage(functionCard.voltageRaw)} />
                  </dd>
                </div>
                <div className="kv-row">
                  <dt>{t('monitor.function.link')}</dt>
                  <dd>{show(functionCard.linkStateRaw)}</dd>
                </div>
                <div className="kv-row">
                  <dt>{t('monitor.function.monitorTemp')}</dt>
                  <dd>
                    <Reading shown={showTemp(functionCard.monitorTemperatureFlagsRaw, functionCard.monitorTemperatureRaw)} />
                  </dd>
                </div>
                <div className="kv-row">
                  <dt>{t('monitor.function.monitorHumidity')}</dt>
                  <dd>
                    <Reading shown={showHumidity(functionCard.monitorHumidityRaw)} />
                  </dd>
                </div>
                <div className="kv-row">
                  <dt>{t('monitor.function.smoke')}</dt>
                  <dd data-testid="function-smoke">
                    <Reading
                      shown={{
                        text: showSmoke(functionCard.smokeRaw).alarm === null ? null : t(showSmoke(functionCard.smokeRaw).alarm ? 'monitor.smoke.alarm' : 'monitor.smoke.ok'),
                        raw: showSmoke(functionCard.smokeRaw).raw,
                      }}
                    />
                  </dd>
                </div>
                <div className="kv-row">
                  <dt>{t('monitor.function.fans')}</dt>
                  <dd data-testid="function-fans">
                    <Reading shown={showList(functionCard.fanRaw, showFan)} />
                  </dd>
                </div>
                <div className="kv-row">
                  <dt>{t('monitor.function.voltages')}</dt>
                  <dd>
                    <Reading shown={showList(functionCard.voltageRawList, (b) => showVoltage(b))} />
                  </dd>
                </div>
              </>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}
