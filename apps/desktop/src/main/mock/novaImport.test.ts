import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DeviceError, type DeviceApi } from '@rockzalct/shared';
import { createMockDevice, MOCK_ADVANCED_PASSWORD } from '../mockDevice';

const ID = 'serial:COM3';
// Real files, shared with the device package tests.
const FIXTURES = join(__dirname, '../../../../../packages/device/test/fixtures/novalct');
const bytes = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)));
const SAMPLE = 'Q8_ICND2153_40x40.rcfgx';
const OPTS = { confirmCardModel: 'MRV328', acknowledgeCommands: true };
const CARD = { scope: 'card', portIndex: 0, cardIndex: 0 } as const;

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
const parse = async (api: DeviceApi, name = SAMPLE) => {
  const res = await api.parseRcfgxFile({ name, bytes: bytes(name) });
  if (!res.ok) throw new Error(res.message);
  return res.info;
};

describe('mock novaImport', () => {
  it('parses the real sample with the same golden values as the device layer', async () => {
    const api = await make();
    const info = await parse(api);
    expect(info).toMatchObject({ recordCount: 41, totalBytes: 6598 });
    expect(info.properties).toMatchObject({ cardModel: 'MRV328', novaLctVersion: 'NovaLCT V5.3.0-14.09.2021 18:16:22' });
    expect(info.commandRecords).toHaveLength(6);
  });

  it('returns bad files as data, not as a rejection', async () => {
    const api = await make();
    const res = await api.parseRcfgxFile({ name: 'x.rcfgx', bytes: new Uint8Array([1, 2, 3]) });
    expect(res).toMatchObject({ ok: false, reason: 'not-zip' });
    const scr = await api.parseScreenFile({ name: 'x.scr', bytes: new Uint8Array(10) });
    expect(scr).toMatchObject({ ok: false, reason: 'scr-invalid' });
    expect(await codeOf(api.parseRcfgxFile({ name: 'x', bytes: 'nope' } as never))).toBe('INVALID_ARGUMENT');
  });

  it('parses the sample .scr and maps it to a layout', async () => {
    const api = await make();
    const res = await api.parseScreenFile({ name: 'test.scr', bytes: bytes('test.scr') });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.info.layout.ok).toBe(true);
  });

  it('send needs advanced, a connection, a known file, the confirmations and a valid target', async () => {
    const api = await make();
    const info = await parse(api);
    expect(await codeOf(api.sendRcfgx(ID, info.fileId, CARD, OPTS))).toBe('PERMISSION');
    await api.login(MOCK_ADVANCED_PASSWORD);
    expect(await codeOf(api.sendRcfgx('nope', info.fileId, CARD, OPTS))).toBe('NOT_FOUND');
    expect(await codeOf(api.sendRcfgx(ID, 'unknown', CARD, OPTS))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.sendRcfgx(ID, info.fileId, CARD, { ...OPTS, confirmCardModel: 'NV7516' }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.sendRcfgx(ID, info.fileId, CARD, { ...OPTS, acknowledgeCommands: false }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.sendRcfgx(ID, info.fileId, { scope: 'card', portIndex: 300, cardIndex: 0 }, OPTS))).toBe('INVALID_ARGUMENT');
  });

  it('send reports the full counts and leaves a finished progress', async () => {
    const api = await make(true);
    const info = await parse(api);
    expect(await api.getRcfgxProgress(ID)).toBeNull();
    const res = await api.sendRcfgx(ID, info.fileId, { scope: 'all' }, OPTS);
    expect(res).toMatchObject({ ok: true, recordsTotal: 41, recordsWritten: 41, bytesWritten: 6598, commandRecordsWritten: 6 });
    expect(await api.getRcfgxProgress(ID)).toMatchObject({ running: false, recordsDone: 41, bytesDone: 6598, failed: false });
  });
});
