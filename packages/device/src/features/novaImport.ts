// NovaLCT file import: replay a .rcfgx register-write list on a receiving card, parse .rcfgx/.scr.
//
// Write sequence mirrors sendNcpCabinetConfig in @novastar/screen (MIT, (c) Andrei Sarakeev), which
// sends the same SendParam list (it is the only sender of such a list in that repo):
//   per record: Request(data) with deviceType ReceivingCard; chunked with Request.makeChunks at the
//   connection's own maxLength (the library splits a record into consecutive-address chunks; we call
//   makeChunks ourselves only to report progress and to stop between chunks - the chunk size is the
//   connection's, never ours); each chunk is sent with connection.send (acknowledged unless broadcast;
//   a broadcast chunk is followed by the library's own 50 ms pause);
//   then `delay` ms; then, if pollingTime > 0, poll the busy register 0x02000001 (ack 0 = idle) every
//   200 ms for up to pollingTime + 10 s, then wait 1000 + (pollingWaitTime & 0x7fff) ms.
// Addressing follows the other features of this repo (SENDER 0, broadcast = port 0xFF / card 0xFFFF
// with the broadcast flag), not NcpSender's destination 0xFF.
import { DeviceType, ErrorType, Request } from '@novastar/codec';
import {
  DeviceError,
  checkRcfgxSend,
  validateReceiverTarget,
  validateRcfgxRecords,
  NovaFileError,
  type DeviceErrorCode,
  type NovaFileInput,
  type NovaImportApi,
  type RcfgxProgress,
  type RcfgxRecord,
  type ReceiverTarget,
  type SendRcfgxFailure,
  type SendRcfgxOptions,
  type SendRcfgxResult,
} from '@rockzalct/shared';
import type { FeatureContext } from './context.js';
import type { SessionLike } from '../session.js';
import { parseRcfgx, parseScr, type ParsedRcfgx } from './novaImportParse.js';

const SENDER = 0;
const ALL_PORTS = 0xff;
const ALL_CARDS = 0xffff;
/** Receiving-card busy register NovaLCT polls after a slow record (scannerBusyAddress in NcpSender). */
export const SCANNER_BUSY_ADDRESS = 0x0200_0001;
const POLL_RETRY_MS = 200;
const POLL_SLACK_MS = 10_000;
const POLL_DONE_BASE_MS = 1000;
const POLL_WAIT_MASK = 0x7fff;
const CACHE_SIZE = 3;

/** The slice of the codec Session this feature uses. */
interface ConnectionLike {
  maxLength: number;
  send(req: Request<boolean>): Promise<unknown>;
  trySend(req: Request<boolean>): Promise<{ ack: number } | null>;
}
interface ConnectedSession {
  connection: ConnectionLike;
}

export interface NovaImportOptions {
  /** Pause implementation; tests inject a recorder. Default: setTimeout. */
  sleep?(ms: number): Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const invalid = (message: string): DeviceError => new DeviceError('INVALID_ARGUMENT', message);

function toDeviceError(err: unknown): DeviceError {
  if (err instanceof DeviceError) return err;
  return new DeviceError('PROTOCOL', err instanceof Error ? err.message : String(err));
}

const asFile = (file: unknown): NovaFileInput => {
  const f = file as Partial<NovaFileInput> | null;
  if (typeof f !== 'object' || f === null || typeof f.name !== 'string' || !(f.bytes instanceof Uint8Array)) {
    throw invalid('file must be { name, bytes }');
  }
  return { name: f.name, bytes: f.bytes };
};

export function createNovaImportFeature(ctx: FeatureContext, opts: NovaImportOptions = {}): NovaImportApi {
  const sleep = opts.sleep ?? defaultSleep;
  /** Parsed files by id, newest last. The renderer never sees the register data. */
  const cache = new Map<string, ParsedRcfgx>();
  const progress = new Map<string, RcfgxProgress>();

  const remember = (parsed: ParsedRcfgx): void => {
    cache.delete(parsed.info.fileId);
    cache.set(parsed.info.fileId, parsed);
    while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  };

  async function waitForCard(conn: ConnectionLike, port: number, card: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs + POLL_SLACK_MS;
    for (;;) {
      const req = new Request(16, 'rcfgx:poll');
      req.address = SCANNER_BUSY_ADDRESS;
      req.deviceType = DeviceType.ReceivingCard;
      req.destination = SENDER;
      req.port = port;
      req.rcvIndex = card;
      req.timeout = 5000;
      // ack 0 = idle, 1 = still busy; no answer = keep trying until the deadline
      const res = await conn.trySend(req);
      if (res?.ack === ErrorType.Succeeded) return;
      if (res && res.ack !== ErrorType.Timeout && res.ack !== 1) throw new DeviceError('PROTOCOL', `card refused the busy poll (ack ${res.ack})`);
      if (Date.now() >= deadline) throw new DeviceError('TIMEOUT', 'receiving card did not become ready');
      await sleep(POLL_RETRY_MS);
    }
  }

  async function writeRecords(
    session: SessionLike,
    parsed: ParsedRcfgx,
    target: ReceiverTarget,
    state: RcfgxProgress,
  ): Promise<SendRcfgxResult> {
    const conn = (session as unknown as ConnectedSession).connection;
    const broadcast = target.scope === 'all';
    const port = target.scope === 'all' ? ALL_PORTS : target.portIndex;
    const card = target.scope === 'all' ? ALL_CARDS : target.cardIndex;
    const { records } = parsed;
    const result: SendRcfgxResult = {
      ok: true,
      fileId: parsed.info.fileId,
      recordsTotal: records.length,
      recordsWritten: 0,
      bytesTotal: state.bytesTotal,
      bytesWritten: 0,
      commandRecordsWritten: 0,
    };
    for (let index = 0; index < records.length; index += 1) {
      const rec = records[index]!;
      state.currentIndex = index;
      state.currentAddress = rec.address;
      try {
        const req = new Request(Buffer.from(rec.data), broadcast, `rcfgx:${index}`);
        req.address = rec.address;
        req.deviceType = DeviceType.ReceivingCard;
        req.destination = SENDER;
        req.port = port;
        req.rcvIndex = card;
        for (const chunk of Request.makeChunks(req, conn.maxLength)) {
          // makeChunks builds the 2nd..nth chunk from a bare Packet and drops the broadcast flag
          // (codec 2.2.3: only a Request source copies it), which would make the connection wait
          // for acknowledgements a broadcast never gets. Set it back on every chunk.
          (chunk as { broadcast: boolean }).broadcast = broadcast; // typed readonly, a plain field at run time
          await conn.send(chunk);
          state.bytesDone += chunk.length;
        }
        if (rec.delayMs > 0) await sleep(rec.delayMs);
        if (rec.pollingTime > 0) {
          await waitForCard(conn, port, card, rec.pollingTime);
          await sleep(POLL_DONE_BASE_MS + (rec.pollingWaitTime & POLL_WAIT_MASK));
        }
      } catch (err) {
        const e = toDeviceError(err);
        const failed: SendRcfgxFailure = { recordIndex: index, address: rec.address, code: e.code as DeviceErrorCode & SendRcfgxFailure['code'], message: e.message };
        result.ok = false;
        result.failed = failed;
        state.failed = true;
        return result;
      }
      result.recordsWritten += 1;
      result.bytesWritten += rec.data.length;
      if (rec.address >>> 24 === 0x01) result.commandRecordsWritten += 1;
      state.recordsDone = result.recordsWritten;
    }
    return result;
  }

  return {
    async parseRcfgxFile(file) {
      const res = parseRcfgx(asFile(file));
      if (!res.ok) return res;
      remember(res.parsed);
      return { ok: true, info: res.parsed.info };
    },

    parseScreenFile: async (file) => parseScr(asFile(file)),

    async sendRcfgx(id, fileId, target, options: SendRcfgxOptions) {
      if (ctx.userLevel().level !== 'advanced') {
        throw new DeviceError('PERMISSION', 'advanced user level required to write a configuration file to a receiving card');
      }
      const badTarget = validateReceiverTarget(target);
      if (badTarget) throw invalid(badTarget);
      const parsed = typeof fileId === 'string' ? cache.get(fileId) : undefined;
      if (!parsed) throw invalid('this file is no longer loaded; open it again');
      const bad = checkRcfgxSend(parsed.info, target, options);
      if (bad) throw invalid(bad);
      // Defence in depth: the records were validated when parsed; check again right before sending.
      try {
        validateRcfgxRecords(parsed.records as readonly RcfgxRecord[]);
      } catch (err) {
        throw invalid(err instanceof NovaFileError ? err.message : String(err));
      }
      const run = ctx.withExclusiveSession ?? ctx.withSession;
      return run(id, async (session) => {
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
          return await writeRecords(session, parsed, target, state);
        } finally {
          state.running = false;
          state.currentIndex = null;
          state.currentAddress = null;
        }
      });
    },

    async getRcfgxProgress(id) {
      const p = progress.get(id);
      return p ? { ...p } : null;
    },
  };
}

