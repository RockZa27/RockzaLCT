import { describe, expect, it } from 'vitest';
import { receiverModelName } from '@rockzalct/shared';

describe('receiverModelName', () => {
  it('names a known id, listing every card that shares it', () => {
    // 0x4817 is what the user's Taurus T40 reported; NovaLCT lists eight cards under it
    const name = receiverModelName(0x4817);
    expect(name.split(' / ')).toEqual(expect.arrayContaining(['NV7516', 'NV7520', 'MRV532']));
    expect(receiverModelName(17797)).toBe('A8');
  });

  it('falls back to the hex id for an unknown model', () => {
    expect(receiverModelName(0x0001)).toBe('Unknown (0x0001)');
  });
});
