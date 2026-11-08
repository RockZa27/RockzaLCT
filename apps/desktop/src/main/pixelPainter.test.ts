import { describe, expect, it } from 'vitest';
import { createPixelPainter, framePage, type PainterElectron, type PainterWindow } from './pixelPainter';

function fake(displays = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }, { bounds: { x: 1920, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5 }]) {
  const windows: Array<PainterWindow & { urls: string[]; boundsLog: unknown[]; closed: boolean; shown: number; created: unknown }> = [];
  const electron: PainterElectron = {
    screen: { getAllDisplays: () => displays, getPrimaryDisplay: () => displays[0]! },
    createWindow(options) {
      const w = {
        urls: [] as string[],
        boundsLog: [] as unknown[],
        closed: false,
        shown: 0,
        created: options,
        async loadURL(url: string) {
          w.urls.push(url);
        },
        setBounds(b: unknown) {
          w.boundsLog.push(b);
        },
        showInactive() {
          w.shown += 1;
        },
        close() {
          w.closed = true;
        },
        isDestroyed: () => w.closed,
        on() {},
      };
      windows.push(w);
      return w;
    },
  };
  return { electron, windows };
}
const decode = (url: string): string => decodeURIComponent(url.replace('data:text/html;charset=utf-8,', ''));

describe('pixel painter', () => {
  it('lists the displays in physical pixels and marks the primary one', async () => {
    const { electron } = fake();
    expect(await createPixelPainter(electron).listDisplays()).toEqual([
      { index: 0, label: 'Display 1', width: 1920, height: 1080, primary: true },
      { index: 1, label: 'Display 2', width: 1920, height: 1080, primary: false },
    ]);
  });

  it('opens one window at the display corner, sized to the frame, with the pixel at the right place', async () => {
    const { electron, windows } = fake();
    const p = createPixelPainter(electron);
    await p.show(0, { width: 32, height: 64, x: 5, y: 7 });
    expect(windows).toHaveLength(1);
    expect(windows[0]!.created).toEqual({ x: 0, y: 0, width: 32, height: 64 });
    const html = decode(windows[0]!.urls[0]!);
    expect(html).toContain('left:5px;top:7px;width:1px;height:1px');
    expect(html).toContain('background:#000');
    expect(windows[0]!.shown).toBe(1);
    // next frame reuses the window
    await p.show(0, { width: 32, height: 64, x: 6, y: 7 });
    expect(windows).toHaveLength(1);
    expect(windows[0]!.boundsLog).toEqual([{ x: 0, y: 0, width: 32, height: 64 }]);
    expect(decode(windows[0]!.urls[1]!)).toContain('left:6px');
  });

  it('divides by the scale factor of the display', async () => {
    const { electron, windows } = fake();
    await createPixelPainter(electron).show(1, { width: 30, height: 60, x: 3, y: 6 });
    expect(windows[0]!.created).toEqual({ x: 1920, y: 0, width: 20, height: 40 });
    expect(decode(windows[0]!.urls[0]!)).toContain('left:2px;top:4px');
    expect(framePage({ width: 1, height: 1, x: 0, y: 0 }, 2)).toContain('width%3A0.5px');
  });

  it('refuses an unknown display and hides idempotently', async () => {
    const { electron, windows } = fake();
    const p = createPixelPainter(electron);
    await expect(p.show(5, { width: 1, height: 1, x: 0, y: 0 })).rejects.toThrow(/no display 6/);
    await p.hide();
    await p.show(0, { width: 1, height: 1, x: 0, y: 0 });
    await p.hide();
    await p.hide();
    expect(windows[0]!.closed).toBe(true);
    await p.show(0, { width: 1, height: 1, x: 0, y: 0 });
    expect(windows).toHaveLength(2);
  });
});
