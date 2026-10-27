import { useCallback, useEffect, useMemo, useState } from 'react';
import { isFullCoefficientBackup } from './calibration/backup';
import { useI18n } from '../i18n/I18nProvider';
import { useApp } from '../state/AppContext';
import { DownloadSection } from './calibration/DownloadSection';
import { FlashSection } from './calibration/FlashSection';
import { StateSection } from './calibration/StateSection';
import { UnsupportedSection } from './calibration/UnsupportedSection';
import { UploadSection } from './calibration/UploadSection';

/** PLAN.md phase 8: calibration coefficient management of one receiving card at a time. */
export function CalibrationPage() {
  const { t } = useI18n();
  const { connectedId, info } = useApp();
  const cards = useMemo(() => info?.receivingCards ?? [], [info]);
  const [selected, setSelected] = useState('');
  // The card cannot be changed while a transfer runs: it would hide the progress and the cancel button.
  const [busy, setBusy] = useState({ dl: false, up: false, fl: false });
  const transferring = busy.dl || busy.up || busy.fl;
  // Cards whose WHOLE coefficient region was downloaded to a file in this session ("port:card"); unlocks
  // store / erase of that card only. Erase wipes the whole flash copy, so a partial download must not count.
  const [backedUp, setBackedUp] = useState<ReadonlySet<string>>(() => new Set());
  const onBackedUp = useCallback((c: { portIndex: number; cardIndex: number }, range: { offset: number; length: number }) => {
    if (!isFullCoefficientBackup(range)) return;
    setBackedUp((s) => new Set(s).add(`${c.portIndex}:${c.cardIndex}`));
  }, []);
  const onFlBusy = useCallback((b: boolean) => setBusy((s) => (s.fl === b ? s : { ...s, fl: b })), []);
  const onDlBusy = useCallback((b: boolean) => setBusy((s) => (s.dl === b ? s : { ...s, dl: b })), []);
  const onUpBusy = useCallback((b: boolean) => setBusy((s) => (s.up === b ? s : { ...s, up: b })), []);

  // Select the first card whenever the connection (and so the card list) changes.
  useEffect(() => {
    const first = cards[0];
    setSelected(first ? `${first.portIndex}:${first.cardIndex}` : '');
  }, [cards]);

  const card = useMemo(() => {
    const [p, c] = selected.split(':').map(Number);
    const found = cards.find((x) => x.portIndex === p && x.cardIndex === c);
    return found ? { portIndex: found.portIndex, cardIndex: found.cardIndex } : null;
  }, [cards, selected]);

  const disconnected = connectedId === null;
  // Remount the sections when the card changes so no result or file from another card lingers.
  const cardKey = card ? `${connectedId}:${card.portIndex}:${card.cardIndex}` : 'none';

  return (
    <section>
      <h1>{t('cal.title')}</h1>
      <p className="muted">{t('cal.intro')}</p>
      {disconnected && <p className="muted">{t('cal.needConnect')}</p>}
      {!disconnected && cards.length === 0 && <p className="muted">{t('cal.noCards')}</p>}

      <div className="card">
        <label className="field">
          {t('cal.picker')}
          <select value={selected} disabled={disconnected || cards.length === 0 || transferring} onChange={(e) => setSelected(e.target.value)}>
            {cards.map((c) => (
              <option key={`${c.portIndex}:${c.cardIndex}`} value={`${c.portIndex}:${c.cardIndex}`}>
                {t('cal.pickerOption', { port: c.portIndex + 1, card: c.cardIndex + 1, model: c.model })}
              </option>
            ))}
          </select>
        </label>
      </div>

      <StateSection key={`state:${cardKey}`} card={card} />
      <DownloadSection key={`dl:${cardKey}`} card={card} onBusy={onDlBusy} onBackedUp={onBackedUp} />
      <UploadSection key={`up:${cardKey}`} card={card} onBusy={onUpBusy} onBackedUp={onBackedUp} />
      <FlashSection
        key={`fl:${cardKey}`}
        card={card}
        backedUp={card ? backedUp.has(`${card.portIndex}:${card.cardIndex}`) : false}
        onBackedUp={onBackedUp}
        onBusy={onFlBusy}
      />
      <UnsupportedSection />
    </section>
  );
}
