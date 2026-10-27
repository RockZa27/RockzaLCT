import type { ApplyStepResult } from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';
import type { MessageKey } from '../../i18n/dictionary';

/** The steps an apply ran, in order, with the outcome of each. */
export function StepList({ steps }: { steps: readonly ApplyStepResult[] }) {
  const { t } = useI18n();
  const label = (s: ApplyStepResult): string =>
    t(`persist.step.${s.kind}` as MessageKey, { port: s.portIndex === undefined ? '' : s.portIndex + 1, card: s.cardIndex === undefined ? '' : s.cardIndex + 1 });
  const detail = (s: ApplyStepResult): string => {
    if (!s.message) return '';
    if (s.status === 'skipped' && (s.message === 'unconfigured' || s.message === 'invalid')) {
      return t(`persist.reason.${s.message}` as MessageKey);
    }
    return s.message;
  };
  return (
    <ul data-testid="step-list" className="muted">
      {steps.map((s, n) => (
        <li key={n} data-status={s.status}>
          {t('persist.load.stepResult', { step: label(s), status: t(`persist.status.${s.status}` as MessageKey) })}
          {detail(s) ? ` (${detail(s)})` : ''}
        </li>
      ))}
    </ul>
  );
}
