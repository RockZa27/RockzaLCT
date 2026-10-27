import { useEffect, useState } from 'react';
import type { FunctionCardInfo, PowerControlMode, RelayState, RelayStatus } from '@rockzalct/shared';
import { FUNCTION_CARD_RELAY_COUNT } from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';
import { useApp } from '../../state/AppContext';
import { ConfirmDialog } from '../persist/ConfirmDialog';

type Pending =
  | { kind: 'relay'; relay: number | 'all'; on: boolean }
  | { kind: 'mode'; mode: PowerControlMode };

const hms = (v: readonly number[]): string => v.map((n) => String(n).padStart(2, '0')).join(':');

export function FunctionCardPanel({
  addressText,
  address,
  onAddress,
  onCommit,
}: {
  addressText: string;
  address: number | null;
  onAddress(text: string): void;
  /** Called when the address should be remembered. */
  onCommit(): void;
}) {
  const { t } = useI18n();
  const { api, connectedId, level, run, pushInfo } = useApp();
  const advanced = level === 'advanced';
  const [info, setInfo] = useState<FunctionCardInfo | null>(null);
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    setInfo(null);
    setStatus(null);
    setPending(null);
  }, [connectedId, address]);

  const canRun = connectedId !== null && address !== null && !busy;

  const read = async () => {
    if (!connectedId || address === null) return;
    onCommit();
    setBusy(true);
    try {
      const [i, s] = await Promise.all([
        run(() => api.readFunctionCardInfo(connectedId, address)),
        run(() => api.readRelayStatus(connectedId, address)),
      ]);
      if (i) setInfo(i);
      if (s) setStatus(s);
    } finally {
      setBusy(false);
    }
  };

  const stateText = (state: RelayState, raw: number): string => t(`maint.relay.state.${state}`, { raw });
  const modeText = (mode: PowerControlMode): string => (mode === 'manual' ? t('maint.fc.modeManual') : t('maint.fc.modeAuto'));
  const targetText = (relay: number | 'all'): string =>
    relay === 'all' ? t('maint.relay.total') : t('maint.relay.index', { n: relay + 1 });

  const confirm = async () => {
    const p = pending;
    setPending(null);
    if (!p || !connectedId || address === null) return;
    setBusy(true);
    try {
      if (p.kind === 'relay') {
        const res = await run(() => api.setRelay(connectedId, address, { relay: p.relay, on: p.on, confirmed: true }));
        if (res) {
          const params = { target: targetText(res.relay), value: res.written, back: res.readBack ?? '-' };
          pushInfo(t(res.verified ? 'maint.relay.done' : 'maint.relay.notEchoed', params));
        }
      } else {
        const res = await run(() => api.setPowerControlMode(connectedId, address, p.mode, true));
        if (res) pushInfo(t('maint.mode.done', { mode: modeText(res.mode) }));
      }
      const s = await run(() => api.readRelayStatus(connectedId, address));
      if (s) setStatus(s);
    } finally {
      setBusy(false);
    }
  };

  const relayRow = (relay: number | 'all', state: RelayState, raw: number, schedule?: string) => (
    <tr key={String(relay)}>
      <td>{targetText(relay)}</td>
      <td data-testid={`relay-state-${relay}`}>{stateText(state, raw)}</td>
      <td className="muted">{schedule ?? ''}</td>
      <td>
        <div className="row">
          <button type="button" disabled={!canRun || !advanced} aria-label={`${t('maint.relay.on')} ${targetText(relay)}`} onClick={() => setPending({ kind: 'relay', relay, on: true })}>
            {t('maint.relay.on')}
          </button>
          <button type="button" disabled={!canRun || !advanced} aria-label={`${t('maint.relay.off')} ${targetText(relay)}`} onClick={() => setPending({ kind: 'relay', relay, on: false })}>
            {t('maint.relay.off')}
          </button>
        </div>
      </td>
    </tr>
  );

  return (
    <div className="card" role="group" aria-labelledby="maint-fc-title">
      <h2 id="maint-fc-title">{t('maint.fc.title')}</h2>
      <p className="muted">{t('maint.fc.desc')}</p>
      <label className="field">
        <span>{t('maint.fc.address')}</span>
        <input
          inputMode="numeric"
          value={addressText}
          onChange={(e) => onAddress(e.target.value)}
          onBlur={onCommit}
          aria-label={t('maint.fc.address')}
          aria-invalid={addressText !== '' && address === null}
        />
      </label>
      {addressText !== '' && address === null ? (
        <p className="field-error" role="alert">
          {t('maint.fc.addressInvalid')}
        </p>
      ) : (
        <p className="muted">{t('maint.fc.addressRemembered')}</p>
      )}
      {!advanced && <p className="muted">{t('maint.advancedOnly')}</p>}
      <div className="row">
        <button type="button" className="primary" disabled={!canRun} onClick={read}>
          {busy ? t('maint.fc.reading') : t('maint.fc.read')}
        </button>
      </div>

      {info && (
        <dl className="kv" data-testid="fc-info">
          <dt>{t('maint.fc.model')}</dt>
          <dd>0x{info.modelId.toString(16).toUpperCase().padStart(4, '0')}</dd>
          <dt>{t('maint.fc.mcu')}</dt>
          <dd>{info.mcuVersion}</dd>
          <dt>{t('maint.fc.fpga')}</dt>
          <dd>{info.fpgaVersion}</dd>
          <dt>{t('maint.fc.golden')}</dt>
          <dd>{info.goldenFpgaVersion}</dd>
          <dt>{t('maint.fc.clock')}</dt>
          <dd>
            {String(info.clock.year).padStart(2, '0')}-{String(info.clock.month).padStart(2, '0')}-
            {String(info.clock.day).padStart(2, '0')} {hms([info.clock.hour, info.clock.minute, info.clock.second])}
          </dd>
        </dl>
      )}

      {status && (
        <div data-testid="relay-status">
          <h3>{t('maint.relay.title')}</h3>
          <p className="muted">{t('maint.relay.unverified')}</p>
          <table>
            <thead>
              <tr>
                <th />
                <th />
                <th>{t('maint.relay.schedule')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {status.relays
                .slice(0, FUNCTION_CARD_RELAY_COUNT)
                .map((r) => {
                  const sc = status.schedule[r.index];
                  return relayRow(r.index, r.state, r.raw, sc ? `${hms(sc.open)} - ${hms(sc.close)}` : undefined);
                })}
              {relayRow('all', status.total.state, status.total.raw)}
            </tbody>
          </table>
          <p>
            {t('maint.fc.mode')}:{' '}
            <strong data-testid="relay-mode">
              {status.mode === null ? t('maint.fc.modeUnknown', { raw: status.modeRaw }) : modeText(status.mode)}
            </strong>
          </p>
          <div className="row">
            <button type="button" disabled={!canRun || !advanced} onClick={() => setPending({ kind: 'mode', mode: status.mode === 'auto' ? 'manual' : 'auto' })}>
              {t('maint.fc.setMode')}
            </button>
          </div>
        </div>
      )}

      {pending?.kind === 'relay' && (
        <ConfirmDialog
          title={t('maint.relay.confirmTitle')}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        >
          <p>{t(pending.on ? 'maint.relay.confirmOn' : 'maint.relay.confirmOff', { target: targetText(pending.relay) })}</p>
        </ConfirmDialog>
      )}
      {pending?.kind === 'mode' && (
        <ConfirmDialog title={t('maint.mode.confirmTitle')} onConfirm={confirm} onCancel={() => setPending(null)}>
          <p>{t('maint.mode.confirmBody', { mode: modeText(pending.mode) })}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
