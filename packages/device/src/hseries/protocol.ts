// H series UDP/JSON protocol: command codes, request builders and reply parsers.
//
// SOURCE (read-only reference, MIT, behaviour re-implemented here, nothing copied):
//   kman1898/companion-module-novastar-splicer v3.0.7, abbreviated below as
//     constant.js = utils/constant.js   index.js = utils/index.js   request.js = utils/request.js
//     main.js     = src/main.js         actions.js = src/actions.js  HELP.md = companion/HELP.md
//   Every `file:line` below is a line in that checkout. The official "H Series Control Protocol"
//   document (V1.0.19/V1.0.20) is NDA-only and was NOT read; fields the module does not use are
//   unknown. Anything inferred is marked UNVERIFIED.
//
// Wire format: one UDP datagram holds a JSON array with one object, e.g.
//   [{"cmd":"W0410","deviceId":0,"screenId":0,"brightness":50}]   (index.js:2-12 handleParams, deviceId at :7 and :12)
// A reply is a JSON array whose first element carries `cmd`, `ack` ("Ok" = success) and the payload
// fields (index.js:16-26 decodeRes: `const { cmd, ack, ...data } = JSON.parse(res)[0]`,
// `ack: Boolean(ack === 'Ok')`). Replies are matched to requests by `cmd` (index.js:42).

import { DeviceError } from '@rockzalct/shared';

/** Command codes. Each is cited with the line that defines it in constant.js. */
export const CMD = {
  /** Device init status / handshake; reply `rate`, ready at 100 (constant.js:53, main.js:1088-1103). */
  initStatus: 'R0118',
  /** Device details: `slotList[]` (constant.js:55, main.js:1188-1217). */
  deviceDetails: 'R0100',
  /** Screen list: `screens[]` (constant.js:5, main.js:1277). */
  screenList: 'R0400',
  /** Screen details: brightness, Freeze, Ftb ... (constant.js:27, main.js:1323-1336). */
  screenDetails: 'R0401',
  /** Layer list of one screen: `screenLayers[]` (constant.js:7, main.js:1302-1309). */
  layerList: 'R0500',
  /** Preset list of one screen: `presets[]` (constant.js:23, main.js:1313-1320). */
  presetList: 'R0600',
  /** Input list (simplified): `inputs[]` (constant.js:17, main.js:1141-1143). */
  inputList: 'R0226',
  /** Output connector list (constant.js:43, main.js:1368-1392). */
  outputList: 'R0300',
  /** Set screen brightness 0..100 (constant.js:39, actions.js:515-524). */
  screenBrightness: 'W0410',
  /** Save screen brightness to the LED receiving card (constant.js:59, actions.js:1114). */
  saveBrightness: 'W0417',
  /** Output test pattern, addressed by outputId (constant.js:45, actions.js:801-815). */
  testPattern: 'W0303',
  /** Screen fade-to-black (constant.js:29, actions.js:555). */
  screenFtb: 'W0409',
  /** Screen freeze (constant.js:35, actions.js:539). */
  screenFreeze: 'W040A',
  /** Global blackout (constant.js:61, actions.js:1138). */
  blackout: 'W0700',
  /** Load (play) a preset on a screen (constant.js:31, actions.js:131-134). */
  loadPreset: 'W0605',
  /** Switch the source of a layer (constant.js:41, actions.js:731-741). */
  sourceSwitch: 'W0506',
} as const;

export type HSeriesCmd = (typeof CMD)[keyof typeof CMD];

/**
 * Commands that must NOT be re-sent after a silent attempt: a lost reply does not mean the device did
 * not execute the command, and executing them twice has a visible effect.
 *  - W0605 load/play preset (actions.js:131-134): a second play restarts the preset (re-triggers
 *    its transition) and can override a change made in between.
 *  - W0506 layer source switch (actions.js:731-741): a second switch re-applies the source and can
 *    clobber a layer change the operator made after the first one.
 * Everything else is either a read (R*) or writes an explicit state (W0410 brightness value, W0409
 * FTB on/off, W040A freeze on/off, W0700 blackout 1/0, W0303 test pattern id, W0417 save), so
 * repeating it converges to the same state and retries are safe.
 */
export const NON_IDEMPOTENT_CMDS: ReadonlySet<string> = new Set([CMD.loadPreset, CMD.sourceSwitch]);

/**
 * The screen id a reply to `req` should echo in its `screenId` field, if any. Reads address the
 * screen with `param1` (R0401/R0500/R0600, request.js:3-79), writes with `screenId`. The reference
 * module reads `screenId` from R0401 replies (parseScreenDetails); the simulator echoes it on
 * R0401/R0500/R0600. Whether real firmware echoes it on every reply is UNVERIFIED, so a reply
 * WITHOUT the field is still accepted; a reply WITH a different id is never ours.
 */
export function expectedReplyScreenId(req: HSeriesRequest): number | undefined {
  const b = req.body;
  if (typeof b['screenId'] === 'number') return b['screenId'];
  if (
    (req.cmd === CMD.screenDetails || req.cmd === CMD.layerList || req.cmd === CMD.presetList) &&
    typeof b['param1'] === 'number'
  ) {
    return b['param1'];
  }
  return undefined;
}

/** Default UDP port (main.js:59 DEFAULT_CONFIG.port = '6000'; HELP.md:10). */
export const DEFAULT_HSERIES_PORT = 6000;

/** `deviceId` the module always uses (index.js:7 and :12, main.js:137). */
const DEVICE_ID = 0;

/** FTB `type` values: 0 = fade to black ON, 1 = OFF (constant.js:73-76, actions.js:555 comment). */
const FTB_ON = 0;
const FTB_OFF = 1;

/** Handshake is complete when `rate` reaches this (main.js:1091). */
export const INIT_READY_RATE = 100;

/** `cropId` 255 = the whole source (index.js:255, main.js:376-383 sourceLabel). */
export const WHOLE_SOURCE = 255;
/** `cardType` 3 = Sending card (constant.js:113 CARD_TYPES). */
const CARD_TYPE_SENDER = 3;

/**
 * Test pattern ids for W0303 `testPattern` (constant.js:146-180, from H Series Control Protocol
 * V1.0.20 Appendix 5.3 per the comment at constant.js:140-145).
 */
export const HSERIES_TEST_PATTERN = {
  off: 0xffff, // constant.js:147
  black: 0x0000, // :149
  red: 0x0001, // :150
  green: 0x0002, // :151
  blue: 0x0003, // :152
  white: 0x0004, // :153
  linesHorizontal: 0x0200, // :167
  linesVertical: 0x0201, // :168
  linesDiagonalLeft: 0x0202, // :170
  linesDiagonalRight: 0x0203, // :171
  gradientWhiteHorizontal: 0x0103, // :161
} as const;

/** Defaults for the three W0303 knobs: the per-connector action's defaults (actions.js:776 grid 5, :785 speed 3, :794 bright 3). */
export const TEST_PATTERN_DEFAULTS = { grid: 5, speed: 3, bright: 3 } as const;

export type JsonObject = Record<string, unknown>;

/** A request body: the command code plus its fields, ready for {@link encodeRequest}. */
export interface HSeriesRequest {
  cmd: HSeriesCmd;
  body: JsonObject;
}

/** One datagram: a JSON array with one object (index.js:2-12). */
export function encodeRequest(req: HSeriesRequest): Buffer {
  return Buffer.from(JSON.stringify([{ ...req.body, cmd: req.cmd }]));
}

// ---- request builders -------------------------------------------------------------------------

/** R0118: `{cmd, param0: deviceId}` without a deviceId field (main.js:1084). */
export const reqInitStatus = (): HSeriesRequest => ({ cmd: CMD.initStatus, body: { param0: DEVICE_ID } });
/** R0100: `{cmd, param0: deviceId}` (main.js:785). */
export const reqDeviceDetails = (): HSeriesRequest => ({ cmd: CMD.deviceDetails, body: { param0: DEVICE_ID } });
/** R0400: no parameters beyond deviceId (request.js:15-19). */
export const reqScreenList = (): HSeriesRequest => ({ cmd: CMD.screenList, body: { deviceId: DEVICE_ID } });
/** R0401: param0 = 0, param1 = screenId (request.js:73-79). */
export const reqScreenDetails = (screenId: number): HSeriesRequest => ({
  cmd: CMD.screenDetails,
  body: { deviceId: DEVICE_ID, param0: 0, param1: screenId },
});
/** R0500: param0 = 0, param1 = screenId (request.js:21-28). */
export const reqLayerList = (screenId: number): HSeriesRequest => ({
  cmd: CMD.layerList,
  body: { deviceId: DEVICE_ID, param0: 0, param1: screenId },
});
/** R0600: param0 = 0, param1 = screenId, param2 = 1, param3 = 0 (request.js:3-13). */
export const reqPresetList = (screenId: number): HSeriesRequest => ({
  cmd: CMD.presetList,
  body: { deviceId: DEVICE_ID, param0: 0, param1: screenId, param2: 1, param3: 0 },
});
/** R0226: param0..param3 all 0 (request.js:51-60). */
export const reqInputList = (): HSeriesRequest => ({
  cmd: CMD.inputList,
  body: { deviceId: DEVICE_ID, param0: 0, param1: 0, param2: 0, param3: 0 },
});
/** R0300: param0 = 0, param1 = 1 (request.js:105-112). */
export const reqOutputList = (): HSeriesRequest => ({
  cmd: CMD.outputList,
  body: { deviceId: DEVICE_ID, param0: 0, param1: 1 },
});
/** W0410 `{screenId, brightness}`, brightness an integer 0..100 (actions.js:515-524). */
export const reqScreenBrightness = (screenId: number, brightness: number): HSeriesRequest => ({
  cmd: CMD.screenBrightness,
  body: { deviceId: DEVICE_ID, screenId, brightness },
});
/** W0417 `{screenId}` (actions.js:1114). */
export const reqSaveBrightness = (screenId: number): HSeriesRequest => ({
  cmd: CMD.saveBrightness,
  body: { deviceId: DEVICE_ID, screenId },
});
/** W0303 `{outputId, testPattern, bright, grid, speed}` (actions.js:806-815). */
export const reqTestPattern = (
  outputId: number,
  testPattern: number,
  knobs: { bright: number; grid: number; speed: number } = TEST_PATTERN_DEFAULTS,
): HSeriesRequest => ({
  cmd: CMD.testPattern,
  body: { deviceId: DEVICE_ID, outputId, testPattern, bright: knobs.bright, grid: knobs.grid, speed: knobs.speed },
});
/** W0409 `{screenId, type}`, type 0 = FTB on, 1 = off (actions.js:555, constant.js:73-76). */
export const reqScreenFtb = (screenId: number, enabled: boolean): HSeriesRequest => ({
  cmd: CMD.screenFtb,
  body: { deviceId: DEVICE_ID, screenId, type: enabled ? FTB_ON : FTB_OFF },
});
/** W040A `{screenId, enable}`, enable 1 = freeze (actions.js:539, constant.js:68-71). */
export const reqScreenFreeze = (screenId: number, enabled: boolean): HSeriesRequest => ({
  cmd: CMD.screenFreeze,
  body: { deviceId: DEVICE_ID, screenId, enable: enabled ? 1 : 0 },
});
/** W0700 `{blackout}`, 1 = enable (actions.js:1128-1133 choices, :1138). */
export const reqBlackout = (enabled: boolean): HSeriesRequest => ({
  cmd: CMD.blackout,
  body: { deviceId: DEVICE_ID, blackout: enabled ? 1 : 0 },
});
/** W0605 `{screenId, presetId}` (actions.js:131-134). */
export const reqLoadPreset = (screenId: number, presetId: number): HSeriesRequest => ({
  cmd: CMD.loadPreset,
  body: { deviceId: DEVICE_ID, screenId, presetId },
});

/** The input fields W0506 needs (actions.js:731-741) as reported by R0226. */
export interface SourceRef {
  inputId: number;
  cropId: number;
  slotId?: number;
  interfaceType?: number;
}
/**
 * W0506 `{inputId, sourceType, interfaceType, slotId, templateId, cropId, streamId, screenId,
 * layerId}` (actions.js:731-741). sourceType 1, streamId 0 and templateId 0 are what the module
 * attaches to every R0226 input (index.js:255 / :260, actions.js:736). Other source types (IPC,
 * NDI: constant.js:19-21) are not handled. `interfaceType` / `slotId` are sent as the device
 * reported them; JSON.stringify drops them when the device did not report them (UNVERIFIED that
 * the device accepts the command without them).
 */
export const reqSourceSwitch = (screenId: number, layerId: number, src: SourceRef): HSeriesRequest => ({
  cmd: CMD.sourceSwitch,
  body: {
    deviceId: DEVICE_ID,
    inputId: src.inputId,
    sourceType: 1,
    interfaceType: src.interfaceType,
    slotId: src.slotId,
    templateId: 0,
    cropId: src.cropId,
    streamId: 0,
    screenId,
    layerId,
  },
});

// ---- reply decoding ---------------------------------------------------------------------------

export interface HSeriesReply {
  cmd: string;
  /** Raw `ack` field; success is exactly "Ok" (index.js:22). */
  ack: unknown;
  /** Every other field of the first array element (index.js:19). */
  data: JsonObject;
}

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Parse one datagram. Returns undefined for anything that is not a JSON array whose first element
 * is an object with a string `cmd` (the module's decodeRes swallows such datagrams too:
 * index.js:25 empty catch, main.js:987-989).
 */
export function decodeReply(msg: Buffer | string): HSeriesReply | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof msg === 'string' ? msg : msg.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const first: unknown = parsed[0];
  if (!isObject(first) || typeof first['cmd'] !== 'string') return undefined;
  const { cmd, ack, ...data } = first;
  return { cmd: cmd as string, ack, data };
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const arr = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined);

const bad = (cmd: string, what: string): DeviceError => new DeviceError('PROTOCOL', `${cmd} reply: ${what}`);

/** R0118 `rate` (main.js:1153). */
export function parseInitRate(data: JsonObject): number {
  const rate = num(data['rate']);
  if (rate === undefined) throw bad(CMD.initStatus, 'missing numeric "rate"');
  return rate;
}

export interface SlotInterface {
  interfaceId: number;
  interfaceType?: number;
  /** 0 = no source, 1 = connected, 2 = disconnected (main.js:1186). */
  iSignal?: number;
  functionType?: number;
}
export interface SlotInfo {
  slotId: number;
  /** 0 empty, 1 input, 2 output, 3 sender, 4 MVR (constant.js:113, main.js:1185). */
  cardType: number;
  status?: number;
  interfaces: SlotInterface[];
}

/** R0100 `slotList[]` (main.js:1190-1217; per-field use at :1209-1254). */
export function parseDeviceDetails(data: JsonObject): SlotInfo[] {
  const list = arr(data['slotList']);
  if (!list) throw bad(CMD.deviceDetails, 'missing "slotList"');
  const slots: SlotInfo[] = [];
  for (const raw of list) {
    if (!isObject(raw)) continue;
    const slotId = num(raw['slotId']);
    const cardType = num(raw['cardType']);
    if (slotId === undefined || cardType === undefined) continue;
    const interfaces: SlotInterface[] = [];
    for (const i of arr(raw['interfaces']) ?? []) {
      if (!isObject(i)) continue;
      const interfaceId = num(i['interfaceId']);
      if (interfaceId === undefined) continue;
      interfaces.push({
        interfaceId,
        interfaceType: num(i['interfaceType']),
        iSignal: num(i['iSignal']),
        functionType: num(i['functionType']),
      });
    }
    slots.push({ slotId, cardType, status: num(raw['status']), interfaces });
  }
  return slots;
}

/** Number of connectors on sending-card slots (cardType 3, constant.js:113). */
export function countSenderConnectors(slots: readonly SlotInfo[]): number {
  return slots.filter((s) => s.cardType === CARD_TYPE_SENDER).reduce((n, s) => n + s.interfaces.length, 0);
}

/** R0400 `screens[]` -> {screenId, name} (main.js:1277; fields used by formatDropDown.js:21-25). */
export function parseScreenList(data: JsonObject): { screenId: number; name: string }[] {
  const list = arr(data['screens']);
  if (!list) throw bad(CMD.screenList, 'missing "screens"');
  const out: { screenId: number; name: string }[] = [];
  for (const raw of list) {
    if (!isObject(raw)) continue;
    const screenId = num(raw['screenId']);
    if (screenId === undefined) continue;
    out.push({ screenId, name: str(raw['name']) ?? `Screen ${screenId + 1}` });
  }
  return out;
}

export interface ScreenDetails {
  screenId?: number;
  brightness: number;
  frozen: boolean;
  fadeToBlack: boolean;
}

/**
 * R0401 -> brightness (flat 0..100), `Freeze.enable` (1 = frozen) and `Ftb.enable` (INVERTED:
 * 0 = fade-to-black on). See the field-by-field comment at main.js:261-274 and :283-287.
 */
export function parseScreenDetails(data: JsonObject): ScreenDetails {
  const brightness = num(data['brightness']);
  if (brightness === undefined) throw bad(CMD.screenDetails, 'missing numeric "brightness"');
  const freeze = isObject(data['Freeze']) ? num(data['Freeze']['enable']) : undefined;
  const ftb = isObject(data['Ftb']) ? num(data['Ftb']['enable']) : undefined;
  return {
    screenId: num(data['screenId']),
    brightness: Math.min(100, Math.max(0, Math.round(brightness))),
    frozen: freeze === 1,
    fadeToBlack: ftb === 0,
  };
}

/** R0500 `screenLayers[]` -> {layerId, name} (main.js:1305-1308). */
export function parseLayerList(data: JsonObject): { layerId: number; name: string }[] {
  const list = arr(data['screenLayers']);
  if (!list) throw bad(CMD.layerList, 'missing "screenLayers"');
  const out: { layerId: number; name: string }[] = [];
  for (const raw of list) {
    if (!isObject(raw)) continue;
    const layerId = num(raw['layerId']);
    if (layerId === undefined) continue;
    out.push({ layerId, name: str(raw['name']) ?? `Layer ${layerId + 1}` });
  }
  return out;
}

/** R0600 `presets[]` -> {presetId, name} (main.js:1316-1319). */
export function parsePresetList(data: JsonObject): { presetId: number; name: string }[] {
  const list = arr(data['presets']);
  if (!list) throw bad(CMD.presetList, 'missing "presets"');
  const out: { presetId: number; name: string }[] = [];
  for (const raw of list) {
    if (!isObject(raw)) continue;
    const presetId = num(raw['presetId']);
    if (presetId === undefined) continue;
    out.push({ presetId, name: str(raw['name']) ?? `Preset ${presetId + 1}` });
  }
  return out;
}

export interface InputInfo {
  inputId: number;
  cropId: number;
  name: string;
  slotId?: number;
  interfaceId?: number;
  interfaceType?: number;
  online: boolean;
}

/**
 * R0226 `inputs[]` (main.js:1142). Mirrors formatSourceList (index.js:249-262): offline inputs
 * (`online === 0`) are dropped, each input becomes a whole-source entry (cropId 255) followed by
 * its `crops[]` entries (each crop object carries its own `cropId`, index.js:260).
 */
export function parseInputList(data: JsonObject): InputInfo[] {
  const list = arr(data['inputs']);
  if (!list) throw bad(CMD.inputList, 'missing "inputs"');
  const whole: InputInfo[] = [];
  const crops: InputInfo[] = [];
  for (const raw of list) {
    if (!isObject(raw)) continue;
    const inputId = num(raw['inputId']);
    if (inputId === undefined || raw['online'] === 0) continue;
    const base = {
      inputId,
      slotId: num(raw['slotId']),
      interfaceId: num(raw['interfaceId']),
      interfaceType: num(raw['interfaceType']),
      online: true,
    };
    const name = str(raw['name']) ?? `Input ${inputId + 1}`;
    whole.push({ ...base, cropId: WHOLE_SOURCE, name });
    for (const c of arr(raw['crops']) ?? []) {
      if (!isObject(c)) continue;
      const cropId = num(c['cropId']);
      if (cropId === undefined) continue;
      crops.push({ ...base, cropId, name: str(c['name']) ?? `${name} crop ${cropId + 1}` });
    }
  }
  return [...whole, ...crops];
}

export interface OutputInfo {
  outputId: number;
  slotId?: number;
  interfaceId?: number;
  isUsed?: number;
  /** Current W0303 pattern as read back, when reported (main.js:1390). */
  testPattern?: number;
}

/**
 * R0300 -> connectors. UNVERIFIED: the container key. The module accepts an array under `outputs`,
 * `data` or `outputList` (main.js:1369) so all three are accepted here. `outputId` 255 means "not
 * assigned" and is skipped (main.js:1375, :1447).
 */
export function parseOutputList(data: JsonObject): OutputInfo[] {
  const list = arr(data['outputs']) ?? arr(data['data']) ?? arr(data['outputList']);
  if (!list) throw bad(CMD.outputList, 'missing "outputs"');
  const out: OutputInfo[] = [];
  for (const raw of list) {
    if (!isObject(raw)) continue;
    const outputId = num(raw['outputId']);
    if (outputId === undefined || outputId === 255) continue;
    out.push({
      outputId,
      slotId: num(raw['slotId']),
      interfaceId: num(raw['interfaceId']),
      isUsed: num(raw['isUsed']),
      testPattern: isObject(raw['testPattern']) ? num(raw['testPattern']['testPattern']) : undefined,
    });
  }
  return out;
}

/**
 * Output connectors a test pattern should be sent to: connectors on sending cards (cardType 3) that
 * R0100 lists as real (actions.js:866-868 "All Sending Cards", main.js:1399-1404 real-connector
 * filter). Falls back to every assigned connector (`isUsed !== 0`, formatDropDown.js:73) when R0100
 * reports no sender slot. UNVERIFIED on hardware.
 */
export function selectTestPatternOutputs(outputs: readonly OutputInfo[], slots: readonly SlotInfo[]): OutputInfo[] {
  const senders = new Map<number, Set<number>>();
  for (const s of slots) {
    if (s.cardType === CARD_TYPE_SENDER) senders.set(s.slotId, new Set(s.interfaces.map((i) => i.interfaceId)));
  }
  if (senders.size > 0) {
    return outputs.filter((o) => {
      const real = o.slotId === undefined ? undefined : senders.get(o.slotId);
      return real !== undefined && (o.interfaceId === undefined || real.has(o.interfaceId));
    });
  }
  return outputs.filter((o) => o.isUsed !== 0);
}
