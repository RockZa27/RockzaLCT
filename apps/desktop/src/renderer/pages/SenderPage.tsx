import { useCallback, useEffect, useState } from 'react';
import {
  SENDER_INPUT_SOURCES,
  type SenderInputSource,
  type SenderPortStatus,
  type SenderRedundancyStatus,
  type SenderVideoStatus,
} from '@rockzalct/shared';
import { useI18n } from '../i18n/I18nProvider';
import { useApp } from '../state/AppContext';

const clampInt = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(n)));

export function SenderPage() {
  const { t } = useI18n();
  const { api, connectedId, level, run, pushInfo } = useApp();
  const disabled = connectedId === null;
  const locked = level !== 'advanced';
  const advancedDisabled = disabled || locked;

  const [video, setVideo] = useState<SenderVideoStatus | null>(null);
  const [ports, setPorts] = useState<SenderPortStatus[] | null>(null);
  const [redundancy, setRedundancy] = useState<SenderRedundancyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);

  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [fieldRate, setFieldRate] = useState(0);
  const [source, setSource] = useState<SenderInputSource>('DVI');

  const adoptVideo = useCallback((v: SenderVideoStatus) => {
    setVideo(v);
    setWidth(v.resolution.width);
    setHeight(v.resolution.height);
    setFieldRate(v.fieldRate);
    if (v.inputSource) setSource(v.inputSource);
  }, []);

  // Read everything from the device whenever a controller becomes active (and on Refresh).
  const fetchAll = useCallback(
    async (id: string) =>
      Promise.all([
        run(() => api.getSenderVideo(id)),
        run(() => api.getSenderPorts(id)),
        run(() => api.getSenderRedundancy(id)),
      ]),
    [api, run],
  );

  const load = useCallback(async () => {
    if (!connectedId) return;
    const [v, p, r] = await fetchAll(connectedId);
    setVideoFailed(!v);
    if (v) adoptVideo(v);
    if (p) setPorts(p);
    if (r) setRedundancy(r);
  }, [connectedId, fetchAll, adoptVideo]);

  useEffect(() => {
    setVideo(null);
    setPorts(null);
    setRedundancy(null);
    setVideoFailed(false);
    if (!connectedId) return;
    let cancelled = false;
    void fetchAll(connectedId).then(([v, p, r]) => {
      if (cancelled) return;
      setVideoFailed(!v);
      if (v) adoptVideo(v);
      if (p) setPorts(p);
      if (r) setRedundancy(r);
    });
    return () => {
      cancelled = true;
    };
  }, [connectedId, fetchAll, adoptVideo]);

  const apply = async (call: () => Promise<SenderVideoStatus>, done: string) => {
    setBusy(true);
    try {
      const v = await run(call);
      if (v) {
        adoptVideo(v);
        pushInfo(done);
      }
    } finally {
      setBusy(false);
    }
  };

  const togglePort = async (portIndex: number, enabled: boolean) => {
    if (!connectedId) return;
    setBusy(true);
    try {
      const p = await run(() => api.setSenderPortEnabled(connectedId, portIndex, enabled));
      if (p) {
        setPorts(p);
        pushInfo(t('sender.ports.applied'));
      }
    } finally {
      setBusy(false);
    }
  };

  // The video writes must never run with the placeholder defaults (DVI / 0): wait for a real read.
  const videoDisabled = advancedDisabled || video === null;

  const lockBadge = locked && (
    <span className="muted" data-testid="locked-badge">
      {' '}
      [{t('sender.locked')}]
    </span>
  );

  return (
    <section>
      <h1>{t('sender.title')}</h1>
      {disabled && <p className="muted">{t('sender.needConnect')}</p>}
      {!disabled && locked && (
        <p className="muted" data-testid="advanced-note">
          {t('sender.advancedOnly')}
        </p>
      )}
      <div className="row">
        <button type="button" disabled={disabled || busy} onClick={() => void load()}>
          {t('sender.refresh')}
        </button>
      </div>
      {!disabled && videoFailed && (
        <div className="field-error" role="alert" data-testid="sender-load-error">
          <p>{t('sender.loadFailed')}</p>
          <button type="button" onClick={() => void load()}>
            {t('sender.retry')}
          </button>
        </div>
      )}
      {!disabled && !videoFailed && video === null && <p className="muted">{t('sender.loading')}</p>}

      <div className="card">
        <h2>{t('sender.video.title')}</h2>
        <dl className="kv">
          <div className="kv-row">
            <dt>{t('sender.video.signal')}</dt>
            <dd data-testid="video-signal">
              {video ? t(video.signalPresent ? 'sender.video.signal.yes' : 'sender.video.signal.no') : '-'}
            </dd>
          </div>
          <div className="kv-row">
            <dt>{t('sender.video.measuredRate')}</dt>
            <dd data-testid="video-measured">{video ? video.measuredFieldRate : '-'}</dd>
          </div>
          <div className="kv-row">
            <dt>{t('sender.video.rateMode')}</dt>
            <dd data-testid="video-mode">{video ? video.fieldRateMode : '-'}</dd>
          </div>
        </dl>
        <p className="muted">{t('sender.video.rateNote')}</p>

        <h3>
          {t('sender.video.applyResolution')}
          {lockBadge}
        </h3>
        <div className="row">
          <label className="field">
            {t('sender.video.width')}
            <input
              type="number"
              min={1}
              max={65535}
              value={width}
              disabled={videoDisabled}
              aria-label={t('sender.video.width')}
              onChange={(e) => e.target.value !== '' && setWidth(clampInt(Number(e.target.value), 1, 65535))}
            />
          </label>
          <label className="field">
            {t('sender.video.height')}
            <input
              type="number"
              min={1}
              max={65535}
              value={height}
              disabled={videoDisabled}
              aria-label={t('sender.video.height')}
              onChange={(e) => e.target.value !== '' && setHeight(clampInt(Number(e.target.value), 1, 65535))}
            />
          </label>
          <button
            type="button"
            className="primary"
            disabled={videoDisabled || busy}
            onClick={() =>
              connectedId &&
              void apply(() => api.setSenderResolution(connectedId, { width, height }), t('sender.video.resolutionApplied'))
            }
          >
            {t('sender.video.applyResolution')}
          </button>
        </div>

        <h3>
          {t('sender.video.fieldRate')}
          {lockBadge}
        </h3>
        <div className="row">
          <input
            type="number"
            min={0}
            max={65535}
            value={fieldRate}
            disabled={videoDisabled}
            aria-label={t('sender.video.fieldRate')}
            onChange={(e) => e.target.value !== '' && setFieldRate(clampInt(Number(e.target.value), 0, 65535))}
          />
          <button
            type="button"
            className="primary"
            disabled={videoDisabled || busy}
            onClick={() =>
              connectedId &&
              void apply(() => api.setSenderFieldRate(connectedId, fieldRate), t('sender.video.fieldRateApplied'))
            }
          >
            {t('sender.video.applyFieldRate')}
          </button>
        </div>

        <h3>
          {t('sender.video.source')}
          {lockBadge}
        </h3>
        {video && video.inputSource === null && (
          <p className="muted" data-testid="source-unknown">
            {t('sender.video.sourceUnknown', { raw: video.inputSourceRaw })}
          </p>
        )}
        <div className="row">
          <select
            value={source}
            disabled={videoDisabled}
            aria-label={t('sender.video.source')}
            onChange={(e) => setSource(e.target.value as SenderInputSource)}
          >
            {SENDER_INPUT_SOURCES.map((s) => (
              <option key={s} value={s}>
                {t(`sender.source.${s}`)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="primary"
            disabled={videoDisabled || busy}
            onClick={() =>
              connectedId &&
              void apply(() => api.setSenderInputSource(connectedId, source), t('sender.video.sourceApplied'))
            }
          >
            {t('sender.video.applySource')}
          </button>
        </div>
      </div>

      <div className="card">
        <h2>
          {t('sender.ports.title')}
          {lockBadge}
        </h2>
        {ports && ports.length === 0 && <p className="muted">{t('sender.ports.empty')}</p>}
        {ports && ports.length > 0 && (
          <table data-testid="ports-table">
            <thead>
              <tr>
                <th>{t('sender.ports.col.port')}</th>
                <th>{t('sender.ports.col.enabled')}</th>
                <th>{t('sender.ports.col.area')}</th>
                <th>{t('sender.ports.col.pixels')}</th>
                <th>{t('sender.ports.col.cards')}</th>
              </tr>
            </thead>
            <tbody>
              {ports.map((p) => (
                <tr key={p.portIndex} data-testid={`port-row-${p.portIndex}`}>
                  <td>{p.portIndex + 1}</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={p.enabled}
                      disabled={advancedDisabled || busy}
                      aria-label={t('sender.ports.toggle', { n: p.portIndex + 1 })}
                      onChange={(e) => void togglePort(p.portIndex, e.target.checked)}
                    />
                  </td>
                  <td>
                    {p.width} × {p.height}
                  </td>
                  <td data-testid={`port-pixels-${p.portIndex}`}>{p.pixels.toLocaleString('en-US')}</td>
                  <td>{p.receivingCards}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">{t('sender.ports.note')}</p>
      </div>

      <div className="card">
        <h2>{t('sender.redundancy.title')}</h2>
        {redundancy && (
          <>
            <dl className="kv">
              <div className="kv-row">
                <dt>{t('sender.redundancy.loadMode')}</dt>
                <dd data-testid="redundancy-mode">{t(`sender.redundancy.mode.${redundancy.loadMode}`)}</dd>
              </div>
            </dl>
            <table data-testid="redundancy-table">
              <thead>
                <tr>
                  <th>{t('sender.redundancy.col.port')}</th>
                  {redundancy.spaces.map((sp) => (
                    <th key={sp.space}>{t(`sender.redundancy.space.${sp.space}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(redundancy.spaces[0]?.ports ?? []).map((p) => (
                  <tr key={p.portIndex}>
                    <td>{p.portIndex + 1}</td>
                    {redundancy.spaces.map((sp) => (
                      <td key={sp.space} data-testid={`redundancy-${sp.space}-${p.portIndex}`}>
                        {t(`sender.redundancy.state.${sp.ports[p.portIndex]?.state ?? 'unknown'}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">{t('sender.redundancy.note')}</p>
          </>
        )}
      </div>
    </section>
  );
}
