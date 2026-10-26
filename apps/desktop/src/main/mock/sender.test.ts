import { describe, expect, it } from 'vitest';
import { DeviceError, type DeviceApi } from '@rockzalct/shared';
import { createMockDevice, MOCK_ADVANCED_PASSWORD } from '../mockDevice';

const ID = 'serial:COM3';

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DeviceError);
    return (e as DeviceError).code;
  }
  throw new Error('expected rejection');
}

async function connected(): Promise<DeviceApi> {
  const api = createMockDevice({ latencyMs: 0 });
  await api.connect(ID);
  return api;
}

describe('mock sender', () => {
  it('requires a connection', async () => {
    const api = createMockDevice({ latencyMs: 0 });
    expect(await codeOf(api.getSenderVideo(ID))).toBe('NOT_CONNECTED');
    expect(await codeOf(api.getSenderPorts('serial:nope'))).toBe('NOT_FOUND');
  });

  it('reads video, ports and redundancy', async () => {
    const api = await connected();
    expect((await api.getSenderVideo(ID)).resolution).toEqual({ width: 1920, height: 1080 });
    const ports = await api.getSenderPorts(ID);
    expect(ports).toHaveLength(4);
    expect(ports[0]!.pixels).toBe(ports[0]!.width * ports[0]!.height);
    const r = await api.getSenderRedundancy(ID);
    expect(r.spaces.map((s) => s.space)).toEqual(['legacy', 'new']);
  });

  it('refuses writes below the advanced level and stores them above it', async () => {
    const api = await connected();
    expect(await codeOf(api.setSenderResolution(ID, { width: 800, height: 600 }))).toBe('PERMISSION');
    expect(await codeOf(api.setSenderFieldRate(ID, 50))).toBe('PERMISSION');
    expect(await codeOf(api.setSenderInputSource(ID, 'DP'))).toBe('PERMISSION');
    expect(await codeOf(api.setSenderPortEnabled(ID, 0, false))).toBe('PERMISSION');
    expect((await api.getSenderVideo(ID)).resolution.width).toBe(1920);

    expect(await api.login(MOCK_ADVANCED_PASSWORD)).toBe(true);
    expect((await api.setSenderResolution(ID, { width: 800, height: 600 })).resolution).toEqual({
      width: 800,
      height: 600,
    });
    expect((await api.getSenderVideo(ID)).resolution.width).toBe(800);
    expect((await api.setSenderInputSource(ID, 'DP')).inputSourceRaw).toBe(95);
    expect((await api.setSenderFieldRate(ID, 50)).fieldRate).toBe(50);
    expect((await api.setSenderPortEnabled(ID, 0, false))[0]!.enabled).toBe(false);
    expect((await api.getSenderPorts(ID))[0]!.enabled).toBe(false);
  });

  it('validates arguments', async () => {
    const api = await connected();
    await api.login(MOCK_ADVANCED_PASSWORD);
    expect(await codeOf(api.setSenderResolution(ID, { width: 0, height: 10 }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.setSenderFieldRate(ID, 70000))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.setSenderInputSource(ID, 'VGA' as never))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.setSenderPortEnabled(ID, 99, true))).toBe('INVALID_ARGUMENT');
  });
});
