import type { PixelDisplay, PixelFrame, PixelPainter } from '@rockzalct/shared';

/**
 * Draws the marking pictures of the Smart Settings pixel-mapping step: a borderless, always-on-top,
 * black window at the top-left corner of one PC display with one flashing white pixel in it. The
 * sender (which is fed by that display) sends the picture to the cards; the card lights the LED
 * that belongs to that pixel, and the operator marks it on the grid. This is how NovaLCT lights a
 * table position (it draws one pixel on the desktop that feeds the sender).
 *
 * Positions are physical picture pixels. A display with Windows scaling other than 100% is handled by
 * dividing by the scale factor (window and dot are in device independent units), but the wizard
 * tells the operator to use 100% on that display because rounding at other scales is not verified.
 *
 * The electron objects are injected so that this file is unit tested without Electron.
 */

export interface ElectronDisplay {
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
}

export interface PainterWindow {
  loadURL(url: string): Promise<void>;
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  showInactive(): void;
  close(): void;
  isDestroyed(): boolean;
  on(event: 'closed', listener: () => void): void;
}

export interface PainterElectron {
  screen: { getAllDisplays(): ElectronDisplay[]; getPrimaryDisplay(): ElectronDisplay };
  createWindow(options: { x: number; y: number; width: number; height: number }): PainterWindow;
}

/** Page for one frame: black, one 400 ms flashing white pixel at (x, y) device independent units. */
export function framePage(frame: PixelFrame, scale: number): string {
  const px = 1 / scale;
  const x = frame.x / scale;
  const y = frame.y / scale;
  const html =
    `<!doctype html><meta charset="utf-8"><title>RockzaLCT pixel</title>` +
    `<style>html,body{margin:0;background:#000;overflow:hidden;cursor:none}` +
    `#p{position:absolute;left:${x}px;top:${y}px;width:${px}px;height:${px}px;background:#fff;animation:f .4s steps(1) infinite}` +
    `@keyframes f{0%{opacity:1}50%{opacity:0}}</style><div id="p"></div>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function createPixelPainter(electron: PainterElectron): PixelPainter {
  let win: PainterWindow | null = null;

  const displays = (): ElectronDisplay[] => electron.screen.getAllDisplays();
  const live = (): PainterWindow | null => (win && !win.isDestroyed() ? win : null);

  return {
    async listDisplays(): Promise<PixelDisplay[]> {
      const primary = electron.screen.getPrimaryDisplay();
      return displays().map((d, index) => ({
        index,
        label: `Display ${index + 1}`,
        width: Math.round(d.bounds.width * d.scaleFactor),
        height: Math.round(d.bounds.height * d.scaleFactor),
        primary: d.bounds.x === primary.bounds.x && d.bounds.y === primary.bounds.y,
      }));
    },

    async show(displayIndex, frame) {
      const d = displays()[displayIndex];
      if (!d) throw new Error(`no display ${displayIndex + 1}`);
      const scale = d.scaleFactor > 0 ? d.scaleFactor : 1;
      const bounds = {
        x: d.bounds.x,
        y: d.bounds.y,
        width: Math.max(1, Math.ceil(frame.width / scale)),
        height: Math.max(1, Math.ceil(frame.height / scale)),
      };
      let w = live();
      if (!w) {
        w = electron.createWindow(bounds);
        win = w;
        w.on('closed', () => {
          if (win === w) win = null;
        });
      } else {
        w.setBounds(bounds);
      }
      await w.loadURL(framePage(frame, scale));
      w.showInactive();
    },

    async hide() {
      const w = live();
      win = null;
      if (w) w.close();
    },
  };
}
