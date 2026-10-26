import { useState, type FormEvent } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { useApp } from '../state/AppContext';

export function LoginModal({ onClose }: { onClose(): void }) {
  const { t } = useI18n();
  const { login, pushInfo } = useApp();
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const ok = await login(password);
    setBusy(false);
    if (ok) {
      pushInfo(t('login.success'));
      onClose();
    } else {
      setWrong(true);
    }
  };

  return (
    <div className="modal-backdrop">
      <form className="modal" role="dialog" aria-modal="true" aria-label={t('login.title')} onSubmit={submit}>
        <h2>{t('login.title')}</h2>
        <label>
          {t('login.password')}
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setWrong(false);
            }}
          />
        </label>
        {wrong && (
          <p className="field-error" role="alert">
            {t('login.wrong')}
          </p>
        )}
        <div className="row end">
          <button type="button" onClick={onClose}>
            {t('login.cancel')}
          </button>
          <button type="submit" className="primary" disabled={busy || password.length === 0}>
            {t('login.submit')}
          </button>
        </div>
      </form>
    </div>
  );
}
