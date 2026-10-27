import type { HSeriesScreen } from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';

export function ScreensCard({
  screens,
  locked,
  busy,
  onFade,
  onSave,
}: {
  screens: HSeriesScreen[] | null;
  /** Writes need the advanced level. */
  locked: boolean;
  busy: boolean;
  onFade(screenId: number, enabled: boolean): void;
  onSave(screenId: number): void;
}) {
  const { t } = useI18n();
  return (
    <div className="card" data-testid="hs-screens">
      <h2>{t('hs.screens.title')}</h2>
      {screens === null || screens.length === 0 ? (
        <p className="muted">{t('hs.screens.empty')}</p>
      ) : (
        <table aria-label={t('hs.screens.title')}>
          <thead>
            <tr>
              <th>{t('hs.screens.col.name')}</th>
              <th>{t('hs.screens.col.brightness')}</th>
              <th>{t('hs.screens.col.state')}</th>
              <th>{t('hs.screens.col.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {screens.map((s) => (
              <tr key={s.screenId}>
                <td>{s.name}</td>
                <td data-testid={`hs-brightness-${s.screenId}`}>{s.brightness}%</td>
                <td data-testid={`hs-state-${s.screenId}`}>
                  {[s.frozen ? t('hs.screens.frozen') : null, s.fadeToBlack ? t('hs.screens.fading') : null]
                    .filter(Boolean)
                    .join(', ') || t('hs.screens.live')}
                </td>
                <td>
                  <div className="row" style={{ marginTop: 0 }}>
                    <button
                      type="button"
                      disabled={locked || busy}
                      aria-pressed={s.fadeToBlack}
                      aria-label={`${t(s.fadeToBlack ? 'hs.screens.unfade' : 'hs.screens.fade')}: ${s.name}`}
                      onClick={() => onFade(s.screenId, !s.fadeToBlack)}
                    >
                      {t(s.fadeToBlack ? 'hs.screens.unfade' : 'hs.screens.fade')}
                    </button>
                    <button
                      type="button"
                      disabled={locked || busy}
                      aria-label={`${t('hs.screens.save')}: ${s.name}`}
                      onClick={() => onSave(s.screenId)}
                    >
                      {t('hs.screens.save')}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted">{t('hs.screens.saveNote')}</p>
    </div>
  );
}
