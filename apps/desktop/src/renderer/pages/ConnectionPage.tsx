import { useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { useApp } from '../state/AppContext';

export function ConnectionPage() {
  const { t } = useI18n();
  const { discovered, scanning, scan, connectedId, connecting, info, connect, disconnect } = useApp();
  const [hosts, setHosts] = useState('');

  const doScan = () =>
    void scan(
      hosts
        .split(/[,\s]+/)
        .map((h) => h.trim())
        .filter(Boolean),
    );

  return (
    <section>
      <h1>{t('conn.title')}</h1>

      <div className="card">
        <label className="field">
          {t('conn.hosts')}
          <input
            type="text"
            value={hosts}
            placeholder={t('conn.hostsPlaceholder')}
            onChange={(e) => setHosts(e.target.value)}
          />
        </label>
        <button type="button" className="primary" onClick={doScan} disabled={scanning}>
          {scanning ? t('conn.scanning') : t('conn.scan')}
        </button>
      </div>

      <div className="card">
        <h2>{t('conn.results')}</h2>
        {discovered.length === 0 ? (
          <p className="muted">{t('conn.empty')}</p>
        ) : (
          <table aria-label={t('conn.results')}>
            <thead>
              <tr>
                <th>{t('conn.col.label')}</th>
                <th>{t('conn.col.transport')}</th>
                <th>{t('conn.col.action')}</th>
              </tr>
            </thead>
            <tbody>
              {discovered.map((c) => (
                <tr key={c.id}>
                  <td>{c.label}</td>
                  <td>{t(c.transport === 'serial' ? 'conn.transport.serial' : 'conn.transport.net')}</td>
                  <td>
                    {connectedId === c.id ? (
                      <button type="button" onClick={() => void disconnect()}>
                        {t('conn.disconnect')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="primary"
                        disabled={connecting || connectedId !== null}
                        onClick={() => void connect(c.id)}
                      >
                        {t('conn.connect')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {info && (
        <div className="card" data-testid="controller-info">
          <h2>{t('conn.info')}</h2>
          <dl className="kv">
            <dt>{t('conn.model')}</dt>
            <dd>{info.model}</dd>
            <dt>{t('conn.firmware')}</dt>
            <dd>{info.firmwareVersion}</dd>
            <dt>{t('conn.ports')}</dt>
            <dd>{info.outputPorts}</dd>
          </dl>
          <h3>{t('conn.cards')}</h3>
          {info.receivingCards.length === 0 ? (
            <p className="muted">{t('conn.noCards')}</p>
          ) : (
            <table aria-label={t('conn.cards')}>
              <thead>
                <tr>
                  <th>{t('conn.card.port')}</th>
                  <th>{t('conn.card.index')}</th>
                  <th>{t('conn.card.model')}</th>
                  <th>{t('conn.card.firmware')}</th>
                </tr>
              </thead>
              <tbody>
                {info.receivingCards.map((rc) => (
                  <tr key={`${rc.portIndex}-${rc.cardIndex}`}>
                    <td>{rc.portIndex + 1}</td>
                    <td>{rc.cardIndex + 1}</td>
                    <td>{rc.model}</td>
                    <td>{rc.firmwareVersion}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
