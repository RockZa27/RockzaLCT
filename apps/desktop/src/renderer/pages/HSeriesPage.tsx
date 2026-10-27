import { useCallback, useEffect, useState } from 'react';
import type { HSeriesInput, HSeriesLayer, HSeriesPreset, HSeriesScreen } from '@rockzalct/shared';
import { useI18n } from '../i18n/I18nProvider';
import { useApp } from '../state/AppContext';
import { LayersCard } from './hseries/LayersCard';
import { PresetsCard } from './hseries/PresetsCard';
import { ScreensCard } from './hseries/ScreensCard';

/** H series (UDP) video-wall controls: screens, presets, layer inputs, fade to black. */
export function HSeriesPage() {
  const { t } = useI18n();
  const { api, connectedId, info, level, run, pushInfo } = useApp();
  const isH = info?.family === 'hseries';
  const disabled = connectedId === null || !isH;
  const locked = level !== 'advanced';

  const [screens, setScreens] = useState<HSeriesScreen[] | null>(null);
  const [presets, setPresets] = useState<HSeriesPreset[] | null>(null);
  const [layers, setLayers] = useState<HSeriesLayer[] | null>(null);
  const [inputs, setInputs] = useState<HSeriesInput[] | null>(null);
  const [busy, setBusy] = useState(false);

  const fetchAll = useCallback(
    async (id: string) =>
      Promise.all([
        run(() => api.listScreens(id)),
        run(() => api.listPresets(id)),
        run(() => api.listLayers(id)),
        run(() => api.listInputs(id)),
      ]),
    [api, run],
  );

  const adopt = useCallback(([s, p, l, i]: Awaited<ReturnType<typeof fetchAll>>) => {
    if (s) setScreens(s);
    if (p) setPresets(p);
    if (l) setLayers(l);
    if (i) setInputs(i);
  }, []);

  // Read everything whenever an H series becomes active (and on Refresh).
  useEffect(() => {
    setScreens(null);
    setPresets(null);
    setLayers(null);
    setInputs(null);
    if (!connectedId || !isH) return;
    let cancelled = false;
    void fetchAll(connectedId).then((r) => {
      if (!cancelled) adopt(r);
    });
    return () => {
      cancelled = true;
    };
  }, [connectedId, isH, fetchAll, adopt]);

  /** Run one write, report it and re-read the screens. */
  const write = async (call: (id: string) => Promise<void>, done: string) => {
    if (!connectedId) return;
    setBusy(true);
    try {
      const ok = await run(async () => {
        await call(connectedId);
        return true;
      });
      if (ok) {
        pushInfo(done);
        const s = await run(() => api.listScreens(connectedId));
        if (s) setScreens(s);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h1>{t('hs.title')}</h1>
      {connectedId === null && <p className="muted">{t('hs.needConnect')}</p>}
      {connectedId !== null && !isH && <p className="muted">{t('hs.notHSeries')}</p>}
      {!disabled && locked && (
        <p className="muted" data-testid="advanced-note">
          {t('hs.advancedOnly')}
        </p>
      )}
      <div className="row">
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => connectedId && void fetchAll(connectedId).then(adopt)}
        >
          {t('hs.refresh')}
        </button>
      </div>

      <ScreensCard
        screens={screens}
        locked={disabled || locked}
        busy={busy}
        onFade={(screenId, enabled) =>
          void write((id) => api.fadeToBlack(id, screenId, enabled), t(enabled ? 'hs.screens.faded' : 'hs.screens.unfaded'))
        }
        onSave={(screenId) => void write((id) => api.saveScreenBrightness(id, screenId), t('hs.screens.saved'))}
      />
      <PresetsCard
        screens={screens}
        presets={presets}
        locked={disabled || locked}
        busy={busy}
        onPlay={(p) =>
          void write((id) => api.playPreset(id, p.screenId, p.presetId), t('hs.presets.played', { name: p.name }))
        }
      />
      <LayersCard
        screens={screens}
        layers={layers}
        inputs={inputs}
        locked={disabled || locked}
        busy={busy}
        onSwitch={(l, i) =>
          void write(
            (id) => api.setLayerInput(id, l.screenId, l.layerId, i.inputId, i.cropId),
            t('hs.layers.applied', { layer: l.name }),
          )
        }
      />
    </section>
  );
}
