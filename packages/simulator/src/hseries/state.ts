// State + request handling of the H series simulator.
//
// The simulator answers the same UDP/JSON commands the device layer sends (packages/device/src/
// hseries/protocol.ts documents each command and its source in the kman1898 Companion module). It
// only proves our client follows the structure we BELIEVE the device uses: where that belief is
// UNVERIFIED (e.g. the key of the R0300 output list) the simulator simply repeats it, so passing
// tests say nothing about a real H5.

export interface SimLayer {
  layerId: number;
  name: string;
  /** Source set by W0506 (or the initial one). */
  inputId: number;
  cropId: number;
}

export interface SimPreset {
  presetId: number;
  name: string;
}

export interface SimScreen {
  screenId: number;
  name: string;
  /** 0..100 (W0410). */
  brightness: number;
  /** Brightness saved with W0417, undefined until saved. */
  savedBrightness?: number;
  /** W040A: 1 = frozen. */
  freeze: number;
  /** W0409 `type`, as the device reports it in `Ftb.enable`: 0 = fade to black ON, 1 = off. */
  ftb: number;
  layers: SimLayer[];
  presets: SimPreset[];
  /** Last preset played with W0605. */
  lastPresetId?: number;
}

export interface SimInput {
  inputId: number;
  name: string;
  online: number;
  slotId: number;
  interfaceId: number;
  interfaceType: number;
  crops: { cropId: number; name: string }[];
}

export interface SimInterface {
  interfaceId: number;
  interfaceType: number;
  iSignal: number;
  functionType: number;
}

export interface SimSlot {
  slotId: number;
  /** 0 empty, 1 input, 2 output, 3 sender, 4 MVR. */
  cardType: number;
  status: number;
  interfaces: SimInterface[];
}

export interface SimOutput {
  outputId: number;
  slotId: number;
  interfaceId: number;
  isUsed: number;
  testPattern: { testPattern: number; bright: number; grid: number; speed: number };
}

export interface HSeriesSimulatorOptions {
  /** UDP port; 0 (default) picks a free one. */
  port?: number;
  host?: string;
  /** Number of R0118 replies with rate < 100 before the device reports ready, default 0. */
  initPolls?: number;
  /** Number of screens (1..4), default 2. */
  screens?: number;
}

export interface HSeriesSimulatorState {
  screens: SimScreen[];
  inputs: SimInput[];
  slots: SimSlot[];
  outputs: SimOutput[];
  /** W0700 `blackout` (1 = on). */
  blackout: number;
  /** Remaining R0118 replies below 100. */
  initPolls: number;
  /** When true the simulator ignores everything (to test timeouts). */
  mute: boolean;
  /** Commands answered with garbage instead of JSON. */
  garbageFor: Set<string>;
  /** Commands answered with ack "Fail". */
  failFor: Set<string>;
  /** Every well-formed command received, in order. */
  received: { cmd: string; body: Record<string, unknown> }[];
  /** Datagrams that were not a JSON array with a cmd (no reply is sent). */
  malformedRequests: number;
}

const INPUT_SLOT = 0;
const SENDER_SLOT = 20;
const OUTPUT_SLOT = 21;
const INTERFACE_HDMI = 5;
const INTERFACE_DVI = 2;

export function createHSeriesState(opts: HSeriesSimulatorOptions = {}): HSeriesSimulatorState {
  const screenCount = Math.max(1, Math.min(4, opts.screens ?? 2));
  const screens: SimScreen[] = Array.from({ length: screenCount }, (_, i) => ({
    screenId: i,
    name: `Screen ${i + 1}`,
    brightness: 80,
    freeze: 0,
    ftb: 1,
    layers: [
      { layerId: 0, name: 'Layer 1', inputId: 0, cropId: 255 },
      { layerId: 1, name: 'Layer 2', inputId: 1, cropId: 255 },
    ],
    presets: [
      { presetId: 0, name: 'Opening' },
      { presetId: 1, name: 'Show' },
      { presetId: 2, name: 'Closing' },
    ],
  }));
  const inputs: SimInput[] = [
    { inputId: 0, name: 'HDMI 1', online: 1, slotId: INPUT_SLOT, interfaceId: 0, interfaceType: INTERFACE_HDMI, crops: [{ cropId: 0, name: 'HDMI 1 left half' }] },
    { inputId: 1, name: 'HDMI 2', online: 1, slotId: INPUT_SLOT, interfaceId: 1, interfaceType: INTERFACE_HDMI, crops: [] },
    { inputId: 2, name: 'DVI 1', online: 1, slotId: INPUT_SLOT, interfaceId: 2, interfaceType: INTERFACE_DVI, crops: [] },
    { inputId: 3, name: 'DVI 2 (cable out)', online: 0, slotId: INPUT_SLOT, interfaceId: 3, interfaceType: INTERFACE_DVI, crops: [] },
  ];
  const iface = (interfaceId: number, interfaceType: number, iSignal: number): SimInterface => ({
    interfaceId,
    interfaceType,
    iSignal,
    functionType: 0,
  });
  const slots: SimSlot[] = [
    { slotId: INPUT_SLOT, cardType: 1, status: 1, interfaces: [iface(0, INTERFACE_HDMI, 1), iface(1, INTERFACE_HDMI, 1), iface(2, INTERFACE_DVI, 1), iface(3, INTERFACE_DVI, 0)] },
    { slotId: SENDER_SLOT, cardType: 3, status: 1, interfaces: [0, 1, 2, 3].map((i) => iface(i, 13, 0)) },
    { slotId: OUTPUT_SLOT, cardType: 2, status: 1, interfaces: [iface(0, INTERFACE_HDMI, 0)] },
  ];
  // R0300 reports a fixed grid of potential connectors per card, most of which are not real
  // (main.js:1394-1398): the sender slot lists 8 connectors although R0100 only has 4.
  const blank = { testPattern: 0xffff, bright: 3, grid: 5, speed: 3 };
  const outputs: SimOutput[] = [];
  let outputId = 0;
  for (const slot of [SENDER_SLOT, OUTPUT_SLOT]) {
    const potential = slot === SENDER_SLOT ? 8 : 4;
    for (let i = 0; i < potential; i += 1) {
      outputs.push({ outputId, slotId: slot, interfaceId: i, isUsed: i < 4 ? 1 : 0, testPattern: { ...blank } });
      outputId += 1;
    }
  }
  return {
    screens,
    inputs,
    slots,
    outputs,
    blackout: 0,
    initPolls: opts.initPolls ?? 0,
    mute: false,
    garbageFor: new Set(),
    failFor: new Set(),
    received: [],
    malformedRequests: 0,
  };
}

type Body = Record<string, unknown>;
/** What to send back: payload fields (cmd/ack are added by the caller) or a failure message. */
export type SimResult = { ok: true; data: Body } | { ok: false; message: string };

const ok = (data: Body = {}): SimResult => ({ ok: true, data });
const fail = (message: string): SimResult => ({ ok: false, message });
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);

/** Execute one parsed command against the state. Unknown commands fail with ack "Fail". */
export function handleHSeriesCommand(state: HSeriesSimulatorState, cmd: string, body: Body): SimResult {
  const screenOf = (id: unknown): SimScreen | undefined => state.screens.find((s) => s.screenId === int(id));
  switch (cmd) {
    case 'R0118': {
      if (state.initPolls > 0) {
        state.initPolls -= 1;
        return ok({ rate: 50 });
      }
      return ok({ rate: 100 });
    }
    case 'R0100':
      return ok({ slotList: state.slots });
    case 'R0400':
      return ok({ screens: state.screens.map((s) => ({ screenId: s.screenId, name: s.name })) });
    case 'R0401': {
      const s = screenOf(body['param1']);
      if (!s) return fail('no such screen');
      return ok({
        screenId: s.screenId,
        name: s.name,
        brightness: s.brightness,
        Freeze: { enable: s.freeze },
        Ftb: { enable: s.ftb },
        Bkg: { enable: 0, bkgId: 0 },
      });
    }
    case 'R0500': {
      const s = screenOf(body['param1']);
      if (!s) return fail('no such screen');
      return ok({ screenId: s.screenId, screenLayers: s.layers.map((l) => ({ layerId: l.layerId, name: l.name })) });
    }
    case 'R0600': {
      const s = screenOf(body['param1']);
      if (!s) return fail('no such screen');
      return ok({ screenId: s.screenId, presets: s.presets });
    }
    case 'R0226':
      return ok({
        inputs: state.inputs.map((i) => ({
          inputId: i.inputId,
          name: i.name,
          online: i.online,
          slotId: i.slotId,
          interfaceId: i.interfaceId,
          interfaceType: i.interfaceType,
          crops: i.crops,
        })),
      });
    case 'R0300':
      return ok({ outputs: state.outputs });
    case 'W0410': {
      const s = screenOf(body['screenId']);
      const brightness = int(body['brightness']);
      if (!s) return fail('no such screen');
      if (brightness === undefined || brightness < 0 || brightness > 100) return fail('brightness out of range');
      s.brightness = brightness;
      return ok();
    }
    case 'W0417': {
      const s = screenOf(body['screenId']);
      if (!s) return fail('no such screen');
      s.savedBrightness = s.brightness;
      return ok();
    }
    case 'W0303': {
      const o = state.outputs.find((x) => x.outputId === int(body['outputId']));
      const pattern = int(body['testPattern']);
      if (!o) return fail('no such output');
      if (pattern === undefined) return fail('testPattern missing');
      o.testPattern = {
        testPattern: pattern,
        bright: int(body['bright']) ?? o.testPattern.bright,
        grid: int(body['grid']) ?? o.testPattern.grid,
        speed: int(body['speed']) ?? o.testPattern.speed,
      };
      return ok();
    }
    case 'W0409': {
      const s = screenOf(body['screenId']);
      const type = int(body['type']);
      if (!s) return fail('no such screen');
      if (type !== 0 && type !== 1) return fail('type must be 0 or 1');
      s.ftb = type; // 0 = FTB on, 1 = off: stored as the device reports it
      return ok();
    }
    case 'W040A': {
      const s = screenOf(body['screenId']);
      const enable = int(body['enable']);
      if (!s) return fail('no such screen');
      if (enable !== 0 && enable !== 1) return fail('enable must be 0 or 1');
      s.freeze = enable;
      return ok();
    }
    case 'W0700': {
      const blackout = int(body['blackout']);
      if (blackout !== 0 && blackout !== 1) return fail('blackout must be 0 or 1');
      state.blackout = blackout;
      return ok();
    }
    case 'W0605': {
      const s = screenOf(body['screenId']);
      const presetId = int(body['presetId']);
      if (!s) return fail('no such screen');
      if (!s.presets.some((p) => p.presetId === presetId)) return fail('no such preset');
      s.lastPresetId = presetId;
      return ok();
    }
    case 'W0506': {
      const s = screenOf(body['screenId']);
      const layer = s?.layers.find((l) => l.layerId === int(body['layerId']));
      const inputId = int(body['inputId']);
      const cropId = int(body['cropId']);
      if (!s || !layer) return fail('no such layer');
      if (inputId === undefined || cropId === undefined || !state.inputs.some((i) => i.inputId === inputId)) {
        return fail('no such input');
      }
      layer.inputId = inputId;
      layer.cropId = cropId;
      return ok();
    }
    default:
      return fail(`unknown command ${cmd}`);
  }
}
