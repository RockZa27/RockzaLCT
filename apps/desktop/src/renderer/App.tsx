import { useState } from 'react';
import type { DeviceApi } from '@rockzalct/shared';
import { Layout, type PageId } from './components/Layout';
import { I18nProvider } from './i18n/I18nProvider';
import type { Lang } from './i18n/dictionary';
import { BrightnessPage } from './pages/BrightnessPage';
import { ConnectionPage } from './pages/ConnectionPage';
import { TestDisplayPage } from './pages/TestDisplayPage';
import { AppProvider } from './state/AppContext';

/** `api` is injected so tests can pass a fake; production passes window.rockzalct. */
export function App({ api, initialLang }: { api: DeviceApi; initialLang?: Lang }) {
  const [page, setPage] = useState<PageId>('connection');
  return (
    <I18nProvider initialLang={initialLang}>
      <AppProvider api={api}>
        <Layout page={page} onNavigate={setPage}>
          {page === 'connection' && <ConnectionPage />}
          {page === 'brightness' && <BrightnessPage />}
          {page === 'test' && <TestDisplayPage />}
        </Layout>
      </AppProvider>
    </I18nProvider>
  );
}
