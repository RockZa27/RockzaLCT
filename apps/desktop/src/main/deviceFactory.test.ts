import { describe, expect, it } from 'vitest';
import { getDeviceApi, resolveDeviceName } from './deviceFactory';

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
