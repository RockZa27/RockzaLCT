import { cardTemperatureC, type CardHealth, MonitorCardReading, MonitorCardRef } from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';
import { showTemp } from './format';

export function CardGrid({
  cards,
  healthOf,
  selected,
  onSelect,
}: {
  cards: readonly MonitorCardReading[];
  healthOf(card: MonitorCardReading): CardHealth;
  selected: MonitorCardRef | null;
  onSelect(ref: MonitorCardRef): void;
}) {
  const { t } = useI18n();
  return (
    <div className="mon-grid" data-testid="card-grid">
      {cards.map((c) => {
        const health = healthOf(c);
        const isSelected = selected?.portIndex === c.portIndex && selected.cardIndex === c.cardIndex;
        return (
          <button
            key={`${c.portIndex}-${c.cardIndex}`}
            type="button"
            className={`mon-tile ${health}`}
            aria-pressed={isSelected}
            data-testid={`card-tile-${c.portIndex}-${c.cardIndex}`}
            data-health={health}
            onClick={() => onSelect({ portIndex: c.portIndex, cardIndex: c.cardIndex })}
          >
            <span className="mon-tile-name">{t('monitor.card.name', { port: c.portIndex + 1, card: c.cardIndex + 1 })}</span>
            {/* Colour is never the only signal: the status word is always printed. */}
            <span className="mon-badge">{t(`monitor.health.${health}`)}</span>
            {c.state === 'online' && cardTemperatureC(c) !== null && (
              <span className="muted" title={t('monitor.rawTitle', { raw: showTemp(c.temperatureFlagsRaw, c.temperatureRaw).raw ?? '-' })}>
                {t('monitor.card.temp', { value: cardTemperatureC(c)!.toFixed(1) })}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
