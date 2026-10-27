import { useI18n } from '../i18n/I18nProvider';
import { useApp } from '../state/AppContext';
import type { PageId } from '../components/Layout';
import { RcfgxSection } from './novaImport/RcfgxSection';
import { ScrSection } from './novaImport/ScrSection';

/** Import files made with NovaLCT: .rcfgx (replay the register writes on a card) and .scr (screen layout). */
export function NovaImportPage({ onNavigate }: { onNavigate(p: PageId): void }) {
  const { t } = useI18n();
  const { connectedId } = useApp();
  return (
    <section>
      <h1>{t('imp.title')}</h1>
      {connectedId === null && <p className="muted">{t('imp.needConnect')}</p>}
      <div className="card">
        <p className="muted">{t('imp.help')}</p>
      </div>
      <RcfgxSection />
      <ScrSection onOpenLayout={() => onNavigate('layout')} />
    </section>
  );
}
