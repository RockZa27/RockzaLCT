import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  GRAY_MODE_NAMES,
  GRAY_REALIZE_NAMES,
  RECEIVER_LIMITS,
  parseCabinetLibraryJson,
  serializeCabinetLibrary,
  validateCabinetProfile,
  type CabinetProfile,
  type ReceiverParameters,
  type ReceiverTarget,
} from '@rockzalct/shared';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/dictionary';
import { useApp } from '../state/AppContext';

const LIBRARY_KEY = 'rockzalct.cabinets';

function loadLibrary(): CabinetProfile[] {
  try {
    const text = localStorage.getItem(LIBRARY_KEY);
    if (!text) return [];
    const res = parseCabinetLibraryJson(text);
    return res.ok ? res.profiles : [];
  } catch {
    return [];
  }
}

function saveLibrary(profiles: CabinetProfile[]): void {
  try {
    localStorage.setItem(LIBRARY_KEY, serializeCabinetLibrary(profiles));
  } catch {
    /* storage unavailable: the library stays in memory only */
  }
}

type DraftField =
  | 'name'
  | 'width'
  | 'height'
  | 'scanMode'
  | 'dataGroups'
  | 'refNumPerVs'
  | 'gamma'
  | 'grayDepth'
  | 'grayRealize'
  | 'grayMode'
  | 'driverIc'
  | 'icPerGroup'
  | 'note';

type Draft = Record<DraftField, string>;

const EMPTY_DRAFT: Draft = {
  name: '',
  width: '64',
  height: '32',
  scanMode: '16',
  dataGroups: '8',
  refNumPerVs: '1920',
  gamma: '28',
  grayDepth: '14',
  grayRealize: '0',
  grayMode: '1',
  driverIc: '',
  icPerGroup: '',
  note: '',
};

const NUMERIC: DraftField[] = [
  'width',
  'height',
  'scanMode',
  'dataGroups',
  'refNumPerVs',
  'gamma',
  'grayDepth',
  'grayRealize',
  'grayMode',
  'driverIc',
  'icPerGroup',
];

const FIELD_LABEL: Record<DraftField, MessageKey> = {
  name: 'rcv.lib.field.name',
  width: 'rcv.lib.field.width',
  height: 'rcv.lib.field.height',
  scanMode: 'rcv.lib.field.scanMode',
  dataGroups: 'rcv.lib.field.dataGroups',
  refNumPerVs: 'rcv.lib.field.refNumPerVs',
  gamma: 'rcv.lib.field.gamma',
  grayDepth: 'rcv.lib.field.grayDepth',
  grayRealize: 'rcv.lib.field.grayRealize',
  grayMode: 'rcv.lib.field.grayMode',
  driverIc: 'rcv.lib.field.driverIc',
  icPerGroup: 'rcv.lib.field.icPerGroup',
  note: 'rcv.lib.field.note',
};

const REALIZE_KEYS = GRAY_REALIZE_NAMES.map((_, i) => `rcv.realize.${i}` as MessageKey);
const MODE_KEYS = GRAY_MODE_NAMES.map((_, i) => `rcv.mode.${i}` as MessageKey);

function draftToCandidate(d: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = { name: d.name, note: d.note };
  for (const f of NUMERIC) {
    const s = d[f].trim();
    if (s === '') {
      if (f !== 'driverIc' && f !== 'icPerGroup') out[f] = Number.NaN;
    } else {
      out[f] = Number(s);
    }
  }
  return out;
}

function profileToDraft(p: CabinetProfile): Draft {
  return {
    name: p.name,
    width: String(p.width),
    height: String(p.height),
    scanMode: String(p.scanMode),
    dataGroups: String(p.dataGroups),
    refNumPerVs: String(p.refNumPerVs),
    gamma: String(p.gamma),
    grayDepth: String(p.grayDepth),
    grayRealize: String(p.grayRealize),
    grayMode: String(p.grayMode),
    driverIc: p.driverIc === undefined ? '' : String(p.driverIc),
    icPerGroup: p.icPerGroup === undefined ? '' : String(p.icPerGroup),
    note: p.note ?? '',
  };
}

function paramsToDraft(p: ReceiverParameters, name: string): Draft {
  return profileToDraft({
    name,
    width: p.moduleWidth,
    height: p.moduleHeight,
    scanMode: Math.min(128, Math.max(1, p.scanMode)),
    dataGroups: Math.max(1, p.physicalDataGroups),
    refNumPerVs: Math.max(1, p.refNumPerVs),
    gamma: p.gamma,
    grayDepth: p.grayDepth,
    grayRealize: Math.min(5, p.grayRealize),
    grayMode: Math.min(3, p.grayMode),
    ...(p.driverIc <= 254 ? { driverIc: p.driverIc } : {}),
    ...(p.icPerGroup !== undefined ? { icPerGroup: p.icPerGroup } : {}),
  });
}

interface EditState {
  refNumPerVs: number;
  gamma: number;
  grayDepth: number;
  grayRealize: number;
  grayMode: number;
}

export function ReceiverPage() {
  const { t } = useI18n();
  const { api, connectedId, info, level, run, pushInfo } = useApp();
  const advanced = level === 'advanced';
  const cards = useMemo(() => info?.receivingCards ?? [], [info]);

  const [selected, setSelected] = useState('');
  const [params, setParams] = useState<ReceiverParameters | null>(null);
  const [loading, setLoading] = useState(false);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [allCards, setAllCards] = useState(false);
  const [busy, setBusy] = useState(false);

  const [library, setLibrary] = useState<CabinetProfile[]>(loadLibrary);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [draftErrors, setDraftErrors] = useState<DraftField[]>([]);
  const [libText, setLibText] = useState('');
  const [libError, setLibError] = useState('');

  const card = useMemo(() => {
    const [p, c] = selected.split(':').map(Number);
    return cards.find((x) => x.portIndex === p && x.cardIndex === c) ?? null;
  }, [cards, selected]);

  // Select the first card whenever the connection (and so the card list) changes.
  useEffect(() => {
    const first = cards[0];
    setSelected(first ? `${first.portIndex}:${first.cardIndex}` : '');
    setParams(null);
    setEdit(null);
  }, [cards]);

  const load = useCallback(async () => {
    if (!connectedId || !card) return;
    setLoading(true);
    try {
      const p = await run(() => api.getReceiverParameters(connectedId, card.portIndex, card.cardIndex));
      if (p) {
        setParams(p);
        setEdit({
          refNumPerVs: p.refNumPerVs,
          gamma: p.gamma,
          grayDepth: p.grayDepth,
          grayRealize: Math.min(5, p.grayRealize),
          grayMode: Math.min(3, p.grayMode),
        });
      }
    } finally {
      setLoading(false);
    }
  }, [api, connectedId, card, run]);

  useEffect(() => {
    setParams(null);
    setEdit(null);
    void load();
  }, [load]);

  const target = (): ReceiverTarget | null => {
    if (allCards) return { scope: 'all' };
    return card ? { scope: 'card', portIndex: card.portIndex, cardIndex: card.cardIndex } : null;
  };

  const applySettings = async () => {
    const tg = target();
    if (!connectedId || !tg || !edit) return;
    setBusy(true);
    try {
      const ok = await run(async () => {
        await api.setReceiverParameters(connectedId, tg, edit);
        return true;
      });
      if (ok) {
        pushInfo(t('rcv.applied'));
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  const applyProfile = async (profile: CabinetProfile) => {
    const tg = target();
    if (!connectedId || !tg) return;
    setBusy(true);
    try {
      const ok = await run(async () => {
        await api.applyCabinetProfile(connectedId, tg, profile);
        return true;
      });
      if (ok) {
        pushInfo(t('rcv.profileApplied', { name: profile.name }));
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  const setDraftField = (f: DraftField, v: string) => setDraft((d) => ({ ...d, [f]: v }));

  const saveDraft = () => {
    const res = validateCabinetProfile(draftToCandidate(draft));
    if (!res.ok) {
      setDraftErrors(res.errors.map((e) => e.field as DraftField));
      return;
    }
    setDraftErrors([]);
    const profile = res.profile;
    const next = [
      ...library.filter((p) => p.name.toLowerCase() !== profile.name.toLowerCase()),
      profile,
    ].sort((a, b) => a.name.localeCompare(b.name));
    setLibrary(next);
    saveLibrary(next);
    pushInfo(t('rcv.lib.saved', { name: profile.name }));
  };

  const deleteProfile = (name: string) => {
    const next = library.filter((p) => p.name !== name);
    setLibrary(next);
    saveLibrary(next);
  };

  const importText = () => {
    const res = parseCabinetLibraryJson(libText);
    if (!res.ok) {
      setLibError(t('rcv.lib.importFailed', { reason: res.errors[0]?.message ?? '' }));
      return;
    }
    setLibError('');
    const names = new Set(res.profiles.map((p) => p.name.toLowerCase()));
    const next = [...library.filter((p) => !names.has(p.name.toLowerCase())), ...res.profiles].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    setLibrary(next);
    saveLibrary(next);
    pushInfo(t('rcv.lib.imported', { count: res.profiles.length }));
  };

  const disconnected = connectedId === null;
  const numberField = (
    key: keyof EditState,
    label: MessageKey,
    range: { readonly min: number; readonly max: number },
  ) => (
    <label className="field">
      {t(label)}
      <input
        type="number"
        min={range.min}
        max={range.max}
        step={1}
        value={edit ? edit[key] : ''}
        disabled={!advanced || !edit}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(n)) setEdit((s) => (s ? { ...s, [key]: Math.round(n) } : s));
        }}
      />
    </label>
  );

  const dash = t('rcv.unavailable');
  const opt = (v: number | undefined): string => (v === undefined ? dash : String(v));

  return (
    <section>
      <h1>{t('rcv.title')}</h1>
      {disconnected && <p className="muted">{t('rcv.needConnect')}</p>}
      {!disconnected && cards.length === 0 && <p className="muted">{t('rcv.noCards')}</p>}

      <div className="card">
        <label className="field">
          {t('rcv.picker')}
          <select
            value={selected}
            disabled={disconnected || cards.length === 0}
            onChange={(e) => setSelected(e.target.value)}
          >
            {cards.map((c) => (
              <option key={`${c.portIndex}:${c.cardIndex}`} value={`${c.portIndex}:${c.cardIndex}`}>
                {t('rcv.pickerOption', { port: c.portIndex + 1, card: c.cardIndex + 1, model: c.model })}
              </option>
            ))}
          </select>
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={allCards}
            disabled={disconnected}
            onChange={(e) => setAllCards(e.target.checked)}
          />
          {t('rcv.allCards')}
        </label>
      </div>

      <div className="card" data-testid="receiver-params">
        <div className="row">
          <h2>{t('rcv.params')}</h2>
          <button type="button" disabled={disconnected || !card || loading} onClick={() => void load()}>
            {loading ? t('rcv.loading') : t('rcv.reload')}
          </button>
        </div>
        {params && (
          <dl className="kv">
            <dt>{t('rcv.p.size')}</dt>
            <dd data-testid="rp-size">
              {params.moduleWidth} × {params.moduleHeight}
            </dd>
            <dt>{t('rcv.p.scan')}</dt>
            <dd data-testid="rp-scan">
              {params.scanMode === 1 ? t('rcv.p.scanStatic') : t('rcv.p.scanValue', { value: params.scanMode })}
            </dd>
            <dt>{t('rcv.p.dataGroups')}</dt>
            <dd data-testid="rp-groups">
              {params.physicalDataGroups} / {opt(params.logicalDataGroups)}
            </dd>
            <dt>{t('rcv.p.groupsPerModule')}</dt>
            <dd>{opt(params.groupsPerModule)}</dd>
            <dt>{t('rcv.p.moduleRows')}</dt>
            <dd>{opt(params.moduleRows)}</dd>
            <dt>{t('rcv.p.driverIc')}</dt>
            <dd data-testid="rp-ic">{params.driverIc}</dd>
            <dt>{t('rcv.p.decodeType')}</dt>
            <dd>{opt(params.decodeType)}</dd>
            <dt>{t('rcv.p.icPerGroup')}</dt>
            <dd>{opt(params.icPerGroup)}</dd>
            <dt>{t('rcv.p.refNumPerVs')}</dt>
            <dd data-testid="rp-refresh">{params.refNumPerVs}</dd>
            <dt>{t('rcv.p.grayDepth')}</dt>
            <dd data-testid="rp-graydepth">{params.grayDepth}</dd>
            <dt>{t('rcv.p.grayRealize')}</dt>
            <dd>{REALIZE_KEYS[params.grayRealize] ? t(REALIZE_KEYS[params.grayRealize]!) : params.grayRealize}</dd>
            <dt>{t('rcv.p.grayMode')}</dt>
            <dd>{MODE_KEYS[params.grayMode] ? t(MODE_KEYS[params.grayMode]!) : params.grayMode}</dd>
            <dt>{t('rcv.p.gamma')}</dt>
            <dd data-testid="rp-gamma">{params.gamma}</dd>
            <dt>{t('rcv.p.temperature')}</dt>
            <dd>{opt(params.temperatureRaw)}</dd>
            <dt>{t('rcv.p.voltage')}</dt>
            <dd>{opt(params.voltageRaw)}</dd>
          </dl>
        )}
      </div>

      <div className="card" role="group" aria-label={t('rcv.edit')}>
        <h2>{t('rcv.edit')}</h2>
        {!advanced && <p className="muted">{t('rcv.locked')}</p>}
        {numberField('refNumPerVs', 'rcv.p.refNumPerVs', RECEIVER_LIMITS.refNumPerVs)}
        {numberField('gamma', 'rcv.p.gamma', RECEIVER_LIMITS.gamma)}
        <p className="muted">{t('rcv.gamma.hint')}</p>
        {numberField('grayDepth', 'rcv.p.grayDepth', RECEIVER_LIMITS.grayDepth)}
        <label className="field">
          {t('rcv.p.grayRealize')}
          <select
            value={edit?.grayRealize ?? 0}
            disabled={!advanced || !edit}
            onChange={(e) => setEdit((s) => (s ? { ...s, grayRealize: Number(e.target.value) } : s))}
          >
            {REALIZE_KEYS.map((k, i) => (
              <option key={k} value={i}>
                {t(k)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('rcv.p.grayMode')}
          <select
            value={edit?.grayMode ?? 0}
            disabled={!advanced || !edit}
            onChange={(e) => setEdit((s) => (s ? { ...s, grayMode: Number(e.target.value) } : s))}
          >
            {MODE_KEYS.map((k, i) => (
              <option key={k} value={i}>
                {t(k)}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <button
            type="button"
            className="primary"
            disabled={!advanced || !edit || busy}
            onClick={() => void applySettings()}
          >
            {t('rcv.apply')}
          </button>
        </div>
      </div>

      <div className="card">
        <h2>{t('rcv.lib.title')}</h2>
        {library.length === 0 ? (
          <p className="muted">{t('rcv.lib.empty')}</p>
        ) : (
          <table aria-label={t('rcv.lib.title')}>
            <thead>
              <tr>
                <th>{t('rcv.lib.name')}</th>
                <th>{t('rcv.lib.size')}</th>
                <th>{t('rcv.lib.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {library.map((p) => (
                <tr key={p.name}>
                  <td>{p.name}</td>
                  <td>
                    {p.width} × {p.height}
                  </td>
                  <td>
                    <div className="row">
                      <button
                        type="button"
                        aria-label={`${t('rcv.lib.use')} ${p.name}`}
                        onClick={() => {
                          setDraft(profileToDraft(p));
                          setDraftErrors([]);
                        }}
                      >
                        {t('rcv.lib.use')}
                      </button>
                      <button
                        type="button"
                        className="primary"
                        aria-label={`${t('rcv.lib.apply')} ${p.name}`}
                        disabled={!advanced || disconnected || busy || (!allCards && !card)}
                        onClick={() => void applyProfile(p)}
                      >
                        {t('rcv.lib.apply')}
                      </button>
                      <button type="button" aria-label={`${t('rcv.lib.delete')} ${p.name}`} onClick={() => deleteProfile(p.name)}>
                        {t('rcv.lib.delete')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card" role="group" aria-label={t('rcv.lib.form')}>
        <h2>{t('rcv.lib.form')}</h2>
        {(['name', 'width', 'height', 'scanMode', 'dataGroups', 'refNumPerVs', 'gamma', 'grayDepth'] as DraftField[]).map(
          (f) => (
            <label className="field" key={f}>
              {t(FIELD_LABEL[f])}
              <input
                type={f === 'name' ? 'text' : 'number'}
                value={draft[f]}
                aria-invalid={draftErrors.includes(f)}
                onChange={(e) => setDraftField(f, e.target.value)}
              />
            </label>
          ),
        )}
        <label className="field">
          {t('rcv.lib.field.grayRealize')}
          <select value={draft.grayRealize} onChange={(e) => setDraftField('grayRealize', e.target.value)}>
            {REALIZE_KEYS.map((k, i) => (
              <option key={k} value={i}>
                {t(k)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('rcv.lib.field.grayMode')}
          <select value={draft.grayMode} onChange={(e) => setDraftField('grayMode', e.target.value)}>
            {MODE_KEYS.map((k, i) => (
              <option key={k} value={i}>
                {t(k)}
              </option>
            ))}
          </select>
        </label>
        {(['driverIc', 'icPerGroup', 'note'] as DraftField[]).map((f) => (
          <label className="field" key={f}>
            {t(FIELD_LABEL[f])}
            <input
              type={f === 'note' ? 'text' : 'number'}
              value={draft[f]}
              aria-invalid={draftErrors.includes(f)}
              onChange={(e) => setDraftField(f, e.target.value)}
            />
          </label>
        ))}
        {draftErrors.length > 0 && (
          <p className="field-error" role="alert">
            {t('rcv.lib.invalid', { fields: draftErrors.map((f) => t(FIELD_LABEL[f] ?? 'rcv.lib.field.name')).join(', ') })}
          </p>
        )}
        <div className="row">
          <button type="button" className="primary" onClick={saveDraft}>
            {t('rcv.lib.save')}
          </button>
          <button
            type="button"
            disabled={!params}
            onClick={() => {
              if (params) setDraft(paramsToDraft(params, draft.name));
              setDraftErrors([]);
            }}
          >
            {t('rcv.lib.capture')}
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(EMPTY_DRAFT);
              setDraftErrors([]);
            }}
          >
            {t('rcv.lib.new')}
          </button>
        </div>
      </div>

      <div className="card">
        <label className="field">
          {t('rcv.lib.json')}
          <textarea rows={6} value={libText} onChange={(e) => setLibText(e.target.value)} />
        </label>
        {libError && <p className="field-error">{libError}</p>}
        <div className="row">
          <button type="button" onClick={() => setLibText(serializeCabinetLibrary(library))}>
            {t('rcv.lib.export')}
          </button>
          <button type="button" onClick={importText}>
            {t('rcv.lib.import')}
          </button>
        </div>
      </div>
    </section>
  );
}
