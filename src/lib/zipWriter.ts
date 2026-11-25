/**
 * Minimal streaming ZIP writer (store-only, no compression).
 *
 * Photos are JPEG/WebP/PNG, which are already compressed, so "store" keeps the
 * originals byte-for-byte and costs no CPU. Each file is passed in whole (one
 * photo at a time, a few MB), so its size and CRC are known before its header is
 * written and no data descriptors are needed. Output is emitted chunk by chunk
 * through a sink, so nothing larger than one photo has to sit in memory.
 *
 * ZIP64 records are written only when needed (archive over 4 GB or 65,535+
 * files), so normal archives open everywhere.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;
const encoder = new TextEncoder();

interface CentralEntry {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  dosTime: number;
  dosDate: number;
}

function toDos(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export type ZipSink = (chunk: Uint8Array) => void | Promise<void>;

export class ZipWriter {
  private offset = 0;
  private entries: CentralEntry[] = [];

  constructor(private readonly sink: ZipSink) {}

  private async emit(chunk: Uint8Array) {
    await this.sink(chunk);
    this.offset += chunk.length;
  }

  async addFile(name: string, data: Uint8Array, modified: Date = new Date()): Promise<void> {
    if (data.length >= U32_MAX) throw new Error("File too large for ZIP entry");
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    const { dosTime, dosDate } = toDos(modified);
    const header = new Uint8Array(30 + nameBytes.length);
    const v = new DataView(header.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true); // version needed
    v.setUint16(6, 0x0800, true); // UTF-8 names
    v.setUint16(8, 0, true); // method: store
    v.setUint16(10, dosTime, true);
    v.setUint16(12, dosDate, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, data.length, true);
    v.setUint32(22, data.length, true);
    v.setUint16(26, nameBytes.length, true);
    v.setUint16(28, 0, true);
    header.set(nameBytes, 30);

    const offset = this.offset;
    await this.emit(header);
    await this.emit(data);
    this.entries.push({ name: nameBytes, crc, size: data.length, offset, dosTime, dosDate });
  }

  /** Writes the central directory. Call once, after the last file. */
  async finish(): Promise<void> {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const big = e.offset >= U32_MAX;
      const extraLen = big ? 12 : 0;
      const rec = new Uint8Array(46 + e.name.length + extraLen);
      const v = new DataView(rec.buffer);
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, big ? 45 : 20, true); // version made by
      v.setUint16(6, big ? 45 : 20, true); // version needed
      v.setUint16(8, 0x0800, true);
      v.setUint16(10, 0, true);
      v.setUint16(12, e.dosTime, true);
      v.setUint16(14, e.dosDate, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, e.size, true);
      v.setUint32(24, e.size, true);
      v.setUint16(28, e.name.length, true);
      v.setUint16(30, extraLen, true);
      v.setUint16(32, 0, true); // comment length
      v.setUint16(34, 0, true); // disk number
      v.setUint16(36, 0, true); // internal attrs
      v.setUint32(38, 0, true); // external attrs
      v.setUint32(42, big ? U32_MAX : e.offset, true);
      rec.set(e.name, 46);
      if (big) {
        const x = 46 + e.name.length;
        v.setUint16(x, 0x0001, true); // ZIP64 extra: only the offset is oversized
        v.setUint16(x + 2, 8, true);
        v.setBigUint64(x + 4, BigInt(e.offset), true);
      }
      await this.emit(rec);
    }
    const cdSize = this.offset - cdStart;
    const count = this.entries.length;
    const needZip64 = count >= U16_MAX || cdStart >= U32_MAX || cdSize >= U32_MAX;

    if (needZip64) {
      const z = new Uint8Array(56 + 20);
      const v = new DataView(z.buffer);
      const eocd64Offset = this.offset;
      v.setUint32(0, 0x06064b50, true);
      v.setBigUint64(4, 44n, true);
      v.setUint16(12, 45, true);
      v.setUint16(14, 45, true);
      v.setUint32(16, 0, true);
      v.setUint32(20, 0, true);
      v.setBigUint64(24, BigInt(count), true);
      v.setBigUint64(32, BigInt(count), true);
      v.setBigUint64(40, BigInt(cdSize), true);
      v.setBigUint64(48, BigInt(cdStart), true);
      v.setUint32(56, 0x07064b50, true);
      v.setUint32(60, 0, true);
      v.setBigUint64(64, BigInt(eocd64Offset), true);
      v.setUint32(72, 1, true);
      await this.emit(z);
    }

    const end = new Uint8Array(22);
    const v = new DataView(end.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(4, 0, true);
    v.setUint16(6, 0, true);
    v.setUint16(8, needZip64 ? U16_MAX : count, true);
    v.setUint16(10, needZip64 ? U16_MAX : count, true);
    v.setUint32(12, needZip64 ? U32_MAX : cdSize, true);
    v.setUint32(16, needZip64 ? U32_MAX : cdStart, true);
    v.setUint16(20, 0, true);
    await this.emit(end);
  }
}
