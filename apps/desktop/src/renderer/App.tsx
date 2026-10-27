import { useState } from 'react';
import type { DeviceApi } from '@rockzalct/shared';
import { Layout, isPageVisible, type PageId } from './components/Layout';
import { I18nProvider } from './i18n/I18nProvider';
import type { Lang } from './i18n/dictionary';
import { AdvancedSettingsPage } from './pages/AdvancedSettingsPage';
import { BrightnessPage } from './pages/BrightnessPage';
import { ConnectionPage } from './pages/ConnectionPage';
import { HSeriesPage } from './pages/HSeriesPage';
import { LayoutPage } from './pages/LayoutPage';
import { MonitorPage } from './pages/MonitorPage';
import { CalibrationPage } from './pages/CalibrationPage';
import { MaintenancePage } from './pages/MaintenancePage';
import { PersistPage } from './pages/PersistPage';
import { ReceiverPage } from './pages/ReceiverPage';
import { SenderPage } from './pages/SenderPage';
import { SmartSettingsPage } from './pages/SmartSettingsPage';
import { TaurusPage } from './pages/TaurusPage';
import { TestDisplayPage } from './pages/TestDisplayPage';
import { AppProvider, useApp } from './state/AppContext';

/** `api` is injected so tests can pass a fake; production passes window.rockzalct. */
export function App({ api, initialLang }: { api: DeviceApi; initialLang?: Lang }) {
  return (
    <I18nProvider initialLang={initialLang}>
      <AppProvider api={api}>
        <Shell />
      </AppProvider>
    </I18nProvider>
  );
}

function Shell() {
  const { info } = useApp();
  const [chosen, setPage] = useState<PageId>('connection');
  // A page hidden for the connected family (e.g. Sending card on an H series) falls back to Connection.
  const page: PageId = isPageVisible(chosen, info) ? chosen : 'connection';
  return (
    <Layout page={page} onNavigate={setPage}>
      {page === 'connection' && <ConnectionPage />}
      {page === 'brightness' && <BrightnessPage />}
      {page === 'test' && <TestDisplayPage />}
      {page === 'hseries' && <HSeriesPage />}
      {page === 'taurus' && <TaurusPage />}
      {page === 'sender' && <SenderPage />}
      {page === 'receiver' && <ReceiverPage />}
      {page === 'smart' && <SmartSettingsPage />}
      {page === 'layout' && <LayoutPage />}
      {page === 'persist' && <PersistPage />}
      {page === 'monitor' && <MonitorPage />}
      {page === 'calibration' && <CalibrationPage />}
      {page === 'maintenance' && <MaintenancePage />}
      {page === 'advanced' && <AdvancedSettingsPage />}
    </Layout>
  );
}
