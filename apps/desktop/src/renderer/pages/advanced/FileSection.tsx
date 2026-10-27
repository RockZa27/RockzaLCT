import { useRef, useState, type ChangeEvent } from 'react';
import {
  diffHardwareOverrides,
  parseHardwareOverridesJson,
  serializeHardwareOverrides,
  type HardwareOverrides,
} from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';
import { useApp } from '../../state/AppContext';
import { ConfirmDialog } from '../persist/ConfirmDialog';
import { downloadTextFile, readFileText } from '../persist/fileIo';
import { ChangeList, type Change } from './ChangeList';

/** `rockzalct-hardware-overrides-20260102-030405.json` from a Date (local time). */
export function overridesFileName(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `rockzalct-hardware-overrides-${stamp}.json`;
}

interface PendingImport {
  values: HardwareOverrides;
  note?: string;
  changes: Change[];
}

/** Export the current values to a file / import a file (validated first, diff shown, confirmed). */
export function FileSection({
  current,
  advanced,
  busy,
  onImport,
}: {
  current: HardwareOverrides;
  advanced: boolean;
  busy: boolean;
  /** Apply the imported values (the page calls setHardwareOverrides). */
  onImport(values: HardwareOverrides): Promise<void>;
}) {
  const { t } = useI18n();
  const { pushInfo } = useApp();
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [same, setSame] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const exportFile = () => {
    downloadTextFile(overridesFileName(), serializeHardwareOverrides(current, note.trim()));
    pushInfo(t('adv.file.exported'));
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // the same file can be picked again
    setProblems([]);
    setSame(false);
    setPending(null);
    if (!file) return;
    let text: string;
    try {
      text = await readFileText(file);
    } catch {
      setProblems(['cannot read the file']);
      return;
    }
    const parsed = parseHardwareOverridesJson(text);
    if (!parsed.ok) {
      setProblems(parsed.errors);
      return;
    }
    const changes = diffHardwareOverrides(current, parsed.values);
    if (changes.length === 0) {
      setSame(true);
      return;
    }
    setPending({ values: parsed.values, changes, ...(parsed.note ? { note: parsed.note } : {}) });
  };

  const confirm = async () => {
    const p = pending;
    setPending(null);
    if (p) await onImport(p.values);
  };

  return (
    <div className="card" role="group" aria-labelledby="adv-file-title">
      <h2 id="adv-file-title">{t('adv.file.title')}</h2>
      <p className="muted">{t('adv.file.desc')}</p>
      <label className="field">
        {t('adv.file.note')}
        <input type="text" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="row">
        <button type="button" onClick={exportFile}>
          {t('adv.file.export')}
        </button>
        <button type="button" disabled={!advanced || busy} onClick={() => picker.current?.click()}>
          {t('adv.file.import')}
        </button>
        <input
          ref={picker}
          type="file"
          accept=".json,application/json"
          aria-label={t('adv.file.importLabel')}
          style={{ display: 'none' }}
          onChange={(e) => void onFile(e)}
        />
      </div>
      {problems.length > 0 && (
        <div className="field-error" role="alert" data-testid="adv-import-problems">
          <p className="field-error">{t('adv.file.invalid')}</p>
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {same && (
        <p className="muted" data-testid="adv-import-same">
          {t('adv.file.same')}
        </p>
      )}
      {pending && (
        <ConfirmDialog title={t('adv.file.importTitle')} onConfirm={() => void confirm()} onCancel={() => setPending(null)}>
          <p>{t('adv.file.importBody')}</p>
          <ChangeList changes={pending.changes} testId="adv-import-changes" />
          {pending.note && <p className="muted">{t('adv.file.fileNote', { note: pending.note })}</p>}
        </ConfirmDialog>
      )}
    </div>
  );
}
