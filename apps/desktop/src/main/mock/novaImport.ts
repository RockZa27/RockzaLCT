import {
  DeviceError,
  checkRcfgxSend,
  validateReceiverTarget,
  type NovaImportApi,
  type RcfgxProgress,
  type SendRcfgxResult,
} from '@rockzalct/shared';
import { parseRcfgx, parseScr, type ParsedRcfgx } from '@rockzalct/device';
import type { MockContext } from './context';

/** Record sends the mock accepted, per controller: `port/card` or `all`, and the records written. */
export interface MockSentFile {
  fileId: string;
  target: string;
  records: number;
}

/**
 * In-memory novaImport feature. It runs the very same parsers and the same pre-send checks as the
 * real device layer (parseRcfgx / parseScr / checkRcfgxSend), so a rejected file behaves the same;
 * sending only records what would have been written (and the progress), nothing else.
 */
export function createMockNovaImport(ctx: MockContext, sent: Map<string, MockSentFile[]> = new Map()): NovaImportApi {
  const cache = new Map<string, ParsedRcfgx>();
  const progress = new Map<string, RcfgxProgress>();
  const running = new Set<string>();

  const asFile = (file: unknown): { name: string; bytes: Uint8Array } => {
    const f = file as { name?: unknown; bytes?: unknown } | null;
    if (typeof f !== 'object' || f === null || typeof f.name !== 'string' || !(f.bytes instanceof Uint8Array)) {
      throw new DeviceError('INVALID_ARGUMENT', 'file must be { name, bytes }');
    }
    return { name: f.name, bytes: f.bytes };
  };

  return {
    async parseRcfgxFile(file) {
      await ctx.delay();
      const res = parseRcfgx(asFile(file));
      if (!res.ok) return res;
      cache.set(res.parsed.info.fileId, res.parsed);
      return { ok: true, info: res.parsed.info };
    },

    async parseScreenFile(file) {
      await ctx.delay();
      return parseScr(asFile(file));
    },

    async sendRcfgx(id, fileId, target, options): Promise<SendRcfgxResult> {
      if (!ctx.isAdvanced()) throw new DeviceError('PERMISSION', 'advanced login required');
      ctx.requireConnected(id);
      const badTarget = validateReceiverTarget(target);
      if (badTarget) throw new DeviceError('INVALID_ARGUMENT', badTarget);
      const parsed = cache.get(fileId);
      if (!parsed) throw new DeviceError('INVALID_ARGUMENT', 'this file is no longer loaded; open it again');
      const bad = checkRcfgxSend(parsed.info, target, options);
      if (bad) throw new DeviceError('INVALID_ARGUMENT', bad);
      if (running.has(id)) throw new DeviceError('PROTOCOL', 'controller is busy with a long operation');
      running.add(id);
      const state: RcfgxProgress = {
        fileId,
        running: true,
        recordsTotal: parsed.records.length,
        recordsDone: 0,
        bytesTotal: parsed.info.totalBytes,
        bytesDone: 0,
        currentIndex: null,
        currentAddress: null,
        failed: false,
      };
      progress.set(id, state);
      try {
        for (let i = 0; i < parsed.records.length; i += 1) {
          const r = parsed.records[i]!;
          state.currentIndex = i;
          state.currentAddress = r.address;
          await ctx.delay();
          state.recordsDone += 1;
          state.bytesDone += r.data.length;
        }
      } finally {
        state.running = false;
        state.currentIndex = null;
        state.currentAddress = null;
        running.delete(id);
      }
      const list = sent.get(id) ?? [];
      list.push({ fileId, target: target.scope === 'all' ? 'all' : `${target.portIndex}/${target.cardIndex}`, records: parsed.records.length });
      sent.set(id, list);
      return {
        ok: true,
        fileId,
        recordsTotal: parsed.records.length,
        recordsWritten: parsed.records.length,
        bytesTotal: parsed.info.totalBytes,
        bytesWritten: parsed.info.totalBytes,
        commandRecordsWritten: parsed.info.commandRecords.length,
      };
    },

    async getRcfgxProgress(id) {
      ctx.requireConnected(id);
      const p = progress.get(id);
      return p ? { ...p } : null;
    },
  };
}
