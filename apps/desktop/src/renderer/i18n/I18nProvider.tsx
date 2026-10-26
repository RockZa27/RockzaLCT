import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { dictionaries, type Lang, type MessageKey } from './dictionary';

const STORAGE_KEY = 'rockzalct.lang';

export interface I18n {
  lang: Lang;
  setLang(lang: Lang): void;
  t(key: MessageKey, params?: Record<string, string | number>): string;
}

const I18nContext = createContext<I18n | null>(null);

function readStoredLang(): Lang | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'th' || v === 'en' ? v : null;
  } catch {
    return null;
  }
}

export function I18nProvider({ initialLang, children }: { initialLang?: Lang; children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => initialLang ?? readStoredLang() ?? 'th');

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const value = useMemo<I18n>(
    () => ({
      lang,
      setLang,
      t: (key, params) => {
        let text: string = dictionaries[lang][key] ?? key;
        if (params) for (const [k, v] of Object.entries(params)) text = text.replaceAll(`{${k}}`, String(v));
        return text;
      },
    }),
    [lang, setLang],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}
