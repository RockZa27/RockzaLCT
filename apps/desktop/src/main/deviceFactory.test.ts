import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_HARDWARE_OVERRIDES } from '@rockzalct/shared';
import { getDeviceApi, persistOverrides, resolveDeviceName } from './deviceFactory';
import { createOverridesStore } from './overridesStore';

describe('resolveDeviceName', () => {
  it('defaults to real when no flag and no env', () => {
    expect(resolveDeviceName(['app.exe'], {})).toBe('real');
    expect(resolveDeviceName([], { ROCKZALCT_DEVICE: '' })).toBe('real');
  });

  it('--sim and --mock flags select those back-ends', () => {
    expect(resolveDeviceName(['app.exe', '--sim'], {})).toBe('sim');
    expect(resolveDeviceName(['app.exe', '--mock'], {})).toBe('mock');
  });

  it('--device=<name> selects an arbitrary back-end', () => {
    expect(resolveDeviceName(['--device=sim'], {})).toBe('sim');
    expect(resolveDeviceName(['--device='], {})).toBe('real');
  });

  it('flags take precedence over the environment', () => {
    expect(resolveDeviceName(['--sim'], { ROCKZALCT_DEVICE: 'mock' })).toBe('sim');
  });

  it('falls back to the environment variable', () => {
    expect(resolveDeviceName(['app.exe'], { ROCKZALCT_DEVICE: 'mock' })).toBe('mock');
  });
});

describe('getDeviceApi', () => {
  it('rejects unknown back-ends', () => {
    expect(() => getDeviceApi('nope')).toThrow(/Unknown ROCKZALCT_DEVICE "nope"/);
  });

  it('creates the mock back-end', () => {
    expect(typeof getDeviceApi('mock')).toBe('object');
  });
});

describe('persistOverrides (onHardwareOverridesChange contract)', () => {
  const quiet = { warn: () => undefined, error: () => undefined };
  const values = { ...DEFAULT_HARDWARE_OVERRIDES, lockOn: 2 };

  it('saves to disk and returns normally on success', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rockzalct-persist-'));
    try {
      const store = createOverridesStore(dir, quiet);
      expect(() => persistOverrides(store)(values)).not.toThrow();
      expect(readFileSync(store.path, 'utf8')).toContain('"lockOn": 2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws an Error carrying the store reason when the save fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rockzalct-persist-'));
    try {
      // userData "directory" is a regular file, so mkdir/open fails even when running as root
      const blocker = join(dir, 'not-a-dir');
      writeFileSync(blocker, 'x');
      const store = createOverridesStore(blocker, quiet);
      const reason = store.save(values);
      expect(reason.ok).toBe(false);
      expect(() => persistOverrides(store)(values)).toThrow(Error);
      expect(() => persistOverrides(store)(values)).toThrow((reason as { error: string }).error);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
