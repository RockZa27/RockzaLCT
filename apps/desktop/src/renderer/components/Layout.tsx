import { useState, type ReactNode } from 'react';
import type { ControllerInfo } from '@rockzalct/shared';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/dictionary';
import { useApp } from '../state/AppContext';
import { LoginModal } from './LoginModal';
import { Toasts } from './Toasts';

export type PageId =
  | 'connection'
  | 'brightness'
  | 'test'
  | 'sender'
  | 'receiver'
  | 'layout'
  | 'persist'
  | 'monitor'
  | 'hseries';

/** `family`: only shown for that controller family while one is connected; absent = both. */
const NAV: { id: PageId; label: MessageKey; family?: 'novastar' | 'hseries' }[] = [
  { id: 'connection', label: 'nav.connection' },
  { id: 'brightness', label: 'nav.brightness' },
  { id: 'test', label: 'nav.test' },
  { id: 'hseries', label: 'nav.hseries', family: 'hseries' },
  { id: 'sender', label: 'nav.sender', family: 'novastar' },
  { id: 'receiver', label: 'nav.receiver', family: 'novastar' },
  { id: 'layout', label: 'nav.layout', family: 'novastar' },
  { id: 'persist', label: 'nav.persist', family: 'novastar' },
  { id: 'monitor', label: 'nav.monitor', family: 'novastar' },
];

/**
 * Whether a page is offered for the connected controller. Nothing connected: every page. An H
 * series connected: the MCTRL-only pages (sender, receiver, layout, persist, monitor) are hidden
 * and the H series page is shown; an MCTRL/VX connected: the H series page is hidden.
 */
export function isPageVisible(page: PageId, info: ControllerInfo | null): boolean {
  const family = NAV.find((n) => n.id === page)?.family;
  if (!info || !family) return true;
  return family === (info.family ?? 'novastar');
}

export function Layout({
  page,
  onNavigate,
  children,
}: {
  page: PageId;
  onNavigate(p: PageId): void;
  children: ReactNode;
}) {
  const { t, lang, setLang } = useI18n();
  const { info, level } = useApp();
  const [loginOpen, setLoginOpen] = useState(false);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">{t('app.name')}</div>
        <nav aria-label="Main">
          {NAV.filter((n) => isPageVisible(n.id, info)).map((n) => (
            <button
              key={n.id}
              type="button"
              className={'nav-item' + (page === n.id ? ' active' : '')}
              aria-current={page === n.id ? 'page' : undefined}
              onClick={() => onNavigate(n.id)}
            >
              {t(n.label)}
            </button>
          ))}
        </nav>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className={'status' + (info ? ' on' : '')} role="status" data-testid="connection-status">
            <span className="dot" aria-hidden="true" />
            {info ? t('top.status.connected', { name: info.model }) : t('top.status.disconnected')}
          </div>
          <div className="spacer" />
          <span className="level" data-testid="user-level">
            {t(level === 'advanced' ? 'top.level.advanced' : 'top.level.normal')}
          </span>
          <button type="button" onClick={() => setLoginOpen(true)}>
            {t('top.advancedLogin')}
          </button>
          <div className="lang" role="group" aria-label={t('top.language')}>
            <button
              type="button"
              className={lang === 'th' ? 'active' : ''}
              aria-pressed={lang === 'th'}
              onClick={() => setLang('th')}
            >
              ไทย
            </button>
            <button
              type="button"
              className={lang === 'en' ? 'active' : ''}
              aria-pressed={lang === 'en'}
              onClick={() => setLang('en')}
            >
              EN
            </button>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>

      {loginOpen && <LoginModal onClose={() => setLoginOpen(false)} />}
      <Toasts />
    </div>
  );
}
