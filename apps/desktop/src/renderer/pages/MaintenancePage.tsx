import { useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { useApp } from '../state/AppContext';
import { loadAddress, parseAddress, saveAddress } from './maintenance/address';
import { FirmwarePanel } from './maintenance/FirmwarePanel';
import { FunctionCardPanel } from './maintenance/FunctionCardPanel';
import { VersionsPanel } from './maintenance/VersionsPanel';

/** PLAN.md phase 9: multi-function card (power relays) and firmware checks. Firmware is never written. */
export function MaintenancePage() {
  const { t } = useI18n();
  const { connectedId } = useApp();
  const [addressText, setAddressText] = useState(loadAddress);
  const address = parseAddress(addressText);

  /** Remember the address once the user is done with it (blur / read), not on every keystroke. */
  const commit = () => {
    if (address !== null) saveAddress(addressText.trim());
  };

  return (
    <section>
      <h1>{t('maint.title')}</h1>
      {connectedId === null && <p className="muted">{t('maint.needConnect')}</p>}
      <FunctionCardPanel addressText={addressText} address={address} onAddress={setAddressText} onCommit={commit} />
      <VersionsPanel address={address} />
      <FirmwarePanel address={address} />
    </section>
  );
}
