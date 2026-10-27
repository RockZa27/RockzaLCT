import { useState, type FormEvent } from 'react';
import type { DiscoveredController } from '@rockzalct/shared';
import { useI18n } from '../i18n/I18nProvider';
import { useApp } from '../state/AppContext';

/**
 * Asks for the Taurus password and connects. The password lives in this component's state only
 * until it is sent; it is neither stored by the renderer nor remembered between connections.
 */
export function TaurusPasswordModal({ controller, onClose }: { controller: DiscoveredController; onClose(): void }) {
  const { t } = useI18n();
  const { connectWithPassword } = useApp();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const result = await connectWithPassword(controller.id, {
      password,
      ...(username.trim() ? { username: username.trim() } : {}),
    });
    setBusy(false);
    if (result === 'ok') onClose();
    else if (result === 'rejected') setWrong(true);
  };

  return (
    <div className="modal-backdrop">
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('taurus.pw.title', { name: controller.label })}
        onSubmit={submit}
      >
        <h2>{t('taurus.pw.title', { name: controller.label })}</h2>
        <label>
          {t('taurus.pw.username')}
          <input
            type="text"
            autoComplete="off"
            value={username}
            placeholder={t('taurus.pw.usernameHint')}
            onChange={(e) => {
              setUsername(e.target.value);
              setWrong(false);
            }}
          />
        </label>
        <label>
          {t('taurus.pw.password')}
          <input
            type="password"
            autoFocus
            autoComplete="off"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setWrong(false);
            }}
          />
        </label>
        <p className="muted">{t('taurus.pw.note')}</p>
        {wrong && (
          <p className="field-error" role="alert">
            {t('taurus.pw.wrong')}
          </p>
        )}
        <div className="row end">
          <button type="button" onClick={onClose}>
            {t('taurus.pw.cancel')}
          </button>
          <button type="submit" className="primary" disabled={busy || password.length === 0}>
            {t('taurus.pw.submit')}
          </button>
        </div>
      </form>
    </div>
  );
}
