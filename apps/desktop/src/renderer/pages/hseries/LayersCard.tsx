import { useState } from 'react';
import { HSERIES_WHOLE_SOURCE, type HSeriesInput, type HSeriesLayer, type HSeriesScreen } from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';

const keyOf = (i: { inputId: number; cropId: number }): string => `${i.inputId}:${i.cropId}`;

export function LayersCard({
  screens,
  layers,
  inputs,
  locked,
  busy,
  onSwitch,
}: {
  screens: HSeriesScreen[] | null;
  layers: HSeriesLayer[] | null;
  inputs: HSeriesInput[] | null;
  locked: boolean;
  busy: boolean;
  onSwitch(layer: HSeriesLayer, input: HSeriesInput): void;
}) {
  const { t } = useI18n();
  // Chosen input per layer; nothing is preselected, so Apply stays disabled until the user picks.
  const [choice, setChoice] = useState<Record<string, string>>({});
  const online = (inputs ?? []).filter((i) => i.online);
  const label = (i: HSeriesInput): string =>
    i.cropId === HSERIES_WHOLE_SOURCE ? i.name : t('hs.layers.crop', { name: i.name, crop: i.cropId + 1 });

  return (
    <div className="card" data-testid="hs-layers">
      <h2>{t('hs.layers.title')}</h2>
      {inputs !== null && online.length === 0 ? (
        <p className="muted">{t('hs.layers.noInputs')}</p>
      ) : (
        <p className="muted">{t('hs.layers.signalNote')}</p>
      )}
      {(screens ?? []).map((s) => {
        const list = (layers ?? []).filter((l) => l.screenId === s.screenId);
        return (
          <div key={s.screenId}>
            <h3>{s.name}</h3>
            {list.length === 0 ? (
              <p className="muted">{t('hs.layers.empty')}</p>
            ) : (
              list.map((l) => {
                const k = `${l.screenId}:${l.layerId}`;
                const picked = choice[k] ?? '';
                const input = online.find((i) => keyOf(i) === picked);
                return (
                  <div className="row" key={k} style={{ alignItems: 'center' }}>
                    <span style={{ minWidth: 120 }}>{l.name}</span>
                    <select
                      value={picked}
                      disabled={locked || busy}
                      aria-label={`${t('hs.layers.input')}: ${s.name} / ${l.name}`}
                      onChange={(e) => setChoice((c) => ({ ...c, [k]: e.target.value }))}
                    >
                      <option value="">{t('hs.layers.pick')}</option>
                      {online.map((i) => (
                        <option key={keyOf(i)} value={keyOf(i)}>
                          {label(i)}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={locked || busy || !input}
                      aria-label={`${t('hs.layers.apply')}: ${s.name} / ${l.name}`}
                      onClick={() => input && onSwitch(l, input)}
                    >
                      {t('hs.layers.apply')}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        );
      })}
    </div>
  );
}
