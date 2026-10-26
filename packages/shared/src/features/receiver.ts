// PLAN.md phase 4: receiving card. Owned by the receiver feature; types + methods it adds to DeviceApi.
// Keep this file free of runtime deps (it is bundled into the renderer as well).

/**
 * Which receiving card(s) a write goes to.
 * `all` is a broadcast (port 0xFF / card 0xFFFF, no per-card acknowledgement); `card` addresses one
 * card by its sending-card output port and its position on that port's chain (both 0-based).
 */
export type ReceiverTarget = { scope: 'all' } | { scope: 'card'; portIndex: number; cardIndex: number };

/**
 * Parameters read from one receiving card. Every number is the RAW register value as defined by the
 * @novastar/native generated API (see packages/device/src/features/receiver.ts for the register
 * address of each field). Optional fields are omitted when the card answers with an error for that
 * register (not every firmware implements every register).
 */
export interface ReceiverParameters {
  portIndex: number;
  cardIndex: number;
  /** Module width in pixels, 1 byte. */
  moduleWidth: number;
  /** Module height in pixels, 1 byte. */
  moduleHeight: number;
  /** ScanTypeEnum value: 1 = static, N = `Scan_N` (1..128). */
  scanMode: number;
  /** Physical total data groups (data lines used per module). */
  physicalDataGroups: number;
  logicalDataGroups?: number;
  /** Data groups in one module. */
  groupsPerModule?: number;
  moduleRows?: number;
  /** ChipTypeEnum value of the LED driver IC (255 = Unknown). */
  driverIc: number;
  /** DecodeTypeEnum value of the row decoder. */
  decodeType?: number;
  /** Number of driver ICs per data group. */
  icPerGroup?: number;
  /** Refreshes per vertical sync ("RefNumPerVs"); refresh rate = frame rate x this. */
  refNumPerVs: number;
  /** Grayscale depth register (GrayDepth/GrayBit, same register 0x02000025). */
  grayDepth: number;
  /** GrayRealizeTypeEnum value, high nibble of the gray-mode register. */
  grayRealize: number;
  /** GrayModeTypeEnum value, low nibble of the gray-mode register. */
  grayMode: number;
  /** Gamma register, 1 byte. The native package applies no scaling; the unit is UNVERIFIED. */
  gamma: number;
  /** Card temperature byte; omitted when the card flags the reading invalid. Scale unverified. */
  temperatureRaw?: number;
  /** Card voltage byte. Scale unverified. */
  voltageRaw?: number;
}

/** The safe, commonly tuned subset that setReceiverParameters may write. */
export interface ReceiverWritable {
  refNumPerVs?: number;
  gamma?: number;
  grayDepth?: number;
  grayRealize?: number;
  grayMode?: number;
}

/** A reusable module definition ("module library" entry). A cabinet is built from several modules; cabinet geometry lives in the layout feature. All numbers are raw register values. */
export interface ModuleProfile {
  /** Unique within a library (case-insensitive), 1..64 characters. */
  name: string;
  width: number;
  height: number;
  scanMode: number;
  /** Written to the physical-total-data-group register. */
  dataGroups: number;
  refNumPerVs: number;
  gamma: number;
  grayDepth: number;
  grayRealize: number;
  grayMode: number;
  /** ChipTypeEnum value; written only when present. */
  driverIc?: number;
  /** Driver ICs per data group; written only when present. */
  icPerGroup?: number;
  /** Free text, up to 200 characters. */
  note?: string;
}

export interface ReceiverApi {
  /** Read the parameters of one receiving card. Allowed for every user level. */
  getReceiverParameters(id: string, portIndex: number, cardIndex: number): Promise<ReceiverParameters>;
  /**
   * Write refresh/gamma/grayscale fields to one card or broadcast to all. Advanced level only
   * (DeviceError PERMISSION otherwise). With scope 'all', grayRealize and grayMode must be given
   * together because they share one register and a broadcast cannot read-modify-write.
   */
  setReceiverParameters(id: string, target: ReceiverTarget, params: ReceiverWritable): Promise<void>;
  /** Write every field of a module profile to the target card(s). Advanced level only. */
  applyModuleProfile(id: string, target: ReceiverTarget, profile: ModuleProfile): Promise<void>;
}

/** Every ReceiverApi method name; typed so a missing/extra name is a compile error. */
export const RECEIVER_METHODS: { [K in keyof ReceiverApi]-?: true } = {
  getReceiverParameters: true,
  setReceiverParameters: true,
  applyModuleProfile: true,
};

// ---------------------------------------------------------------------------------------------
// Limits and names

/** Inclusive limits implied by the register widths used by the native encoders. */
export const RECEIVER_LIMITS = {
  /** SetModuleWidth/SetModuleHeight encode 1 byte; 0 is meaningless. */
  size: { min: 1, max: 255 },
  /** ScanTypeEnum Scan_static(1)..Scan_128(128). */
  scanMode: { min: 1, max: 128 },
  /** SetPhysicalTotalDataGroupNum encodes 1 byte. */
  dataGroups: { min: 1, max: 255 },
  /** SetRefNumPerVs encodes 2 bytes. */
  refNumPerVs: { min: 1, max: 0xffff },
  /** SetGamma encodes 1 byte. */
  gamma: { min: 0, max: 255 },
  /** SetGrayDepth encodes 1 byte. */
  grayDepth: { min: 0, max: 255 },
  /** GrayRealizeTypeEnum Traditional(0)..BrightEfficiency(5). */
  grayRealize: { min: 0, max: 5 },
  /** GrayModeTypeEnum Lowlight(0)..LowerLowLight(3); Unknown(255) is not writable. */
  grayMode: { min: 0, max: 3 },
  /** ChipTypeEnum 0..254; 255 is Unknown. */
  driverIc: { min: 0, max: 254 },
  /** SetICNumber encodes 1 byte. */
  icPerGroup: { min: 0, max: 255 },
  nameLength: 64,
  noteLength: 200,
} as const;

/** GrayRealizeTypeEnum member names from @novastar/native GrayRealizeType.d.cts, index = value. */
export const GRAY_REALIZE_NAMES = ['Traditional', 'HGHR', 'GrayFrist', 'Blance', 'Photograph', 'BrightEfficiency'] as const;
/** GrayModeTypeEnum member names from @novastar/native GrayModeType.d.cts, index = value. */
export const GRAY_MODE_NAMES = ['Lowlight', 'Normallight', 'Highlight', 'LowerLowLight'] as const;

// ---------------------------------------------------------------------------------------------
// Validation (pure; used by the device layer, the mock and the renderer)

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

const inRange = (v: unknown, r: { readonly min: number; readonly max: number }): v is number =>
  isInt(v) && v >= r.min && v <= r.max;

/** Error message for an unusable card address, or null. Indexes must not collide with the broadcast values. */
export function validateReceiverTarget(target: unknown): string | null {
  if (typeof target !== 'object' || target === null) return 'target must be an object';
  const t = target as Record<string, unknown>;
  if (t.scope === 'all') return null;
  if (t.scope !== 'card') return "target.scope must be 'all' or 'card'";
  if (!inRange(t.portIndex, { min: 0, max: 0xfe })) return 'target.portIndex must be an integer 0..254';
  if (!inRange(t.cardIndex, { min: 0, max: 0xfffe })) return 'target.cardIndex must be an integer 0..65534';
  return null;
}

/** Error message for a card (port, index) pair used by reads, or null. */
export function validateCardIndex(portIndex: unknown, cardIndex: unknown): string | null {
  return validateReceiverTarget({ scope: 'card', portIndex, cardIndex });
}

/** Error message for a ReceiverWritable (alone, or for the given target), or null. */
export function validateReceiverWritable(params: unknown, target?: ReceiverTarget): string | null {
  if (typeof params !== 'object' || params === null) return 'params must be an object';
  const p = params as Record<string, unknown>;
  const known = ['refNumPerVs', 'gamma', 'grayDepth', 'grayRealize', 'grayMode'] as const;
  for (const key of Object.keys(p)) {
    if (!(known as readonly string[]).includes(key)) return `unknown field: ${key}`;
  }
  for (const key of known) {
    const v = p[key];
    if (v === undefined) continue;
    const range = RECEIVER_LIMITS[key];
    if (!inRange(v, range)) return `${key} must be an integer ${range.min}..${range.max}, got ${String(v)}`;
  }
  if (known.every((k) => p[k] === undefined)) return 'no parameters to write';
  if (target?.scope === 'all' && (p.grayRealize === undefined) !== (p.grayMode === undefined)) {
    return 'grayRealize and grayMode must be set together when the target is all cards';
  }
  return null;
}

export interface ModuleFieldError {
  field: string;
  message: string;
}

export type ModuleValidation =
  | { ok: true; profile: ModuleProfile }
  | { ok: false; errors: ModuleFieldError[] };

/**
 * Validate an unknown value as a ModuleProfile. On success returns a normalised copy (name and
 * note trimmed, unknown keys dropped, empty optionals removed).
 */
export function validateModuleProfile(input: unknown): ModuleValidation {
  const errors: ModuleFieldError[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ field: '', message: 'profile must be an object' }] };
  }
  const v = input as Record<string, unknown>;
  const num = (field: string, range: { readonly min: number; readonly max: number }): number => {
    const x = v[field];
    if (!inRange(x, range)) {
      errors.push({ field, message: `${field} must be an integer ${range.min}..${range.max}` });
      return range.min;
    }
    return x;
  };

  let name = '';
  if (typeof v.name !== 'string' || v.name.trim().length === 0) {
    errors.push({ field: 'name', message: 'name is required' });
  } else if (v.name.trim().length > RECEIVER_LIMITS.nameLength) {
    errors.push({ field: 'name', message: `name must be at most ${RECEIVER_LIMITS.nameLength} characters` });
  } else {
    name = v.name.trim();
  }

  const profile: ModuleProfile = {
    name,
    width: num('width', RECEIVER_LIMITS.size),
    height: num('height', RECEIVER_LIMITS.size),
    scanMode: num('scanMode', RECEIVER_LIMITS.scanMode),
    dataGroups: num('dataGroups', RECEIVER_LIMITS.dataGroups),
    refNumPerVs: num('refNumPerVs', RECEIVER_LIMITS.refNumPerVs),
    gamma: num('gamma', RECEIVER_LIMITS.gamma),
    grayDepth: num('grayDepth', RECEIVER_LIMITS.grayDepth),
    grayRealize: num('grayRealize', RECEIVER_LIMITS.grayRealize),
    grayMode: num('grayMode', RECEIVER_LIMITS.grayMode),
  };
  if (v.driverIc !== undefined && v.driverIc !== null) profile.driverIc = num('driverIc', RECEIVER_LIMITS.driverIc);
  if (v.icPerGroup !== undefined && v.icPerGroup !== null) profile.icPerGroup = num('icPerGroup', RECEIVER_LIMITS.icPerGroup);
  if (v.note !== undefined && v.note !== null) {
    if (typeof v.note !== 'string' || v.note.length > RECEIVER_LIMITS.noteLength) {
      errors.push({ field: 'note', message: `note must be text of at most ${RECEIVER_LIMITS.noteLength} characters` });
    } else if (v.note.trim() !== '') {
      profile.note = v.note.trim();
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, profile };
}

// ---------------------------------------------------------------------------------------------
// JSON (de)serialisation

export const MODULE_LIBRARY_FORMAT = 'rockzalct.module-library';
export const MODULE_LIBRARY_VERSION = 1;

export function serializeModuleProfile(profile: ModuleProfile): string {
  return JSON.stringify(profile, null, 2);
}

function parseJson(json: string): { ok: true; value: unknown } | { ok: false; errors: ModuleFieldError[] } {
  try {
    return { ok: true, value: JSON.parse(json) as unknown };
  } catch (err) {
    return { ok: false, errors: [{ field: '', message: `invalid JSON: ${(err as Error).message}` }] };
  }
}

export function parseModuleProfileJson(json: string): ModuleValidation {
  const parsed = parseJson(json);
  return parsed.ok ? validateModuleProfile(parsed.value) : parsed;
}

export function serializeModuleLibrary(profiles: readonly ModuleProfile[]): string {
  return JSON.stringify({ format: MODULE_LIBRARY_FORMAT, version: MODULE_LIBRARY_VERSION, profiles }, null, 2);
}

export type ModuleLibraryValidation =
  | { ok: true; profiles: ModuleProfile[] }
  | { ok: false; errors: ModuleFieldError[] };

/** Validate a decoded library document; field names are prefixed `profiles[i].`. */
export function validateModuleLibrary(input: unknown): ModuleLibraryValidation {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: [{ field: '', message: 'library must be an object' }] };
  }
  const doc = input as Record<string, unknown>;
  if (doc.format !== MODULE_LIBRARY_FORMAT) {
    return { ok: false, errors: [{ field: 'format', message: `format must be "${MODULE_LIBRARY_FORMAT}"` }] };
  }
  if (doc.version !== MODULE_LIBRARY_VERSION) {
    return { ok: false, errors: [{ field: 'version', message: `unsupported version ${String(doc.version)}` }] };
  }
  if (!Array.isArray(doc.profiles)) {
    return { ok: false, errors: [{ field: 'profiles', message: 'profiles must be an array' }] };
  }
  const errors: ModuleFieldError[] = [];
  const profiles: ModuleProfile[] = [];
  const seen = new Set<string>();
  doc.profiles.forEach((raw, i) => {
    const res = validateModuleProfile(raw);
    if (!res.ok) {
      for (const e of res.errors) errors.push({ field: `profiles[${i}].${e.field}`, message: e.message });
      return;
    }
    const key = res.profile.name.toLowerCase();
    if (seen.has(key)) {
      errors.push({ field: `profiles[${i}].name`, message: `duplicate name: ${res.profile.name}` });
      return;
    }
    seen.add(key);
    profiles.push(res.profile);
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, profiles };
}

export function parseModuleLibraryJson(json: string): ModuleLibraryValidation {
  const parsed = parseJson(json);
  return parsed.ok ? validateModuleLibrary(parsed.value) : parsed;
}
