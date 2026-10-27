// PLAN.md phase 6: the save / read-back / apply logic, written once against the phase 3-5 APIs so
// the real device layer and the desktop mock behave identically. No runtime deps, no I/O of its
// own: everything touching a controller goes through `PersistDeps`.

import type { DeviceErrorCode } from '../index.js';
import type {
  ApplyScreenConfigOptions,
  ApplyScreenConfigResult,
  ApplyStepResult,
  ConfigReadFailure,
  ConfigReadWarning,
  PersistApi,
  ReadScreenConfigResult,
  SaveItemResult,
  SaveToHardwareOptions,
  SaveToHardwareResult,
} from './persist.js';
import type { LayoutApi } from './layout.js';
import { describeLayoutIssue, inferLayout, layoutHasErrors, validateLayout } from './layoutModel.js';
import type { LayoutModel } from './layoutModel.js';
import { validateReceiverTarget } from './receiver.js';
import type { ReceiverApi, ReceiverTarget } from './receiver.js';
import { SENDER_MAX_PORTS } from './sender.js';
import type { SenderApi } from './sender.js';
import {
  SCREEN_CONFIG_FORMAT,
  SCREEN_CONFIG_VERSION,
  diffScreenConfig,
  receiverWritePlan,
  toConfigReceiver,
  validateScreenConfig,
} from './persistModel.js';
import type { ScreenConfig, ScreenConfigReceiver, ScreenConfigSender } from './persistModel.js';

export interface PersistDeps {
  sender: Pick<
    SenderApi,
    'getSenderVideo' | 'getSenderPorts' | 'setSenderResolution' | 'setSenderFieldRate' | 'setSenderInputSource' | 'setSenderPortEnabled'
  >;
  receiver: Pick<ReceiverApi, 'getReceiverParameters' | 'applyModuleProfile'>;
  layout: Pick<LayoutApi, 'readLayout' | 'writeLayout'>;
  isAdvanced(): boolean;
  /** Model / firmware strings as the connection page shows them. */
  readController(id: string): Promise<{ model: string; firmwareVersion?: string }>;
  /** Send the sender's save command. `value` undefined = the implementation's default. */
  saveSender(id: string, value?: number): Promise<void>;
  /** Send one card's store-to-flash command. `value` undefined = the implementation's default. */
  saveCard(id: string, portIndex: number, cardIndex: number, value?: number): Promise<void>;
  /** Builds the error to throw (a DeviceError in production; shared cannot import the class). */
  makeError(code: DeviceErrorCode, message: string): Error;
  now?(): Date;
}

const CODES: readonly string[] = ['NOT_FOUND', 'NOT_CONNECTED', 'TIMEOUT', 'PROTOCOL', 'PERMISSION', 'INVALID_ARGUMENT'];

function codeOf(err: unknown): DeviceErrorCode | 'UNKNOWN' {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && CODES.includes(code) ? (code as DeviceErrorCode) : 'UNKNOWN';
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Errors that mean "there is no such connection": reading further is pointless. */
const isGone = (err: unknown): boolean => codeOf(err) === 'NOT_FOUND' || codeOf(err) === 'NOT_CONNECTED';

const isByte = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255;
const cardKey = (p: number, c: number): string => `${p}:${c}`;

export function createPersistApi(deps: PersistDeps): PersistApi {
  const fail = (code: DeviceErrorCode, message: string): Error => deps.makeError(code, message);

  const requireAdvanced = (what: string): void => {
    if (!deps.isAdvanced()) throw fail('PERMISSION', `${what} requires the advanced user level`);
  };

  // -------------------------------------------------------------------------------------------
  // Read back

  async function snapshot(id: string): Promise<ReadScreenConfigResult> {
    const failures: ConfigReadFailure[] = [];
    const warnings: ConfigReadWarning[] = [];
    const record = (part: ConfigReadFailure['part'], err: unknown, at?: { portIndex: number; cardIndex: number }): void => {
      failures.push({ part, ...at, code: codeOf(err), message: messageOf(err) });
    };

    let model = 'Unknown';
    let firmwareVersion: string | undefined;
    try {
      const c = await deps.readController(id);
      model = c.model;
      firmwareVersion = c.firmwareVersion;
    } catch (err) {
      if (isGone(err)) throw err;
      record('controller', err);
    }

    let video: ScreenConfigSender['video'] | null = null;
    let ports: ScreenConfigSender['ports'] | null = null;
    try {
      video = await deps.sender.getSenderVideo(id);
    } catch (err) {
      if (isGone(err)) throw err;
      record('sender', err);
    }
    try {
      ports = await deps.sender.getSenderPorts(id);
    } catch (err) {
      if (isGone(err)) throw err;
      record('sender', err);
    }
    const sender: ScreenConfigSender | null = video && ports ? { video, ports } : null;

    // Receiving cards are enumerated from the sender's per-port card counts.
    const receivers: ScreenConfigReceiver[] = [];
    for (const port of ports ?? []) {
      for (let cardIndex = 0; cardIndex < port.receivingCards; cardIndex += 1) {
        try {
          receivers.push(toConfigReceiver(await deps.receiver.getReceiverParameters(id, port.portIndex, cardIndex)));
        } catch (err) {
          if (isGone(err)) throw err;
          record('receiver', err, { portIndex: port.portIndex, cardIndex });
        }
      }
    }

    let layout: LayoutModel | null = null;
    try {
      const hw = await deps.layout.readLayout(id);
      const inferred = inferLayout(hw);
      for (const issue of inferred.issues) {
        const code = issue.code === 'no-cards' ? 'layout-no-cards' : issue.code === 'not-a-grid' ? 'layout-not-a-grid' : 'layout-unsized-cards';
        warnings.push(issue.params ? { code, params: issue.params } : { code });
      }
      if (inferred.model) {
        if (layoutHasErrors(validateLayout(inferred.model, { maxPorts: SENDER_MAX_PORTS }))) warnings.push({ code: 'layout-invalid' });
        else layout = inferred.model;
      }
    } catch (err) {
      if (isGone(err)) throw err;
      record('layout', err);
    }

    const config: ScreenConfig = {
      format: SCREEN_CONFIG_FORMAT,
      version: SCREEN_CONFIG_VERSION,
      savedAt: (deps.now?.() ?? new Date()).toISOString(),
      controller: {
        model,
        ...(firmwareVersion !== undefined ? { firmwareVersion } : {}),
        outputPorts: ports?.length ?? 0,
        receivingCards: (ports ?? []).reduce((n, p) => n + p.receivingCards, 0),
      },
      sender,
      receivers,
      layout,
    };
    // Safety net: whatever was read must be a file this program could load again.
    const checked = validateScreenConfig(config);
    if (!checked.ok) {
      throw fail('PROTOCOL', `the controller returned values that do not fit a config file: ${checked.errors[0]!.message}`);
    }
    return { config: checked.config, failures, warnings, complete: failures.length === 0 };
  }

  // -------------------------------------------------------------------------------------------
  // Save to hardware

  async function saveToHardware(id: string, target: ReceiverTarget, options: SaveToHardwareOptions = {}): Promise<SaveToHardwareResult> {
    requireAdvanced('saving to hardware');
    const badTarget = validateReceiverTarget(target);
    if (badTarget) throw fail('INVALID_ARGUMENT', badTarget);
    if (typeof options !== 'object' || options === null) throw fail('INVALID_ARGUMENT', 'options must be an object');
    if (options.includeSender !== undefined && typeof options.includeSender !== 'boolean') {
      throw fail('INVALID_ARGUMENT', 'includeSender must be true or false');
    }
    for (const key of ['senderValue', 'receiverValue'] as const) {
      if (options[key] !== undefined && !isByte(options[key])) throw fail('INVALID_ARGUMENT', `${key} must be an integer 0..255`);
    }

    // Only cards that exist are addressed: a write to an absent card is silently dropped by the bus.
    const ports = await deps.sender.getSenderPorts(id);
    const all = ports.flatMap((p) => Array.from({ length: p.receivingCards }, (_, cardIndex) => ({ portIndex: p.portIndex, cardIndex })));
    let cards = all;
    if (target.scope === 'card') {
      cards = all.filter((c) => c.portIndex === target.portIndex && c.cardIndex === target.cardIndex);
      if (cards.length === 0) {
        throw fail('INVALID_ARGUMENT', `the controller has no receiving card at port ${target.portIndex} / card ${target.cardIndex}`);
      }
    }
    const includeSender = options.includeSender ?? target.scope === 'all';

    const cardResults: SaveItemResult[] = [];
    for (const c of cards) {
      try {
        await deps.saveCard(id, c.portIndex, c.cardIndex, options.receiverValue);
        cardResults.push({ ...c, ok: true });
      } catch (err) {
        if (isGone(err)) throw err;
        const code = codeOf(err);
        cardResults.push({ ...c, ok: false, code: code === 'UNKNOWN' ? 'PROTOCOL' : code, message: messageOf(err) });
      }
    }
    let senderResult: SaveItemResult | null = null;
    if (includeSender) {
      try {
        await deps.saveSender(id, options.senderValue);
        senderResult = { ok: true };
      } catch (err) {
        if (isGone(err)) throw err;
        const code = codeOf(err);
        senderResult = { ok: false, code: code === 'UNKNOWN' ? 'PROTOCOL' : code, message: messageOf(err) };
      }
    }
    return { sender: senderResult, cards: cardResults, ok: cardResults.every((r) => r.ok) && (senderResult?.ok ?? true) };
  }

  // -------------------------------------------------------------------------------------------
  // Apply

  async function applyScreenConfig(id: string, config: ScreenConfig, options: ApplyScreenConfigOptions = {}): Promise<ApplyScreenConfigResult> {
    requireAdvanced('applying a screen config');
    if (typeof options !== 'object' || options === null) throw fail('INVALID_ARGUMENT', 'options must be an object');
    const checked = validateScreenConfig(config);
    if (!checked.ok) {
      const first = checked.errors.slice(0, 3).map((e) => (e.field ? `${e.field}: ${e.message}` : e.message));
      throw fail('INVALID_ARGUMENT', `invalid screen config: ${first.join('; ')}`);
    }
    const file = checked.config;
    const want = {
      receivers: options.parts?.receivers !== false,
      layout: options.parts?.layout !== false,
      sender: options.parts?.sender !== false,
    };

    const current = await snapshot(id);
    const device = current.config;
    const diff = diffScreenConfig(file, device);
    const controllerKnown = !current.failures.some((f) => f.part === 'controller');

    // --- pre-flight: refuse before writing anything -----------------------------------------
    if (controllerKnown && diff.modelMismatch && !options.allowModelMismatch) {
      throw fail('INVALID_ARGUMENT', `the file is for "${file.controller.model}" but the connected controller is "${device.controller.model}"`);
    }
    if (want.receivers && diff.missingCards.length > 0 && !options.skipMissingCards) {
      const list = diff.missingCards.slice(0, 5).map((c) => `port ${c.portIndex} / card ${c.cardIndex}`).join(', ');
      throw fail('INVALID_ARGUMENT', `the controller has no receiving card at ${list}${diff.missingCards.length > 5 ? ', ...' : ''}`);
    }
    if (want.layout && file.layout) {
      const issues = validateLayout(file.layout, { maxPorts: SENDER_MAX_PORTS });
      if (layoutHasErrors(issues)) {
        const errs = issues.filter((i) => i.severity === 'error');
        throw fail('INVALID_ARGUMENT', `layout is invalid: ${errs.slice(0, 5).map(describeLayoutIssue).join('; ')}`);
      }
      if (!options.layout?.ignoreCardCount && device.sender) {
        const counts = new Map(device.sender.ports.map((p) => [p.portIndex, p.receivingCards]));
        for (const chain of file.layout.ports) {
          if (chain.cabinets.length === 0) continue;
          const actual = counts.get(chain.port) ?? 0;
          if (actual !== chain.cabinets.length) {
            throw fail('INVALID_ARGUMENT', `port ${chain.port} has ${actual} receiving card(s) but the layout wires ${chain.cabinets.length}`);
          }
        }
      }
    }

    // --- writes -----------------------------------------------------------------------------
    const steps: ApplyStepResult[] = [];
    const finish = (failedStep?: ApplyStepResult, save?: SaveToHardwareResult): ApplyScreenConfigResult => {
      const result: ApplyScreenConfigResult = { ok: failedStep === undefined, steps };
      if (failedStep) result.failedStep = failedStep;
      if (save) result.save = save;
      return result;
    };
    /** Run one write; on error record it as the failed step. Returns the failed step, or undefined. */
    const write = async (
      step: Pick<ApplyStepResult, 'kind' | 'portIndex' | 'cardIndex'>,
      fn: () => Promise<unknown>,
    ): Promise<ApplyStepResult | undefined> => {
      try {
        await fn();
        steps.push({ ...step, status: 'written' });
        return undefined;
      } catch (err) {
        const code = codeOf(err);
        const failed: ApplyStepResult = { ...step, status: 'failed', code: code === 'UNKNOWN' ? 'PROTOCOL' : code, message: messageOf(err) };
        steps.push(failed);
        return failed;
      }
    };

    // 1. receiving cards
    if (want.receivers) {
      const changed = new Set(diff.items.filter((i) => i.section === 'receiver').map((i) => cardKey(i.portIndex!, i.cardIndex!)));
      for (const m of diff.missingCards) {
        steps.push({ kind: 'receiver', ...m, status: 'skipped', message: 'the controller has no such card' });
      }
      for (const s of diff.skippedCards) {
        steps.push({ kind: 'receiver', portIndex: s.portIndex, cardIndex: s.cardIndex, status: 'skipped', message: s.reason });
      }
      const ordered = [...file.receivers].sort((a, b) => a.portIndex - b.portIndex || a.cardIndex - b.cardIndex);
      for (const card of ordered) {
        if (!changed.has(cardKey(card.portIndex, card.cardIndex))) continue;
        const plan = receiverWritePlan(card);
        if (plan.kind !== 'profile') continue; // reported above
        const failed = await write({ kind: 'receiver', portIndex: card.portIndex, cardIndex: card.cardIndex }, () =>
          deps.receiver.applyModuleProfile(id, { scope: 'card', portIndex: card.portIndex, cardIndex: card.cardIndex }, plan.profile),
        );
        if (failed) return finish(failed);
      }
    }

    // 2. layout
    if (want.layout && file.layout && diff.items.some((i) => i.section === 'layout')) {
      const layout = file.layout;
      const failed = await write({ kind: 'layout' }, () => deps.layout.writeLayout(id, layout, options.layout));
      if (failed) return finish(failed);
    }

    // 3. sender
    if (want.sender && file.sender) {
      const video = file.sender.video;
      const has = (field: string): boolean => diff.items.some((i) => i.section === 'sender' && i.field === field);
      if (has('resolution')) {
        const failed = await write({ kind: 'sender-resolution' }, () => deps.sender.setSenderResolution(id, { ...video.resolution }));
        if (failed) return finish(failed);
      }
      if (has('fieldRate')) {
        const failed = await write({ kind: 'sender-field-rate' }, () => deps.sender.setSenderFieldRate(id, video.fieldRate));
        if (failed) return finish(failed);
      }
      if (has('inputSource') && video.inputSource !== null) {
        const source = video.inputSource;
        const failed = await write({ kind: 'sender-input-source' }, () => deps.sender.setSenderInputSource(id, source));
        if (failed) return finish(failed);
      }
      for (const item of diff.items.filter((i) => i.section === 'sender' && i.field === 'portEnabled')) {
        const enabled = item.to === 'true';
        const failed = await write({ kind: 'sender-port', portIndex: item.portIndex! }, () =>
          deps.sender.setSenderPortEnabled(id, item.portIndex!, enabled),
        );
        if (failed) return finish(failed);
      }
    }

    // 4. optionally make it permanent
    if (options.saveToHardware) {
      let saved: SaveToHardwareResult;
      try {
        saved = await saveToHardware(id, { scope: 'all' }, { includeSender: true, ...options.save });
      } catch (err) {
        const code = codeOf(err);
        const failed: ApplyStepResult = { kind: 'save', status: 'failed', code: code === 'UNKNOWN' ? 'PROTOCOL' : code, message: messageOf(err) };
        steps.push(failed);
        return finish(failed);
      }
      if (!saved.ok) {
        const bad = [...saved.cards, ...(saved.sender ? [saved.sender] : [])].find((r) => !r.ok);
        const failed: ApplyStepResult = { kind: 'save', status: 'failed', ...(bad?.code ? { code: bad.code } : {}), message: bad?.message ?? 'save failed' };
        steps.push(failed);
        return finish(failed, saved);
      }
      steps.push({ kind: 'save', status: 'written' });
      return finish(undefined, saved);
    }
    return finish();
  }

  return { saveToHardware, readScreenConfig: snapshot, applyScreenConfig };
}
