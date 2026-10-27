import { useEffect, useState } from 'react';
import { serializeScreenConfig, type ConfigReadFailure, type ReadScreenConfigResult } from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';
import type { MessageKey } from '../../i18n/dictionary';
import { useApp } from '../../state/AppContext';
import { configFileName, downloadTextFile, loadModuleLibrary } from './fileIo';

/** Read back everything from the controller and save it as a config file. Allowed at every level. */
export function ReadSection() {
  const { t } = useI18n();
  const { api, connectedId, run, pushInfo } = useApp();
  const [snapshot, setSnapshot] = useState<ReadScreenConfigResult | null>(null);
  const [reading, setReading] = useState(false);
  const [includeLibrary, setIncludeLibrary] = useState(false);
  const [library, setLibrary] = useState(() => loadModuleLibrary());

  useEffect(() => {
    setSnapshot(null);
  }, [connectedId]);

  const read = async () => {
    if (!connectedId) return;
    setReading(true);
    setSnapshot(null);
    try {
      const res = await run(() => api.readScreenConfig(connectedId));
      if (res) {
        setSnapshot(res);
        setLibrary(loadModuleLibrary());
      }
    } finally {
      setReading(false);
    }
  };

  const download = () => {
    if (!snapshot) return;
    const config = includeLibrary && library.length > 0 ? { ...snapshot.config, moduleLibrary: library } : snapshot.config;
    const name = configFileName();
    try {
      downloadTextFile(name, serializeScreenConfig(config));
      pushInfo(t('persist.read.downloaded', { name }));
    } catch {
      /* the browser refused the download: nothing was saved, so no success message */
    }
  };

  const failureText = (f: ConfigReadFailure): string =>
    `${t(`persist.read.failure.${f.part}` as MessageKey, { port: f.portIndex ?? '', card: f.cardIndex ?? '' })}: ${f.message}`;

  return (
    <div className="card" role="group" aria-labelledby="persist-read-title">
      <h2 id="persist-read-title">{t('persist.read.title')}</h2>
      <p className="muted">{t('persist.read.desc')}</p>
      <div className="row">
        <button type="button" disabled={connectedId === null || reading} onClick={() => void read()}>
          {reading ? t('persist.read.reading') : t('persist.read.button')}
        </button>
      </div>
      {snapshot && (
        <div data-testid="read-result">
          <p>
            {t('persist.read.summary', {
              cards: snapshot.config.receivers.length,
              ports: snapshot.config.controller.outputPorts,
              layout: t(snapshot.config.layout ? 'persist.read.layout.yes' : 'persist.read.layout.no'),
            })}
          </p>
          {snapshot.warnings.map((w, n) => (
            <p key={n} className="muted">
              {t(`persist.read.warning.${w.code}` as MessageKey, { count: w.params?.count ?? 0 })}
            </p>
          ))}
          {snapshot.failures.length > 0 && (
            <>
              <p className="field-error" role="alert">
                {t('persist.read.failures')}
              </p>
              <ul>
                {snapshot.failures.map((f, n) => (
                  <li key={n}>{failureText(f)}</li>
                ))}
              </ul>
              <p className="muted">{t('persist.read.incomplete')}</p>
            </>
          )}
          {library.length > 0 && (
            <label>
              <input type="checkbox" checked={includeLibrary} onChange={(e) => setIncludeLibrary(e.target.checked)} />{' '}
              {t('persist.read.includeLibrary', { count: library.length })}
            </label>
          )}
          <div className="row">
            <button type="button" className="primary" onClick={download}>
              {t('persist.read.download')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
