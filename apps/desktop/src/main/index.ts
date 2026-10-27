import { join } from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import type { DeviceApi } from '@rockzalct/shared';
import { getDeviceApi } from './deviceFactory';
import { registerDeviceIpc } from './ipc';

/**
 * `--smoke-test`: boot for real, check the device layer answers and the preload bridge reached the
 * page, then exit 0 (non-zero on failure). CI runs the packaged app this way, because a broken
 * bundle (e.g. a native module or ESM require failing in Electron's Node) only shows up at runtime.
 */
const SMOKE = process.argv.includes('--smoke-test');

function runSmokeTest(win: BrowserWindow, api: DeviceApi): void {
  const fail = (why: unknown): void => {
    console.error('SMOKE FAIL', why);
    app.exit(1);
  };
  setTimeout(() => fail('timeout'), 30_000).unref();
  win.webContents.once('did-fail-load', (_e, code, desc) => fail(`did-fail-load ${code} ${desc}`));
  win.webContents.once('did-finish-load', () => {
    void (async () => {
      try {
        const bridge = await win.webContents.executeJavaScript('typeof window.rockzalct');
        if (bridge !== 'object') return fail(`preload bridge is ${String(bridge)}`);
        const found = await api.discover();
        console.log(`SMOKE OK bridge=${bridge} discovered=${found.length}`);
        app.exit(0);
      } catch (err) {
        fail(err);
      }
    })();
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: !SMOKE,
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: 'RockzaLCT',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
  return win;
}

if (SMOKE) process.on('uncaughtException', (err) => {
  console.error('SMOKE FAIL', err);
  app.exit(1);
});

app.whenReady().then(() => {
  const api = getDeviceApi();
  registerDeviceIpc(ipcMain, api);
  const win = createWindow();
  if (SMOKE) runSmokeTest(win, api);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
