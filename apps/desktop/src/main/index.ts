import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import type { DeviceApi } from '@rockzalct/shared';
import { getDeviceApi } from './deviceFactory';
import { registerDeviceIpc } from './ipc';
import { resolveSmokeOut, runStartup } from './startup';
import { SMOKE_SCR_BASE64 } from './smokeFixture';

/**
 * `--smoke-test`: boot for real, check the device layer answers and the preload bridge reached the
 * page, then exit 0 (non-zero on failure). CI runs the packaged app this way, because a broken
 * bundle (e.g. a native module or ESM require failing in Electron's Node) only shows up at runtime.
 *
 * `--smoke-out=<path>`: also write the result line to that file. A GUI-subsystem exe on Windows has
 * no console, so CI reads the file instead of stdout.
 */
const SMOKE = process.argv.includes('--smoke-test');
const SMOKE_OUT = resolveSmokeOut(process.argv);

const describeErr = (err: unknown): string =>
  err instanceof Error ? (err.stack ?? err.message) : String(err);

function smokeResult(line: string, ok: boolean): void {
  if (ok) console.log(line);
  else console.error(line);
  if (SMOKE_OUT) {
    try {
      writeFileSync(SMOKE_OUT, `${line}\n`);
    } catch (err) {
      console.error('SMOKE could not write', SMOKE_OUT, err);
    }
  }
}

function runSmokeTest(win: BrowserWindow, api: DeviceApi): void {
  const fail = (why: unknown): void => {
    smokeResult(`SMOKE FAIL ${describeErr(why)}`, false);
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
        // Decode a bundled .scr through the real parser: proves @novastar/screen loads when packaged.
        const scr = await api.parseScreenFile({ name: 'smoke.scr', bytes: new Uint8Array(Buffer.from(SMOKE_SCR_BASE64, 'base64')) });
        if (!scr.ok || scr.info.screens.length !== 1 || !scr.info.layout.ok) return fail(`scr decode failed: ${scr.ok ? 'unexpected layout' : scr.message}`);
        smokeResult(`SMOKE OK bridge=${bridge} discovered=${found.length} scr=${scr.info.screens[0]!.regions.length}`, true);
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
  smokeResult(`SMOKE FAIL ${describeErr(err)}`, false);
  app.exit(1);
});

void runStartup({
  whenReady: () => app.whenReady(),
  smoke: SMOKE,
  showError: (title, content) => dialog.showErrorBox(title, content),
  exit: (code) => app.exit(code),
  logError: (...args) => console.error(...args),
  onSmokeFail: (err) => smokeResult(`SMOKE FAIL ${describeErr(err)}`, false),
  boot: () => {
    const api = getDeviceApi(undefined, { userDataDir: app.getPath('userData') });
    registerDeviceIpc(ipcMain, api);
    const win = createWindow();
    if (SMOKE) runSmokeTest(win, api);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  },
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
