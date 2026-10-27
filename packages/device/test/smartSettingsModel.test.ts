import { describe, expect, it } from 'vitest';
import {
  CHIP_TYPE_NAMES,
  DECODE_TYPE_NAMES,
  SMART_FIELDS,
  SMART_SETTINGS_METHODS,
  basicChanges,
  byteToRgbCode,
  computeRgbCode,
  decideOePolarity,
  diffSmartValues,
  isRgbPermutation,
  isValidDecodeType,
  profileFromSmartValues,
  rgbCodeToByte,
  smartChangesBetween,
  smartValuesFromProfile,
  smartValuesOf,
  validateSmartChanges,
  type ModuleProfile,
  type ReceiverParameters,
  type RgbCode,
  type RgbObservations,
  type SmartValues,
} from '@rockzalct/shared';

const VALUES: SmartValues = {
  moduleWidth: 64,
  moduleHeight: 32,
  scanMode: 16,
  dataGroups: 8,
  driverIc: 33,
  decodeType: 3,
  dataDirection: 0,
  oePolarity: 0,
  rgb: { red: 0, green: 1, blue: 2, virtualRed: 0 },
};

const obs = (red: RgbObservations['red'], green: RgbObservations['green'], blue: RgbObservations['blue']): RgbObservations => ({ red, green, blue });
const ident: RgbCode = { red: 0, green: 1, blue: 2, virtualRed: 0 };

describe('smart settings: method list and names', () => {
  it('lists every SmartSettingsApi method and every field once', () => {
    expect(Object.keys(SMART_SETTINGS_METHODS).sort()).toEqual(['readSmartSnapshot', 'writeSmartSettings']);
    expect(new Set(SMART_FIELDS).size).toBe(SMART_FIELDS.length);
    expect([...SMART_FIELDS].sort()).toEqual(Object.keys(VALUES).sort());
  });

  it('has the generated enum names', () => {
    expect(CHIP_TYPE_NAMES[1]).toBe('Chip_MBI5028');
    expect(CHIP_TYPE_NAMES[254]).toBe('Chip_CFD135A');
    expect(DECODE_TYPE_NAMES[3]).toBe('Decode595');
    expect(DECODE_TYPE_NAMES[58]).toBe('HX6258');
    expect(DECODE_TYPE_NAMES[53]).toBeUndefined();
  });
});

describe('smart settings: RGB code byte', () => {
  it('packs red | green << 2 | blue << 4 | virtualRed << 6 (SetRgbCode.cjs)', () => {
    expect(rgbCodeToByte({ red: 0, green: 1, blue: 2, virtualRed: 0 })).toBe(0b00_10_01_00);
    expect(rgbCodeToByte({ red: 2, green: 0, blue: 1, virtualRed: 3 })).toBe(0b11_01_00_10);
    expect(rgbCodeToByte({ red: 3, green: 3, blue: 3, virtualRed: 3 })).toBe(0xff);
  });

  it('round-trips every byte', () => {
    for (let b = 0; b < 256; b += 1) expect(rgbCodeToByte(byteToRgbCode(b))).toBe(b);
  });

  it('knows a permutation of 0..2', () => {
    expect(isRgbPermutation(ident)).toBe(true);
    expect(isRgbPermutation({ red: 2, green: 0, blue: 1 })).toBe(true);
    expect(isRgbPermutation({ red: 0, green: 0, blue: 1 })).toBe(false);
    expect(isRgbPermutation({ red: 0, green: 1, blue: 3 })).toBe(false);
  });
});

describe('smart settings: computeRgbCode', () => {
  it('keeps the code when the colours are already right', () => {
    const r = computeRgbCode(ident, obs('red', 'green', 'blue'));
    expect(r).toEqual({ ok: true, code: ident, unchanged: true, baseAssumed: false });
  });

  it('fixes the usual swaps (identical for the mapping and its inverse)', () => {
    // red shows green, green shows red -> swap the first two
    expect(computeRgbCode(ident, obs('green', 'red', 'blue'))).toMatchObject({ ok: true, code: { red: 1, green: 0, blue: 2 }, unchanged: false });
    // GBR style wiring: red shows blue, blue shows red
    expect(computeRgbCode(ident, obs('blue', 'green', 'red'))).toMatchObject({ ok: true, code: { red: 2, green: 1, blue: 0 } });
  });

  it('handles the two 3-cycles distinctly; the inverse convention gives the other answer', () => {
    // red->green, green->blue, blue->red
    const seen = obs('green', 'blue', 'red');
    expect(computeRgbCode(ident, seen)).toMatchObject({ ok: true, code: { red: 2, green: 0, blue: 1 } });
    expect(computeRgbCode(ident, seen, 'inverse')).toMatchObject({ ok: true, code: { red: 1, green: 2, blue: 0 } });
    // red->blue, green->red, blue->green
    const other = obs('blue', 'red', 'green');
    expect(computeRgbCode(ident, other)).toMatchObject({ ok: true, code: { red: 1, green: 2, blue: 0 } });
    expect(computeRgbCode(ident, other, 'inverse')).toMatchObject({ ok: true, code: { red: 2, green: 0, blue: 1 } });
    // swaps are the same in both conventions
    expect(computeRgbCode(ident, obs('green', 'red', 'blue'), 'inverse')).toEqual(computeRgbCode(ident, obs('green', 'red', 'blue')));
  });

  it('composes with a non-default current code and keeps virtualRed', () => {
    const cur: RgbCode = { red: 1, green: 2, blue: 0, virtualRed: 2 };
    // with the current code the panel shows everything correctly -> unchanged, same code, virtualRed kept
    const same = computeRgbCode(cur, obs('red', 'green', 'blue'));
    expect(same).toEqual({ ok: true, code: cur, unchanged: true, baseAssumed: false });
    // now red and green appear swapped: new r[X] = cur[T^-1[X]]
    const next = computeRgbCode(cur, obs('green', 'red', 'blue'));
    expect(next).toMatchObject({ ok: true, code: { red: 2, green: 1, blue: 0, virtualRed: 2 } });
    // the result is always a permutation
    if (next.ok) expect(isRgbPermutation(next.code)).toBe(true);
  });

  it('assumes the default order when the current code is not a permutation', () => {
    const r = computeRgbCode({ red: 0, green: 0, blue: 0, virtualRed: 1 }, obs('green', 'red', 'blue'));
    expect(r).toEqual({ ok: true, code: { red: 1, green: 0, blue: 2, virtualRed: 1 }, unchanged: false, baseAssumed: true });
    const same = computeRgbCode({ red: 0, green: 0, blue: 0, virtualRed: 0 }, obs('red', 'green', 'blue'));
    expect(same).toMatchObject({ ok: true, unchanged: false, baseAssumed: true });
  });

  it('refuses answers that are not a permutation', () => {
    expect(computeRgbCode(ident, obs('red', 'red', 'blue'))).toEqual({ ok: false, reason: 'invalid-observation' });
    expect(computeRgbCode(ident, obs('none', 'green', 'blue'))).toEqual({ ok: false, reason: 'invalid-observation' });
    expect(computeRgbCode(ident, obs('green', 'green', 'green'))).toEqual({ ok: false, reason: 'invalid-observation' });
  });

  it('every wiring and start code yields a permutation that fixes the display (model check, both conventions)', () => {
    const perms = [
      [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
    ] as const;
    const names = ['red', 'green', 'blue'] as const;
    for (const W of perms) {
      for (const start of perms) {
        const cur: RgbCode = { red: start[0], green: start[1], blue: start[2], virtualRed: 0 };
        const rCur = [cur.red, cur.green, cur.blue];
        // normal model: data X goes to slot r[X]; wiring shows slot k as colour W[k]
        const seenNormal = [0, 1, 2].map((x) => names[W[rCur[x]!]!]!);
        const a = computeRgbCode(cur, obs(seenNormal[0]!, seenNormal[1]!, seenNormal[2]!));
        expect(a.ok).toBe(true);
        if (a.ok) {
          const next = [a.code.red, a.code.green, a.code.blue];
          for (let x = 0; x < 3; x += 1) expect(W[next[x]!]).toBe(x);
        }
        // inverse model: slot X gets data channel r[X]; wiring shows slot k as colour W[k]
        const slotOf = [0, 0, 0];
        rCur.forEach((data, slot) => {
          slotOf[data] = slot;
        });
        const seenInverse = [0, 1, 2].map((x) => names[W[slotOf[x]!]!]!);
        const b = computeRgbCode(cur, obs(seenInverse[0]!, seenInverse[1]!, seenInverse[2]!), 'inverse');
        expect(b.ok).toBe(true);
        if (b.ok) {
          const next = [b.code.red, b.code.green, b.code.blue];
          const nextSlot = [0, 0, 0];
          next.forEach((data, slot) => {
            nextSlot[data] = slot;
          });
          for (let x = 0; x < 3; x += 1) expect(W[nextSlot[x]!]).toBe(x);
        }
      }
    }
  });
});

describe('smart settings: decideOePolarity', () => {
  it('keeps the polarity when the image is normal and toggles it when inverted', () => {
    expect(decideOePolarity(0, 'normal')).toEqual({ ok: true, value: 0, change: false });
    expect(decideOePolarity(1, 'normal')).toEqual({ ok: true, value: 1, change: false });
    expect(decideOePolarity(0, 'inverted')).toEqual({ ok: true, value: 1, change: true });
    expect(decideOePolarity(1, 'inverted')).toEqual({ ok: true, value: 0, change: true });
  });

  it('refuses a current value that is not 0 or 1', () => {
    expect(decideOePolarity(2, 'inverted')).toEqual({ ok: false, reason: 'invalid-current' });
    expect(decideOePolarity(255, 'normal')).toEqual({ ok: false, reason: 'invalid-current' });
    expect(decideOePolarity(0.5, 'normal')).toEqual({ ok: false, reason: 'invalid-current' });
  });
});

describe('smart settings: validateSmartChanges', () => {
  it('accepts edge values of every field', () => {
    expect(validateSmartChanges({ moduleWidth: 1, moduleHeight: 255, scanMode: 128, dataGroups: 255, driverIc: 254 })).toBeNull();
    expect(validateSmartChanges({ decodeType: 0, dataDirection: 1, oePolarity: 1 })).toBeNull();
    expect(validateSmartChanges({ decodeType: 58 })).toBeNull();
    expect(validateSmartChanges({ rgb: { red: 2, green: 0, blue: 1, virtualRed: 3 } })).toBeNull();
  });

  it('rejects out of range values, with the field in the message', () => {
    for (const [changes, field] of [
      [{ moduleWidth: 0 }, 'moduleWidth'],
      [{ moduleHeight: 256 }, 'moduleHeight'],
      [{ scanMode: 129 }, 'scanMode'],
      [{ scanMode: 0 }, 'scanMode'],
      [{ dataGroups: 0 }, 'dataGroups'],
      [{ driverIc: 255 }, 'driverIc'],
      [{ driverIc: -1 }, 'driverIc'],
      [{ decodeType: 59 }, 'decodeType'],
      [{ dataDirection: 2 }, 'dataDirection'],
      [{ oePolarity: 2 }, 'oePolarity'],
      [{ oePolarity: 255 }, 'oePolarity'],
      [{ moduleWidth: 1.5 }, 'moduleWidth'],
      [{ moduleWidth: '8' }, 'moduleWidth'],
      [{ moduleWidth: Number.NaN }, 'moduleWidth'],
    ] as const) {
      expect(validateSmartChanges(changes), JSON.stringify(changes)).toContain(field);
    }
  });

  it('rejects the DecodeTypeEnum gaps', () => {
    expect(isValidDecodeType(52)).toBe(true);
    expect(isValidDecodeType(53)).toBe(false);
    expect(isValidDecodeType(56)).toBe(false);
    expect(isValidDecodeType(255)).toBe(false);
    expect(validateSmartChanges({ decodeType: 53 })).toContain('decodeType');
    expect(validateSmartChanges({ decodeType: 56 })).toContain('decodeType');
  });

  it('rejects a bad rgb code, unknown fields and empty input', () => {
    expect(validateSmartChanges({ rgb: { red: 0, green: 0, blue: 1, virtualRed: 0 } })).toContain('three different');
    expect(validateSmartChanges({ rgb: { red: 3, green: 1, blue: 2, virtualRed: 0 } })).toContain('rgb.red');
    expect(validateSmartChanges({ rgb: { red: 0, green: 1, blue: 2, virtualRed: 4 } })).toContain('rgb.virtualRed');
    expect(validateSmartChanges({ rgb: { red: 0, green: 1, blue: 2 } })).toContain('rgb.virtualRed');
    expect(validateSmartChanges({ rgb: { red: 0, green: 1, blue: 2, virtualRed: 0, extra: 1 } })).toContain('unknown rgb field');
    expect(validateSmartChanges({ rgb: 5 })).toContain('rgb must be an object');
    expect(validateSmartChanges({ bogus: 1 })).toContain('unknown field: bogus');
    expect(validateSmartChanges({})).toContain('no values');
    expect(validateSmartChanges({ moduleWidth: undefined })).toContain('no values');
    expect(validateSmartChanges(null)).toContain('object');
    expect(validateSmartChanges([])).toContain('object');
  });

  it('restore mode only enforces the register widths', () => {
    const restore = { restore: true };
    expect(validateSmartChanges({ driverIc: 255, decodeType: 255, scanMode: 0, moduleWidth: 0, oePolarity: 255, dataDirection: 255 }, restore)).toBeNull();
    expect(validateSmartChanges({ rgb: { red: 3, green: 3, blue: 3, virtualRed: 3 } }, restore)).toBeNull();
    expect(validateSmartChanges({ decodeType: 53 }, restore)).toBeNull();
    expect(validateSmartChanges({ moduleWidth: 256 }, restore)).toContain('moduleWidth');
    expect(validateSmartChanges({ driverIc: -1 }, restore)).toContain('driverIc');
    expect(validateSmartChanges({ rgb: { red: 4, green: 0, blue: 0, virtualRed: 0 } }, restore)).toContain('rgb.red');
    expect(validateSmartChanges({}, restore)).toContain('no values');
  });
});

describe('smart settings: diff and profile helpers', () => {
  it('lists only the differing fields in write order, comparing the rgb code by value', () => {
    const after: SmartValues = { ...VALUES, moduleHeight: 16, oePolarity: 1, rgb: { red: 1, green: 0, blue: 2, virtualRed: 0 } };
    expect(diffSmartValues(VALUES, after).map((d) => d.field)).toEqual(['moduleHeight', 'rgb', 'oePolarity']);
    expect(diffSmartValues(VALUES, smartValuesOf(VALUES))).toEqual([]);
    expect(smartChangesBetween(VALUES, after)).toEqual({ moduleHeight: 16, oePolarity: 1, rgb: after.rgb });
    expect(Object.keys(basicChanges(VALUES, after))).toEqual(['moduleHeight']);
  });

  it('smartValuesOf copies the rgb object', () => {
    const copy = smartValuesOf(VALUES);
    copy.rgb.red = 2;
    expect(VALUES.rgb.red).toBe(0);
  });

  it('prefills the basics from a profile and keeps the rest', () => {
    const profile: ModuleProfile = {
      name: 'p',
      width: 96,
      height: 48,
      scanMode: 24,
      dataGroups: 12,
      refNumPerVs: 1,
      gamma: 1,
      grayDepth: 1,
      grayRealize: 0,
      grayMode: 0,
      driverIc: 40,
    };
    expect(smartValuesFromProfile(profile, VALUES)).toEqual({ ...VALUES, moduleWidth: 96, moduleHeight: 48, scanMode: 24, dataGroups: 12, driverIc: 40 });
    const { driverIc: _d, ...noIc } = profile;
    expect(smartValuesFromProfile(noIc, VALUES).driverIc).toBe(33);
  });

  it('builds a library profile that validates', () => {
    const params: ReceiverParameters = {
      portIndex: 0, cardIndex: 0, moduleWidth: 1, moduleHeight: 1, scanMode: 1, physicalDataGroups: 1, driverIc: 1,
      refNumPerVs: 1920, grayDepth: 14, grayRealize: 1, grayMode: 2, gamma: 28, icPerGroup: 4,
    };
    expect(profileFromSmartValues('N', VALUES, params)).toEqual({
      name: 'N', width: 64, height: 32, scanMode: 16, dataGroups: 8, refNumPerVs: 1920, gamma: 28, grayDepth: 14,
      grayRealize: 1, grayMode: 2, driverIc: 33, icPerGroup: 4,
    });
    // an unknown driver (255) is not stored
    expect(profileFromSmartValues('N', { ...VALUES, driverIc: 255 }, params)).not.toHaveProperty('driverIc');
  });
});
