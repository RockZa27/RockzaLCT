import { useState, type FormEvent } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/dictionary';
import { useApp } from '../state/AppContext';

export function LoginModal({ onClose }: { onClose(): void }) {
  const { t } = useI18n();
  const { login, pushInfo } = useApp();
  const [password, setPassword] = useState('');
  const [failure, setFailure] = useState<null | 'wrong' | MessageKey>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await login(password);
    setBusy(false);
    if (res.status === 'ok') {
      pushInfo(t('login.success'));
      onClose();
    } else if (res.status === 'wrong') {
      setFailure('wrong');
    } else if (res.status === 'error') {
      setFailure(`error.${res.code}` as MessageKey);
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
              setFailure(null);
            }}
          />
        </label>
        {failure && (
          <p className="field-error" role="alert">
            {t(failure === 'wrong' ? 'login.wrong' : failure)}
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
