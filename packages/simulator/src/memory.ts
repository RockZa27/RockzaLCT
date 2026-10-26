/**
 * Sparse byte-addressable register memory for one device.
 * Unwritten addresses read as 0; writes persist.
 * Addresses are the 32-bit "register unit address" of the codec's Packet
 * (@novastar/codec src/Packet.ts, field `address`, UInt32LE).
 */
const PAGE_BITS = 12;
const PAGE_SIZE = 1 << PAGE_BITS;

export class DeviceMemory {
  private readonly pages = new Map<number, Uint8Array>();

  read(address: number, length: number): Buffer {
    const out = Buffer.alloc(length);
    for (let i = 0; i < length; ) {
      const abs = (address + i) >>> 0;
      const page = this.pages.get(abs >>> PAGE_BITS);
      const off = abs & (PAGE_SIZE - 1);
      const n = Math.min(length - i, PAGE_SIZE - off);
      if (page) out.set(page.subarray(off, off + n), i);
      i += n;
    }
    return out;
  }

  write(address: number, data: Uint8Array): void {
    for (let i = 0; i < data.length; ) {
      const abs = (address + i) >>> 0;
      const key = abs >>> PAGE_BITS;
      let page = this.pages.get(key);
      if (!page) {
        page = new Uint8Array(PAGE_SIZE);
        this.pages.set(key, page);
      }
      const off = abs & (PAGE_SIZE - 1);
      const n = Math.min(data.length - i, PAGE_SIZE - off);
      page.set(data.subarray(i, i + n), off);
      i += n;
    }
  }

  readU8(address: number): number {
    return this.read(address, 1).readUInt8(0);
  }

  writeU8(address: number, value: number): void {
    this.write(address, Buffer.from([value & 0xff]));
  }

  writeU16LE(address: number, value: number): void {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(value & 0xffff);
    this.write(address, b);
  }

  writeU32LE(address: number, value: number): void {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value >>> 0);
    this.write(address, b);
  }
}
