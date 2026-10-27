import { describe, expect, it } from 'vitest';
import { DeviceError, validateScreenConfig, type DeviceApi } from '@rockzalct/shared';
import { createMockDevice, MOCK_ADVANCED_PASSWORD } from '../mockDevice';

const ID = 'serial:COM3';
const make = async (advanced = false): Promise<DeviceApi> => {
  const api = createMockDevice({ latencyMs: 0 });
  await api.connect(ID);
  if (advanced) await api.login(MOCK_ADVANCED_PASSWORD);
  return api;
};
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DeviceError);
    return (e as DeviceError).code;
  }
  throw new Error('expected rejection');
};

describe('mock persist', () => {
  it('reads back edits made through the device receiver API (shared mock state)', async () => {
    const api = await make(true);
    const { config } = await api.readScreenConfig(ID);
    const card = config.receivers[0]!;
    const gamma = card.gamma === 40 ? 41 : 40;
    await api.setReceiverParameters(
      ID,
      { scope: 'card', portIndex: card.portIndex, cardIndex: card.cardIndex },
      { gamma },
    );
    const back = (await api.readScreenConfig(ID)).config.receivers[0]!;
    expect(back.gamma).toBe(gamma);
  });

  it('reads a complete, loadable snapshot of the fake controller', async () => {
    const api = await make();
    const res = await api.readScreenConfig(ID);
    expect(res.complete).toBe(true);
    expect(res.failures).toEqual([]);
    expect(res.config.controller).toMatchObject({ model: 'MCTRL660 (mock)', outputPorts: 4, receivingCards: 8 });
    expect(res.config.receivers).toHaveLength(8);
    expect(res.config.sender?.ports).toHaveLength(4);
    expect(res.config.layout?.screen).toMatchObject({ rows: 2, cols: 4 });
    expect(validateScreenConfig(res.config).ok).toBe(true);
  });

  it('requires a connection', async () => {
    const api = createMockDevice({ latencyMs: 0 });
    expect(await codeOf(api.readScreenConfig(ID))).toBe('NOT_CONNECTED');
    expect(await codeOf(api.readScreenConfig('nope'))).toBe('NOT_FOUND');
  });

  it('applies a modified config at advanced level and reads it back', async () => {
    const api = await make(true);
    const { config } = await api.readScreenConfig(ID);
    const edited = structuredClone(config);
    edited.receivers[2]!.gamma = 31;
    edited.sender!.video.fieldRate = 50;
    const res = await api.applyScreenConfig(ID, edited, { saveToHardware: true });
    expect(res.ok).toBe(true);
    expect(res.steps.map((s) => s.kind)).toEqual(['receiver', 'sender-field-rate', 'save']);
    const back = (await api.readScreenConfig(ID)).config;
    expect(back.receivers[2]!.gamma).toBe(31);
    expect(back.sender!.video.fieldRate).toBe(50);
    // identical file: nothing to write
    expect((await api.applyScreenConfig(ID, back)).steps).toEqual([]);
  });

  it('enforces the advanced level and validates input like the real feature', async () => {
    const normal = await make();
    const { config } = await normal.readScreenConfig(ID);
    expect(await codeOf(normal.applyScreenConfig(ID, config))).toBe('PERMISSION');
    expect(await codeOf(normal.saveToHardware(ID, { scope: 'all' }))).toBe('PERMISSION');
    const api = await make(true);
    expect(await codeOf(api.applyScreenConfig(ID, { ...config, version: 2 } as never))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.saveToHardware(ID, { scope: 'card', portIndex: 9, cardIndex: 0 }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.saveToHardware(ID, { scope: 'all' }, { senderValue: 999 }))).toBe('INVALID_ARGUMENT');
    const wrongModel = structuredClone(config);
    wrongModel.controller.model = 'Something else';
    expect(await codeOf(api.applyScreenConfig(ID, wrongModel))).toBe('INVALID_ARGUMENT');
  });

  it('saves one card or all of them', async () => {
    const api = await make(true);
    expect(await api.saveToHardware(ID, { scope: 'card', portIndex: 1, cardIndex: 1 })).toEqual({
      sender: null,
      cards: [{ portIndex: 1, cardIndex: 1, ok: true }],
      ok: true,
    });
    const all = await api.saveToHardware(ID, { scope: 'all' });
    expect(all.cards).toHaveLength(8);
    expect(all.sender).toEqual({ ok: true });
  });
});
