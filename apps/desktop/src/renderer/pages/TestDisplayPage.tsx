import type { DisplayMode, TestPattern } from '@rockzalct/shared';
import { useI18n } from '../i18n/I18nProvider';
import { useApp } from '../state/AppContext';

export const TEST_PATTERNS: readonly TestPattern[] = [
  'off',
  'red',
  'green',
  'blue',
  'white',
  'horizontal-lines',
  'vertical-lines',
  'slash',
  'grayscale',
];
export const DISPLAY_MODES: readonly DisplayMode[] = ['normal', 'blackout', 'freeze'];

export function TestDisplayPage() {
  const { t } = useI18n();
  const { connectedId, info, level, pattern, mode, setPattern, setMode } = useApp();
  const hseries = info?.family === 'hseries';
  const taurus = info?.family === 'taurus';
  // Taurus has no test-pattern / blackout / freeze command: show everything, disabled, with the reason.
  const disabled = connectedId === null || taurus;

  return (
    <section>
      <h1>{t('test.title')}</h1>
      {connectedId === null && <p className="muted">{t('test.needConnect')}</p>}
      {hseries && <p className="muted">{t('test.hseriesNote')}</p>}
      {taurus && (
        <p className="muted" data-testid="taurus-unsupported">
          {t('test.taurusUnsupported')}
        </p>
      )}
      {hseries && level !== 'advanced' && (
        <p className="muted" data-testid="advanced-note">
          {t('hs.advancedOnly')}
        </p>
      )}

      <div className="card">
        <h2>{t('test.patterns')}</h2>
        <div className="btn-grid">
          {TEST_PATTERNS.map((p) => (
            <button
              key={p}
              type="button"
              className={'choice' + (pattern === p ? ' selected' : '')}
              aria-pressed={pattern === p}
              disabled={disabled}
              onClick={() => void setPattern(p)}
            >
              {t(`pattern.${p}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>{t('test.modes')}</h2>
        <div className="btn-grid">
          {DISPLAY_MODES.map((m) => (
            <button
              key={m}
              type="button"
              className={'choice' + (mode === m ? ' selected' : '')}
              aria-pressed={mode === m}
              disabled={disabled}
              onClick={() => void setMode(m)}
            >
              {t(`mode.${m}`)}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
