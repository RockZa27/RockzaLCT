import { DeviceError, createPersistApi, type PersistApi } from '@rockzalct/shared';
// Side-effect imports: each adds one method to the codec Session prototype.
//   dist/api/SetSaveSendCardsParameters.cjs  : sender (deviceType 0, none set), register 16777217 (0x01000001), 1 byte
//   dist/api/SetParameterStore2SpiFlash.cjs  : receiving card (deviceType 1), register 16777233 (0x01000011), 1 byte
// AddressMapping.d.cts names them SaveSendCardsParametersAddr (+Occupancy 1) and
// ParameterStore2SpiFlashAddr (+Occupancy 1, "ParameterStore2SpiFlash_addr"). Its sibling
// ParameterReloadFromSpiFlashAddr (0x01000010, SetParameterReloadFromSpiFlash) is the "load from
// flash" counterpart, which is why the 0x01000011 write is read as "store to flash".
import '@novastar/native/api/SetSaveSendCardsParameters';
import '@novastar/native/api/SetParameterStore2SpiFlash';
import { createReceiverFeature } from './receiver.js';
import { createSenderFeature } from './sender.js';
import { createLayoutFeature } from './layout.js';
import { currentOverrides, type FeatureContext } from './context.js';
import type { SessionLike } from '../session.js';

/**
 * Argument bytes of the two save commands.
 *
 * UNVERIFIED ON HARDWARE. @novastar/native documents no value for either register: both generated
 * functions (SetSaveSendCardsParameters.cjs, SetParameterStore2SpiFlash.cjs) just encode a caller
 * supplied number into 1 byte (AddressMapping *Occupancy = 1) and there is no enum for it (searched
 * dist/*.d.cts for Save/Store/Flash types: none). 1 was chosen as the conventional "trigger" value:
 * it is also what DISPLAY_MODE_VALUES uses for the other 1-byte action registers in this repo, and
 * the readable counterpart ReadSaveSendCardsParameters (Session.cjs, same address) suggests the
 * register holds a flag. If a card ignores 1, override per call (SaveToHardwareOptions) or for the
 * whole service (second argument of createPersistFeature) or, at run time, via the advanced hardware
 * settings (HardwareOverrides.saveSender / saveReceiver, read at call time from ctx).
 */
export const SAVE_COMMAND_VALUES = {
  /** Written to the sender's SaveSendCardsParameters register. */
  sender: 1,
  /** Written to each receiving card's ParameterStore2SpiFlash register. */
  receiver: 1,
} as const;

export type SaveCommandValues = { [K in keyof typeof SAVE_COMMAND_VALUES]: number };

/** The native methods this feature adds (signatures from dist/*.d.cts). */
interface PersistSession {
  SetSaveSendCardsParameters(addr: number, broadcast: boolean, value: number): Promise<void>;
  SetParameterStore2SpiFlash(addr: number, port: number, card: number, broadcast: boolean, value: number): Promise<void>;
}

const SENDER = 0;
const asPersist = (s: SessionLike): PersistSession => s as unknown as PersistSession;

/** Same text as service.ts `formatEdition` / `modelName` (service.ts imports this file, so it cannot be imported back). */
function formatEdition(edition: number): string {
  const v = edition >>> 0;
  const base = `${v >>> 24}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}`;
  return (v & 0xff) === 0 ? base : `${base}.${v & 0xff}`;
}
const modelName = (modelId: number): string => `Unknown (0x${(modelId >>> 0).toString(16).toUpperCase().padStart(4, '0')})`;

export function createPersistFeature(ctx: FeatureContext, saveValues: Partial<SaveCommandValues> = {}): PersistApi {
  // Precedence per call: explicit argument of the call > `saveValues` given to this factory > the
  // advanced hardware settings in effect now (ctx) > SAVE_COMMAND_VALUES. The ctx value is read inside
  // each command, not here, so a settings change applies to the next save.
  const senderValue = (): number => saveValues.sender ?? currentOverrides(ctx).saveSender;
  const receiverValue = (): number => saveValues.receiver ?? currentOverrides(ctx).saveReceiver;
  return createPersistApi({
    sender: createSenderFeature(ctx),
    receiver: createReceiverFeature(ctx),
    layout: createLayoutFeature(ctx),
    isAdvanced: () => ctx.userLevel().level === 'advanced',
    makeError: (code, message) => new DeviceError(code, message),
    readController: (id) =>
      ctx.withSession(id, async (s) => {
        const modelId = await s.ReadControllerModelId(SENDER);
        return { model: modelName(modelId), firmwareVersion: formatEdition(await s.ReadSender_McuProgramEdition(SENDER)) };
      }),
    saveSender: (id, value) =>
      ctx.withSession(id, (s) => asPersist(s).SetSaveSendCardsParameters(SENDER, false, value ?? senderValue())),
    saveCard: (id, portIndex, cardIndex, value) =>
      ctx.withSession(id, (s) => asPersist(s).SetParameterStore2SpiFlash(SENDER, portIndex, cardIndex, false, value ?? receiverValue())),
  });
}
