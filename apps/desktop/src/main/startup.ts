/** `--smoke-out=<path>`: where --smoke-test also writes its one-line result (GUI-subsystem exes have no console on Windows). */
export function resolveSmokeOut(argv: readonly string[]): string | undefined {
  const prefix = '--smoke-out=';
  const arg = argv.find((a) => a.startsWith(prefix) && a.length > prefix.length);
  return arg?.slice(prefix.length);
}

export interface StartupDeps {
  whenReady(): Promise<unknown>;
  /** Creates the device API, IPC handlers and window. May throw. */
  boot(): void;
  /** Blocking error dialog (Electron's dialog.showErrorBox). */
  showError(title: string, content: string): void;
  exit(code: number): void;
  logError(...args: unknown[]): void;
  /** In --smoke-test mode no dialog is shown (it would hang CI) and the failure is reported through `onSmokeFail`. */
  smoke: boolean;
  onSmokeFail?(err: unknown): void;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Runs `boot` once Electron is ready. Any failure (e.g. an unknown `--device=foo`) is reported and
 * the process exits with code 1 instead of lingering as a windowless zombie.
 */
export function runStartup(deps: StartupDeps): Promise<void> {
  return deps
    .whenReady()
    .then(() => deps.boot())
    .catch((err: unknown) => {
      deps.logError('STARTUP FAIL', err);
      if (deps.smoke) deps.onSmokeFail?.(err);
      else deps.showError('RockzaLCT ไม่สามารถเริ่มทำงานได้', errText(err));
      deps.exit(1);
    });
}
