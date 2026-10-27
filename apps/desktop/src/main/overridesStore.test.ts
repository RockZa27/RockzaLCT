import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HARDWARE_OVERRIDES, parseHardwareOverridesJson } from '@rockzalct/shared';
import { getDeviceApi } from './deviceFactory';
import { OVERRIDES_FILE_NAME, createOverridesStore } from './overridesStore';

let dir: string;
const log = () => ({ warn: vi.fn(), error: vi.fn() });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rockzalct-overrides-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('overrides store', () => {
  it('returns the defaults silently when there is no file yet', () => {
    const l = log();
    const store = createOverridesStore(dir, l);
    expect(store.path).toBe(join(dir, 'hardware-overrides.json'));
    expect(store.load()).toEqual(DEFAULT_HARDWARE_OVERRIDES);
    expect(l.warn).not.toHaveBeenCalled();
  });

  it('saves and loads back, in the versioned export format', () => {
    const store = createOverridesStore(dir, log());
    const values = { ...DEFAULT_HARDWARE_OVERRIDES, lockOn: 2, saveReceiver: 7, scannerXyOrder: 'x-low' as const };
    expect(store.save(values)).toEqual({ ok: true });
    expect(createOverridesStore(dir, log()).load()).toEqual(values);
    const onDisk = JSON.parse(readFileSync(store.path, 'utf8')) as Record<string, unknown>;
    expect(onDisk).toMatchObject({ format: 'rockzalct.hardware-overrides', version: 1, values });
    // the same file is accepted by the import validator of the settings page
    expect(parseHardwareOverridesJson(readFileSync(store.path, 'utf8'))).toMatchObject({ ok: true, values });
  });

  it('writes atomically: no temp file is left behind and an old file is replaced whole', () => {
    const store = createOverridesStore(dir, log());
    store.save({ ...DEFAULT_HARDWARE_OVERRIDES, killOn: 3 });
    store.save({ ...DEFAULT_HARDWARE_OVERRIDES, killOn: 4 });
    expect(readdirSync(dir)).toEqual([OVERRIDES_FILE_NAME]);
    expect(store.load().killOn).toBe(4);
  });

  it('creates the directory when it does not exist yet', () => {
    const nested = join(dir, 'a', 'b');
    const store = createOverridesStore(nested, log());
    expect(store.save({ ...DEFAULT_HARDWARE_OVERRIDES, killOff: 9 })).toEqual({ ok: true });
    expect(existsSync(join(nested, OVERRIDES_FILE_NAME))).toBe(true);
  });

  it.each([
    ['not json at all {{{', 'garbage'],
    ['', 'empty file'],
    [JSON.stringify({ format: 'something-else', version: 1, values: {} }), 'wrong format'],
    [JSON.stringify({ format: 'rockzalct.hardware-overrides', version: 99, values: {} }), 'future version'],
    [JSON.stringify({ format: 'rockzalct.hardware-overrides', version: 1, values: { killOn: 1000 } }), 'value out of range'],
    [JSON.stringify({ format: 'rockzalct.hardware-overrides', version: 1, values: { correctionEnabledBit: 3 } }), 'not a single bit'],
  ])('falls back to the defaults, logs, and keeps a copy of a bad file (%#: %s)', (content) => {
    const l = log();
    const store = createOverridesStore(dir, l);
    writeFileSync(store.path, content);
    expect(() => store.load()).not.toThrow();
    expect(store.load()).toEqual(DEFAULT_HARDWARE_OVERRIDES);
    expect(l.warn).toHaveBeenCalled();
    expect(l.warn.mock.calls[0]![0]).toContain('using defaults');
    expect(readFileSync(`${store.path}.invalid`, 'utf8')).toBe(content);
    // the next save replaces the bad file with a good one
    store.save({ ...DEFAULT_HARDWARE_OVERRIDES, lockOn: 2 });
    expect(createOverridesStore(dir, log()).load().lockOn).toBe(2);
  });

  it('does not throw when the path cannot be read (it is a directory)', () => {
    const l = log();
    const store = createOverridesStore(dir, l);
    mkdirSync(store.path);
    expect(store.load()).toEqual(DEFAULT_HARDWARE_OVERRIDES);
    expect(l.warn).toHaveBeenCalled();
  });

  it('save reports a failure instead of throwing, and leaves no temp file', () => {
    const l = log();
    // the "directory" is really a file, so mkdir / open must fail
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    const store = createOverridesStore(join(blocker, 'sub'), l);
    const res = store.save(DEFAULT_HARDWARE_OVERRIDES);
    expect(res.ok).toBe(false);
    expect(l.error).toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual(['blocker']);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('save to a read-only directory fails softly', () => {
    const l = log();
    chmodSync(dir, 0o500);
    try {
      expect(createOverridesStore(dir, l).save(DEFAULT_HARDWARE_OVERRIDES).ok).toBe(false);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe('real back end uses the store', () => {
  it('starts from the saved file and persists every change', async () => {
    createOverridesStore(dir, log()).save({ ...DEFAULT_HARDWARE_OVERRIDES, lockOn: 2 });
    const api = getDeviceApi('real', { userDataDir: dir });
    expect((await api.getHardwareOverrides()).lockOn).toBe(2);

    expect(await api.login('admin')).toBe(true);
    await api.setHardwareOverrides({ killOn: 5 });
    expect(createOverridesStore(dir, log()).load()).toEqual({ ...DEFAULT_HARDWARE_OVERRIDES, lockOn: 2, killOn: 5 });

    await api.resetHardwareOverrides();
    expect(createOverridesStore(dir, log()).load()).toEqual(DEFAULT_HARDWARE_OVERRIDES);
  });

  it('a corrupt file does not stop the back end from starting', async () => {
    writeFileSync(join(dir, OVERRIDES_FILE_NAME), '{ broken');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const api = getDeviceApi('real', { userDataDir: dir });
    expect(await api.getHardwareOverrides()).toEqual(DEFAULT_HARDWARE_OVERRIDES);
  });

  it('mock starts at the defaults and writes nothing to disk', async () => {
    const api = getDeviceApi('mock', { userDataDir: dir });
    expect(await api.getHardwareOverrides()).toEqual(DEFAULT_HARDWARE_OVERRIDES);
    expect(readdirSync(dir)).toEqual([]);
  });
});
