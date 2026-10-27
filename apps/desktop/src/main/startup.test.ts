import { describe, expect, it, vi } from 'vitest';
import { resolveSmokeOut, runStartup, type StartupDeps } from './startup';

function deps(over: Partial<StartupDeps> = {}): StartupDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    whenReady: () => Promise.resolve(),
    boot: () => {
      calls.push('boot');
    },
    showError: (_t, c) => {
      calls.push(`dialog:${c}`);
    },
    exit: (code) => {
      calls.push(`exit:${code}`);
    },
    logError: () => undefined,
    smoke: false,
    ...over,
  };
}

describe('runStartup', () => {
  it('boots and does not exit on success', async () => {
    const d = deps();
    await runStartup(d);
    expect(d.calls).toEqual(['boot']);
  });

  it('shows a dialog and exits 1 when boot throws', async () => {
    const d = deps({
      boot: () => {
        throw new Error('Unknown ROCKZALCT_DEVICE "foo"');
      },
    });
    await runStartup(d);
    expect(d.calls).toEqual(['dialog:Unknown ROCKZALCT_DEVICE "foo"', 'exit:1']);
  });

  it('exits 1 when whenReady rejects', async () => {
    const d = deps({ whenReady: () => Promise.reject(new Error('no app')) });
    await runStartup(d);
    expect(d.calls).toEqual(['dialog:no app', 'exit:1']);
  });

  it('skips the dialog in smoke mode, reports the failure and exits 1', async () => {
    const onSmokeFail = vi.fn();
    const d = deps({
      smoke: true,
      onSmokeFail,
      boot: () => {
        throw new Error('boom');
      },
    });
    await runStartup(d);
    expect(d.calls).toEqual(['exit:1']);
    expect(onSmokeFail).toHaveBeenCalledOnce();
  });
});

describe('resolveSmokeOut', () => {
  it('reads --smoke-out=<path>', () => {
    expect(resolveSmokeOut(['app.exe', '--smoke-test', '--smoke-out=C:\\a b\\o.txt'])).toBe('C:\\a b\\o.txt');
  });
  it('is undefined when absent or empty', () => {
    expect(resolveSmokeOut(['app.exe'])).toBeUndefined();
    expect(resolveSmokeOut(['--smoke-out='])).toBeUndefined();
  });
});
