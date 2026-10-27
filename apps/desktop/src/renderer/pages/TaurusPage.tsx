import { useCallback, useEffect, useState } from 'react';
import type { TaurusInfo, TaurusLightSensor, TaurusScreenConfig, TaurusSyncState, TaurusVideoSources } from '@rockzalct/shared';
import { useI18n } from '../i18n/I18nProvider';
import { useApp } from '../state/AppContext';
import { InfoCard } from './taurus/InfoCard';
import { SourcesCard } from './taurus/SourcesCard';
import { SyncCard } from './taurus/SyncCard';

/** Taurus player: info, ambient light, LED screen summary, playback source (sync mode), brightness storage. */
export function TaurusPage() {
  const { t } = useI18n();
  const { api, connectedId, info: controller, level, run, pushInfo } = useApp();
  const isTaurus = controller?.family === 'taurus';
  const disabled = connectedId === null || !isTaurus;
  const locked = level !== 'advanced';

  const [info, setInfo] = useState<TaurusInfo | null>(null);
  const [light, setLight] = useState<TaurusLightSensor | null>(null);
  const [screens, setScreens] = useState<TaurusScreenConfig | null>(null);
  const [sync, setSync] = useState<TaurusSyncState | null>(null);
  const [sources, setSources] = useState<TaurusVideoSources | null>(null);
  const [busy, setBusy] = useState(false);

  const fetchAll = useCallback(
    async (id: string) =>
      Promise.all([
        run(() => api.getTaurusInfo(id)),
        run(() => api.getTaurusLightSensor(id)),
        run(() => api.readTaurusScreenConfig(id)),
        run(() => api.getTaurusSyncMode(id)),
        run(() => api.getTaurusVideoSources(id)),
      ]),
    [api, run],
  );

  const adopt = useCallback(([i, l, s, m, v]: Awaited<ReturnType<typeof fetchAll>>) => {
    if (i) setInfo(i);
    if (l) setLight(l);
    if (s) setScreens(s);
    if (m) setSync(m);
    if (v) setSources(v);
  }, []);

  // Read everything whenever a Taurus becomes active (and on Refresh).
  useEffect(() => {
    setInfo(null);
    setLight(null);
    setScreens(null);
    setSync(null);
    setSources(null);
    if (!connectedId || !isTaurus) return;
    let cancelled = false;
    void fetchAll(connectedId).then((r) => {
      if (!cancelled) adopt(r);
    });
    return () => {
      cancelled = true;
    };
  }, [connectedId, isTaurus, fetchAll, adopt]);

  /** Run one write, report it and re-read the playback source. */
  const write = async (call: (id: string) => Promise<unknown>, done: string) => {
    if (!connectedId) return;
    setBusy(true);
    try {
      const ok = await run(async () => {
        await call(connectedId);
        return true;
      });
      if (ok) {
        pushInfo(done);
        const [m, v] = await Promise.all([run(() => api.getTaurusSyncMode(connectedId)), run(() => api.getTaurusVideoSources(connectedId))]);
        if (m) setSync(m);
        if (v) setSources(v);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h1>{t('taurus.title')}</h1>
      {connectedId === null && <p className="muted">{t('taurus.needConnect')}</p>}
      {connectedId !== null && !isTaurus && <p className="muted">{t('taurus.notTaurus')}</p>}
      {!disabled && locked && (
        <p className="muted" data-testid="advanced-note">
          {t('taurus.advancedOnly')}
        </p>
      )}
      <div className="row">
        <button type="button" disabled={disabled || busy} onClick={() => connectedId && void fetchAll(connectedId).then(adopt)}>
          {t('taurus.refresh')}
        </button>
      </div>

      <InfoCard info={info} light={light} screens={screens} />
      <SyncCard
        sync={sync}
        locked={disabled || locked}
        busy={busy}
        onApply={(mode, fallback) =>
          void write(
            (id) => api.setTaurusSyncMode(id, mode, mode === 'synchronous' ? { fallbackToInternal: fallback } : undefined),
            t('taurus.sync.applied'),
          )
        }
      />
      <SourcesCard sources={sources} />
      <div className="card" data-testid="taurus-storage">
        <h2>{t('taurus.brightness.title')}</h2>
        <p className="muted">{t('taurus.brightness.note')}</p>
        <div className="row">
          <button
            type="button"
            disabled={disabled || locked || busy}
            onClick={() => void write((id) => api.saveTaurusBrightness(id), t('taurus.brightness.saved'))}
          >
            {t('taurus.brightness.save')}
          </button>
        </div>
      </div>
    </section>
  );
}
