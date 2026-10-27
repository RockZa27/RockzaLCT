// Taurus management-protocol simulator state and command handling.
//
// Command triples (what, type, action) and the JSON field names are the ones @novastar/taurus 0.4.1
// uses (dist/index.mjs, TaurusClient); the simulator answers exactly those, so the real library
// client is the only thing that decides whether the shapes are right. Anything the library does
// not read, and every status code below, is the simulator's own choice and UNVERIFIED against a
// real player:
//   - the status numbers (the library only checks `status !== 0`)
//   - what an unauthenticated request gets (here: STATUS_NOT_LOGGED_IN)
//   - whether a wrong password is answered with `logined: false` (default) or an error status
//     (`rejectLoginWithStatus`)
//   - the brightness reply carries only `ratio` (the library writes `ratio: percent`); the unit of
//     the `brightness` field is unknown, so it is only sent when `brightnessFields` asks for it

export const STATUS_OK = 0;
/** Simulator-defined (UNVERIFIED): request needs a logged-in session. */
export const STATUS_NOT_LOGGED_IN = 0x0101;
/** Simulator-defined (UNVERIFIED): body missing or out of range. */
export const STATUS_BAD_REQUEST = 0x0102;
/** Simulator-defined (UNVERIFIED): command triple the simulator does not implement. */
export const STATUS_UNKNOWN_COMMAND = 0x0103;
/** Simulator-defined (UNVERIFIED): login refused, used when `rejectLoginWithStatus` is set. */
export const STATUS_LOGIN_REFUSED = 0x0104;

/** (what, type, action) of every command, from the library's TaurusClient. */
export const CMD = {
  login: [0, 0, 0],
  getBrightness: [24, 1, 5],
  setBrightness: [24, 1, 4],
  getEnvironmentBrightness: [26, 0, 5],
  getLedScreen: [27, 1, 5],
  setLedScreen: [27, 1, 4],
  getVideoConfig: [39, 1, 5],
  setVideoConfig: [39, 1, 4],
  getHdmiResolution: [39, 2, 5],
  setHdmiResolution: [39, 2, 4],
  getCurrentVideoSource: [39, 5, 5],
  getVideoSources: [39, 8, 5],
  getCardVersions: [46, 7, 5],
  getMonitorTopology: [33, 7, 5],
  getMonitorData: [33, 8, 5],
} as const;

export const cmdKey = (what: number, type: number, action: number): string => `${what}:${type}:${action}`;

export interface SimScanInfo {
  width: number;
  height: number;
  x: number;
  y: number;
  xInPort: number;
  yInPort: number;
  colIndex: number;
  rowIndex: number;
  portIndex: number;
  connectIndex: number;
}

export interface SimScreenAttribute {
  id: number;
  screenSource: number;
  screenType: number;
  xCount: number;
  yCount: number;
  xOffset: number;
  yOffset: number;
  portNumber: number;
  orders: number[];
  scanInfos: SimScanInfo[];
}

export interface SimReceivingCard {
  port: number;
  card: number;
  modelId: number;
  fpga: string;
  mcu: string;
}

export interface TaurusSimulatorOptions {
  host?: string;
  /** TCP management port; 0 = pick a free one (default 16606). */
  port?: number;
  /** UDP discovery port; 0 = free port, null = no discovery socket (default 16601). */
  discoveryPort?: number | null;
  username?: string;
  /** Accepted by login. Default 'taurus' (simulator only; the real client never defaults one). */
  password?: string;
  sn?: string;
  productName?: string;
  /** Serve the management port over TLS (privacy mode) with this PEM key/cert. */
  tls?: { key: string; cert: string };
  /** Wrong password answered with an error status instead of `logined: false`. */
  rejectLoginWithStatus?: boolean;
}

export interface TaurusSimulatorState {
  username: string;
  password: string;
  sn: string;
  productName: string;
  modelId: number;
  aliasName: string;
  platform: string;
  /** Brightness percentage (what `setBrightness(percent)` wrote as `ratio`). */
  ratio: number;
  /** Last value written with `solidity: true`. */
  persistedRatio?: number;
  /** Which fields getBrightness answers with. Default ['ratio']. */
  brightnessFields: Array<'ratio' | 'brightness'>;
  /** Ambient light value, or null for "no sensor" (the player answers -1000). */
  lightSensor: number | null;
  video: { enable: boolean; isScale: boolean; offsetX: number; offsetY: number; videoMode: number; videoSource: number };
  hdmi: { width: number; height: number; fieldRate: number };
  screens: SimScreenAttribute[];
  cards: SimReceivingCard[];
  rejectLoginWithStatus: boolean;
  /** Stop answering (TCP and UDP) to exercise client timeouts. */
  mute: boolean;
  /** Command keys (see cmdKey) answered with STATUS_BAD_REQUEST. */
  failFor: Set<string>;
  received: Array<{ what: number; type: number; action: number; body: unknown }>;
  logins: { accepted: number; rejected: number };
}

/** Per-connection state: login is per TCP session. */
export interface TaurusSession {
  authed: boolean;
}

export function createTaurusState(opts: TaurusSimulatorOptions = {}): TaurusSimulatorState {
  const scan = (col: number): SimScanInfo => ({
    width: 128,
    height: 128,
    x: col * 128,
    y: 0,
    xInPort: col * 128,
    yInPort: 0,
    colIndex: col,
    rowIndex: 0,
    portIndex: 0,
    connectIndex: col,
  });
  return {
    username: opts.username ?? 'admin',
    password: opts.password ?? 'taurus',
    sn: opts.sn ?? 'SIMTB60000000001',
    productName: opts.productName ?? 'TB60',
    modelId: 0x6001,
    aliasName: 'Simulated Taurus',
    platform: 'simulator',
    ratio: 60,
    brightnessFields: ['ratio'],
    lightSensor: 320,
    video: { enable: true, isScale: false, offsetX: 0, offsetY: 0, videoMode: 1, videoSource: 0 },
    hdmi: { width: 1920, height: 1080, fieldRate: 60 },
    screens: [
      {
        id: 0,
        screenSource: 0,
        screenType: 0,
        xCount: 2,
        yCount: 1,
        xOffset: 0,
        yOffset: 0,
        portNumber: 1,
        orders: [0],
        scanInfos: [scan(0), scan(1)],
      },
    ],
    cards: [
      { port: 0, card: 0, modelId: 0x1a01, fpga: '1.2.3.4', mcu: '2.0.1.0' },
      { port: 0, card: 1, modelId: 0x1a01, fpga: '1.2.3.4', mcu: '2.0.1.0' },
    ],
    rejectLoginWithStatus: opts.rejectLoginWithStatus ?? false,
    mute: false,
    failFor: new Set(),
    received: [],
    logins: { accepted: 0, rejected: 0 },
  };
}

export interface TaurusReply {
  status: number;
  /** JSON-serialised as the response body; a string is sent as is (used for error text). */
  body?: unknown;
}

const ok = (body?: unknown): TaurusReply => ({ status: STATUS_OK, body });
const bad = (why: string): TaurusReply => ({ status: STATUS_BAD_REQUEST, body: why });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Body of the discovery answer; field names are those of the library's `TaurusPlayerInfo`. */
export function discoveryInfo(state: TaurusSimulatorState, tcpPort: number, privacy: boolean): Record<string, unknown> {
  return {
    sn: state.sn,
    tcpPort,
    productName: state.productName,
    modelId: state.modelId,
    aliasName: state.aliasName,
    platform: state.platform,
    privacy,
    encodeType: 0,
    width: 256,
    height: 128,
    rotation: 0,
  };
}

export function handleTaurusCommand(
  state: TaurusSimulatorState,
  session: TaurusSession,
  what: number,
  type: number,
  action: number,
  body: unknown,
): TaurusReply {
  state.received.push({ what, type, action, body });
  const key = cmdKey(what, type, action);
  const is = (c: readonly [number, number, number]): boolean => cmdKey(...c) === key;

  if (is(CMD.login)) {
    const b = isRecord(body) ? body : {};
    const good = b['sn'] === state.sn && b['username'] === state.username && b['password'] === state.password;
    if (good) {
      session.authed = true;
      state.logins.accepted += 1;
      return ok({ logined: true, validation: true, username: state.username, sn: state.sn });
    }
    state.logins.rejected += 1;
    session.authed = false;
    return state.rejectLoginWithStatus
      ? { status: STATUS_LOGIN_REFUSED, body: 'login refused' }
      : ok({ logined: false, validation: false, username: String(b['username'] ?? ''), sn: state.sn });
  }

  if (!session.authed) return { status: STATUS_NOT_LOGGED_IN, body: 'not logged in' };
  if (state.failFor.has(key)) return bad('forced failure');

  if (is(CMD.getBrightness)) {
    return ok({
      ...(state.brightnessFields.includes('ratio') ? { ratio: state.ratio } : {}),
      ...(state.brightnessFields.includes('brightness') ? { brightness: state.ratio } : {}),
      solidity: state.persistedRatio === state.ratio,
      orderId: -1,
    });
  }
  if (is(CMD.setBrightness)) {
    const b = isRecord(body) ? body : {};
    const ratio = b['ratio'];
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 100) return bad('ratio out of range');
    state.ratio = ratio;
    if (b['solidity'] === true) state.persistedRatio = ratio;
    return ok();
  }
  if (is(CMD.getEnvironmentBrightness)) return ok({ value: state.lightSensor ?? -1000 });

  if (is(CMD.getVideoConfig)) {
    const v = state.video;
    return ok({
      enable: v.enable,
      isScale: v.isScale,
      offsetX: v.offsetX,
      offsetY: v.offsetY,
      videoMode: v.videoMode,
      videoSource: v.videoSource,
      conditions: [],
      orderId: -1,
    });
  }
  if (is(CMD.setVideoConfig)) {
    const b = isRecord(body) ? body : {};
    const mode = b['videoMode'];
    const source = b['videoSource'];
    if (![0, 1, 2].includes(mode as number) || ![0, 1].includes(source as number)) return bad('invalid video mode/source');
    state.video = {
      enable: b['enable'] === true,
      isScale: b['isScale'] === true,
      offsetX: Number(b['offsetX'] ?? 0),
      offsetY: Number(b['offsetY'] ?? 0),
      videoMode: mode as number,
      videoSource: source as number,
    };
    return ok();
  }
  if (is(CMD.getCurrentVideoSource)) return ok({ videoSource: state.video.videoSource });
  if (is(CMD.getVideoSources)) {
    return ok({
      currentSource: state.video.videoSource,
      videoSourceList: [
        {
          sourceNum: 0,
          name: 'Internal',
          isInternalSource: true,
          linkStatus: true,
          width: 1920,
          height: 1080,
          rate: 60,
          sourceFPS: [30, 60],
          supportResolutions: [],
          supportCustomResolution: false,
        },
        {
          sourceNum: 1,
          name: 'HDMI',
          isInternalSource: false,
          linkStatus: true,
          width: state.hdmi.width,
          height: state.hdmi.height,
          rate: state.hdmi.fieldRate,
          sourceFPS: [30, 50, 60],
          supportResolutions: [
            { width: 1920, height: 1080, fps: [30, 50, 60] },
            { width: 1280, height: 720, fps: [60] },
          ],
          supportCustomResolution: true,
          hdmiInfo: { type: 'HDMI', minWidth: 640, maxWidth: 3840, minHeight: 480, maxHeight: 2160 },
        },
      ],
    });
  }
  if (is(CMD.getHdmiResolution)) {
    return ok({ width: state.hdmi.width, height: state.hdmi.height, fieldRate: state.hdmi.fieldRate });
  }
  if (is(CMD.setHdmiResolution)) {
    const b = isRecord(body) ? body : {};
    const { width, height, fieldRate } = b;
    if (![width, height, fieldRate].every((n) => typeof n === 'number' && n > 0)) return bad('invalid resolution');
    state.hdmi = { width: width as number, height: height as number, fieldRate: fieldRate as number };
    return ok();
  }

  if (is(CMD.getLedScreen)) return ok({ screenAttributes: structuredClone(state.screens) });
  if (is(CMD.setLedScreen)) {
    const b = isRecord(body) ? body : {};
    if (!Array.isArray(b['screenAttributes']) || b['screenAttributes'].length === 0) return bad('no screens');
    state.screens = structuredClone(b['screenAttributes']) as SimScreenAttribute[];
    return ok();
  }

  if (is(CMD.getCardVersions)) {
    const b = isRecord(body) ? body : {};
    const wanted = Array.isArray(b['receiveCardList']) ? (b['receiveCardList'] as Array<Record<string, unknown>>) : [];
    const list = wanted.flatMap((w) => {
      const card = state.cards.find((c) => c.port === w['portIndex'] && c.card === w['connectedIndex']);
      return card ? [{ portIndex: card.port, connectedIndex: card.card, modelId: card.modelId }] : [];
    });
    return ok({ receiveCardList: list });
  }
  if (is(CMD.getMonitorTopology)) return ok({ screens: state.screens.map((s) => ({ id: s.id })) });
  if (is(CMD.getMonitorData)) {
    return ok({
      screenMonitorData: state.cards.map((c) => ({
        receiveCardMonitorInfo: {
          portIndex: c.port,
          connectIndex: c.card,
          fpgaHardwareVersionInfo: c.fpga,
          mcuHardwareVersionInfo: c.mcu,
        },
      })),
    });
  }

  return { status: STATUS_UNKNOWN_COMMAND, body: `unknown command ${key}` };
}
