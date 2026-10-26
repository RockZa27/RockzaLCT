import {
  DeviceError,
  SENDER_INPUT_SOURCES,
  SENDER_MAX_PORTS,
  type SenderApi,
  type SenderInputSource,
  type SenderPortStatus,
  type SenderRedundancyStatus,
  type SenderResolution,
  type SenderVideoStatus,
} from '@rockzalct/shared';
import type { MockContext } from './context';

interface MockSender {
  video: SenderVideoStatus;
  ports: SenderPortStatus[];
  redundancy: SenderRedundancyStatus;
}

const RAW_INPUT: Record<SenderInputSource, number> = {
  DVI: 88,
  HDMI: 5,
  HDMI1: 90,
  HDMI2: 91,
  SDI: 1,
  DP: 95,
  Dual_DVI: 97,
  HDBaseT: 63,
  LVDS: 107,
};

function build(id: string): MockSender {
  const isNet = id.startsWith('net:');
  const portCount = isNet ? 10 : 4;
  const cards = isNet ? 1 : 2;
  const ports: SenderPortStatus[] = Array.from({ length: portCount }, (_, portIndex) => {
    const width = isNet ? 512 : 960;
    const height = isNet ? 384 : 270;
    return { portIndex, enabled: true, width, height, pixels: width * height, receivingCards: cards };
  });
  return {
    video: {
      signalPresent: true,
      resolution: { width: 1920, height: 1080 },
      fieldRateMode: 0,
      fieldRate: 60,
      measuredFieldRate: 60,
      inputSource: 'DVI',
      inputSourceRaw: RAW_INPUT.DVI,
    },
    ports,
    redundancy: {
      loadMode: 'high-load',
      spaces: (['legacy', 'new'] as const).map((space) => {
        const raw = Array.from({ length: 8 }, (_, i) => (space === 'legacy' && i === 2 && !isNet ? 1 : 0));
        return {
          space,
          raw,
          ports: raw.map((b, portIndex) => ({ portIndex, state: b === 1 ? ('error' as const) : ('ok' as const) })),
        };
      }),
    },
  };
}

const isU16 = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0xffff;

/** In-memory sending card per controller id. Mirrors the validation and PERMISSION rules of the real feature. */
export function createMockSender(ctx: MockContext): SenderApi {
  const state = new Map<string, MockSender>();
  const get = (id: string): MockSender => {
    ctx.requireConnected(id);
    let s = state.get(id);
    if (!s) {
      s = build(id);
      state.set(id, s);
    }
    return s;
  };
  const requireAdvanced = (): void => {
    if (!ctx.isAdvanced()) throw new DeviceError('PERMISSION', 'advanced user level required');
  };
  const copyVideo = (v: SenderVideoStatus): SenderVideoStatus => ({ ...v, resolution: { ...v.resolution } });
  const copyPorts = (p: SenderPortStatus[]): SenderPortStatus[] => p.map((x) => ({ ...x }));

  return {
    async getSenderVideo(id) {
      await ctx.delay();
      return copyVideo(get(id).video);
    },

    async setSenderResolution(id, resolution: SenderResolution) {
      requireAdvanced();
      const { width, height } = (resolution ?? {}) as Partial<SenderResolution>;
      if (!isU16(width) || !isU16(height) || width < 1 || height < 1) {
        throw new DeviceError('INVALID_ARGUMENT', 'width and height must be integers 1..65535');
      }
      await ctx.delay();
      const s = get(id);
      s.video.resolution = { width, height };
      return copyVideo(s.video);
    },

    async setSenderFieldRate(id, fieldRate) {
      requireAdvanced();
      if (!isU16(fieldRate)) throw new DeviceError('INVALID_ARGUMENT', 'fieldRate must be an integer 0..65535');
      await ctx.delay();
      const s = get(id);
      s.video.fieldRate = fieldRate;
      return copyVideo(s.video);
    },

    async setSenderInputSource(id, source) {
      requireAdvanced();
      if (!SENDER_INPUT_SOURCES.includes(source)) {
        throw new DeviceError('INVALID_ARGUMENT', `unknown input source: ${String(source)}`);
      }
      await ctx.delay();
      const s = get(id);
      s.video.inputSource = source;
      s.video.inputSourceRaw = RAW_INPUT[source];
      return copyVideo(s.video);
    },

    async getSenderPorts(id) {
      await ctx.delay();
      return copyPorts(get(id).ports);
    },

    async setSenderPortEnabled(id, portIndex, enabled) {
      requireAdvanced();
      if (!Number.isInteger(portIndex) || portIndex < 0 || portIndex >= SENDER_MAX_PORTS) {
        throw new DeviceError('INVALID_ARGUMENT', `portIndex must be an integer 0..${SENDER_MAX_PORTS - 1}`);
      }
      if (typeof enabled !== 'boolean') throw new DeviceError('INVALID_ARGUMENT', 'enabled must be a boolean');
      await ctx.delay();
      const s = get(id);
      const port = s.ports.find((p) => p.portIndex === portIndex);
      if (port) port.enabled = enabled;
      return copyPorts(s.ports);
    },

    async getSenderRedundancy(id) {
      await ctx.delay();
      const r = get(id).redundancy;
      return {
        loadMode: r.loadMode,
        spaces: r.spaces.map((sp) => ({ ...sp, raw: [...sp.raw], ports: sp.ports.map((p) => ({ ...p })) })),
      };
    },
  };
}
