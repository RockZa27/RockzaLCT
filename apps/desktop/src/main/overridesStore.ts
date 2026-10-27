import { closeSync, copyFileSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_HARDWARE_OVERRIDES,
  parseHardwareOverridesJson,
  serializeHardwareOverrides,
  type HardwareOverrides,
} from '@rockzalct/shared';

export const OVERRIDES_FILE_NAME = 'hardware-overrides.json';

export interface OverridesStoreLog {
  warn(message: string): void;
  error(message: string): void;
}

export interface OverridesStore {
  /** Full path of the file. */
  readonly path: string;
  /** The saved values, or the defaults when the file is missing, unreadable or invalid. Never throws. */
  load(): HardwareOverrides;
  /** Atomically replace the file (temp file + rename). Never throws; a failure is logged and returned. */
  save(values: HardwareOverrides): { ok: true } | { ok: false; error: string };
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Persistent advanced hardware settings in `<dir>/hardware-overrides.json` (dir = Electron's
 * userData; injected so tests use a temp dir and never need Electron). The file is the same
 * versioned format as the export file of the settings page.
 */
export function createOverridesStore(dir: string, log: OverridesStoreLog = console): OverridesStore {
  const path = join(dir, OVERRIDES_FILE_NAME);

  return {
    path,

    load() {
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch (err) {
        // A missing file is the normal first run; anything else (permissions, a directory...) is worth a line.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn(`hardware overrides: cannot read ${path} (${message(err)}); using defaults`);
        }
        return { ...DEFAULT_HARDWARE_OVERRIDES };
      }
      const parsed = parseHardwareOverridesJson(text);
      if (parsed.ok) return parsed.values;
      log.warn(`hardware overrides: ${path} is invalid (${parsed.errors.join('; ')}); using defaults`);
      try {
        // Keep the bad file for inspection; the next save replaces the original.
        copyFileSync(path, `${path}.invalid`);
      } catch {
        // best effort
      }
      return { ...DEFAULT_HARDWARE_OVERRIDES };
    },

    save(values) {
      const tmp = `${path}.${process.pid}.tmp`;
      try {
        mkdirSync(dir, { recursive: true });
        const fd = openSync(tmp, 'w');
        try {
          writeSync(fd, serializeHardwareOverrides(values));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmp, path);
        return { ok: true };
      } catch (err) {
        try {
          unlinkSync(tmp);
        } catch {
          // nothing to clean up
        }
        const error = message(err);
        log.error(`hardware overrides: cannot save ${path} (${error})`);
        return { ok: false, error };
      }
    },
  };
}
