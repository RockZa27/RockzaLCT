import type { HSeriesPreset, HSeriesScreen } from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';

export function PresetsCard({
  screens,
  presets,
  locked,
  busy,
  onPlay,
}: {
  screens: HSeriesScreen[] | null;
  presets: HSeriesPreset[] | null;
  locked: boolean;
  busy: boolean;
  onPlay(preset: HSeriesPreset): void;
}) {
  const { t } = useI18n();
  return (
    <div className="card" data-testid="hs-presets">
      <h2>{t('hs.presets.title')}</h2>
      {(screens ?? []).map((s) => {
        const list = (presets ?? []).filter((p) => p.screenId === s.screenId);
        return (
          <div key={s.screenId}>
            <h3>{s.name}</h3>
            {list.length === 0 ? (
              <p className="muted">{t('hs.presets.empty')}</p>
            ) : (
              <div className="btn-grid">
                {list.map((p) => (
                  <button
                    key={p.presetId}
                    type="button"
                    className="choice"
                    disabled={locked || busy}
                    aria-label={`${t('hs.presets.play')}: ${s.name} / ${p.name}`}
                    onClick={() => onPlay(p)}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
