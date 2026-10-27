import { useI18n } from '../i18n/I18nProvider';
import { useApp } from '../state/AppContext';
import { LoadSection } from './persist/LoadSection';
import { ReadSection } from './persist/ReadSection';
import { SaveSection } from './persist/SaveSection';

/** PLAN.md phase 6: save to hardware, read back, config files. */
export function PersistPage() {
  const { t } = useI18n();
  const { connectedId } = useApp();
  return (
    <section>
      <h1>{t('persist.title')}</h1>
      {connectedId === null && <p className="muted">{t('persist.needConnect')}</p>}
      <div className="card">
        <h2>{t('persist.help.title')}</h2>
        <p className="muted">{t('persist.help.body')}</p>
        <p className="muted" data-testid="persist-nova-note">
          {t('persist.help.nova')}
        </p>
      </div>
      <SaveSection />
      <ReadSection />
      <LoadSection />
    </section>
  );
}
