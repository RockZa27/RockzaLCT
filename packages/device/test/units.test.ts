import { describe, expect, it } from 'vitest';
import {
  GAMMA_DEFAULT,
  decodeGamma,
  encodeGamma,
  fanRpm,
  humidityPct,
  smokeAlarm,
  temperatureC,
  voltageV,
} from '@rockzalct/shared';

describe('units: temperature (flags bit7 valid / bit0 negative, magnitude x 0.5 C)', () => {
  it('decodes the documented example and halves', () => {
    expect(temperatureC(0x80, 0x32)).toBe(25);
    expect(temperatureC(0x80, 0x33)).toBe(25.5);
    expect(temperatureC(0x80, 0)).toBe(0);
    expect(temperatureC(0x80, 255)).toBe(127.5);
  });
  it('applies the sign from bit0', () => {
    expect(temperatureC(0x81, 0x32)).toBe(-25);
    expect(temperatureC(0x81, 3)).toBe(-1.5);
    expect(Object.is(temperatureC(0x81, 0), 0)).toBe(true); // no negative zero
  });
  it('is null when the valid bit is clear, whatever the other bits say', () => {
    expect(temperatureC(0x00, 0x32)).toBeNull();
    expect(temperatureC(0x01, 0x32)).toBeNull();
    expect(temperatureC(0x7f, 0x32)).toBeNull();
  });
});

describe('units: humidity, voltage, fan, smoke', () => {
  it('humidity is the low 7 bits in %RH', () => {
    expect(humidityPct(0x80 | 45)).toBe(45);
    expect(humidityPct(0xff)).toBe(127);
    expect(humidityPct(45)).toBeNull();
  });
  it('voltage is the low 7 bits x 0.1 V', () => {
    expect(voltageV(0xb2)).toBe(5);
    expect(voltageV(0x32 | 0x80)).toBe(5);
    expect(voltageV(0x80 | 45)).toBe(4.5);
    expect(voltageV(0x80 | 55)).toBe(5.5);
    expect(voltageV(0x80 | 33)).toBe(3.3);
    expect(voltageV(0x32)).toBeNull();
  });
  it('fan is the low 7 bits x 50 rpm', () => {
    expect(fanRpm(0x80 | 30)).toBe(1500);
    expect(fanRpm(0x80)).toBe(0);
    expect(fanRpm(0xff)).toBe(127 * 50);
    expect(fanRpm(30)).toBeNull();
  });
  it('smoke: bit7 valid, bit0 alarm', () => {
    expect(smokeAlarm(0x81)).toBe(true);
    expect(smokeAlarm(0x80)).toBe(false);
    expect(smokeAlarm(0x01)).toBeNull();
  });
});

describe('units: gamma register byte', () => {
  it('decodes plain values', () => {
    expect(decodeGamma(28)).toEqual({ kind: 'value', value: 2.8 });
    expect(decodeGamma(22)).toEqual({ kind: 'value', value: 2.2 });
    expect(decodeGamma(10)).toEqual({ kind: 'value', value: 1 });
    expect(decodeGamma(40)).toEqual({ kind: 'value', value: 4 });
  });
  it('bit6 adds 0.05 (0x40 | 23 = 2.35)', () => {
    expect(decodeGamma(0x40 | 23)).toEqual({ kind: 'value', value: 2.35 });
    expect(decodeGamma(0x40 | 28)).toEqual({ kind: 'value', value: 2.85 });
  });
  it('0xFE is the custom table, 0xFF is the default 2.8', () => {
    expect(decodeGamma(0xfe)).toEqual({ kind: 'custom' });
    expect(decodeGamma(0xff)).toEqual({ kind: 'value', value: GAMMA_DEFAULT });
  });
  it('values above 4.0 are coerced to 2.8', () => {
    expect(decodeGamma(41)).toEqual({ kind: 'value', value: 2.8 });
    expect(decodeGamma(63)).toEqual({ kind: 'value', value: 2.8 });
    expect(decodeGamma(0x40 | 40)).toEqual({ kind: 'value', value: 2.8 }); // 4.05
  });
  it('encodeGamma round-trips every representable value', () => {
    expect(encodeGamma(2.8)).toBe(28);
    expect(encodeGamma(2.35)).toBe(0x40 | 23);
    expect(encodeGamma(4)).toBe(40);
    expect(encodeGamma(0)).toBe(0);
    for (let hundredths = 0; hundredths <= 400; hundredths += 5) {
      const g = hundredths / 100;
      const byte = encodeGamma(g);
      expect(byte).not.toBeNull();
      expect(decodeGamma(byte!)).toEqual({ kind: 'value', value: g });
    }
  });
  it('encodeGamma rejects what the register cannot hold', () => {
    expect(encodeGamma(2.83)).toBeNull();
    expect(encodeGamma(4.05)).toBeNull();
    expect(encodeGamma(-0.1)).toBeNull();
    expect(encodeGamma(Number.NaN)).toBeNull();
  });
});
