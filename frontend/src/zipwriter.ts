/**
 * A streaming, store-only ZIP writer with zip64 support.
 *
 * Written by hand rather than pulled from a library because the obvious
 * candidate (fflate) emits only 32-bit sizes and offsets, which silently
 * corrupts any archive at or past 4 GiB — and a folder of media is exactly the
 * case this needs to handle.
 *
 * Nothing is compressed. The bytes come off a remote already encoded, so
 * deflating them on the main thread would cost time for no size saving; every
 * entry is stored (method 0).
 *
 * Sizes are not known until an entry has been read, so each entry sets the
 * data-descriptor flag and writes its CRC and sizes in a trailing descriptor.
 * An entry expected to exceed 4 GiB carries a zip64 extra field in its local
 * header, which is what tells a reader its descriptor holds 8-byte sizes.
 *
 * This module is deliberately free of DOM APIs beyond ReadableStream, so the
 * archive format can be exercised directly in tests.
 */

const LOCAL_SIG = 0x04034b50;
const DESCRIPTOR_SIG = 0x08074b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;

/** Sentinel written into a 32-bit field whose real value lives in a zip64 record. */
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

/** Zip64 applies from this size up; below it the plain 32-bit records are used. */
export const ZIP64_THRESHOLD = U32_MAX;

const VERSION_STORE = 20;
const VERSION_ZIP64 = 45;

/** Data descriptor present: sizes and CRC follow the entry rather than precede it. */
const FLAG_DESCRIPTOR = 0x0008;
/** Names and comments are UTF-8. Set only where it is needed, so ASCII names stay maximally portable. */
const FLAG_UTF8 = 0x0800;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** Running CRC-32, fed a chunk at a time as an entry streams past. */
class Crc32 {
  private state = 0xffffffff;

  update(bytes: Uint8Array): void {
    let c = this.state;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    this.state = c;
  }

  get value(): number {
    return (this.state ^ 0xffffffff) >>> 0;
  }
}

/** Fixed-size little-endian record builder. */
class Record {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private pos = 0;

  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }

  u16(value: number): this {
    this.view.setUint16(this.pos, value & U16_MAX, true);
    this.pos += 2;
    return this;
  }

  u32(value: number): this {
    this.view.setUint32(this.pos, value >>> 0, true);
    this.pos += 4;
    return this;
  }

  u64(value: number): this {
    this.view.setBigUint64(this.pos, BigInt(value), true);
    this.pos += 8;
    return this;
  }

  raw(value: Uint8Array): this {
    this.bytes.set(value, this.pos);
    this.pos += value.length;
    return this;
  }

  build(): Uint8Array {
    if (this.pos !== this.bytes.length) {
      throw new Error(`zip record is ${this.pos} bytes, expected ${this.bytes.length}`);
    }
    return this.bytes;
  }
}

/** MS-DOS packed date and time, which is all a ZIP header has room for. */
function dosDateTime(when: Date): { time: number; date: number } {
  // The format cannot represent anything before 1980.
  const year = Math.max(1980, when.getFullYear());
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

const utf8 = new TextEncoder();

/** Where an entry ended up, kept until the central directory is written. */
interface CentralEntry {
  name: Uint8Array;
  utf8Flag: boolean;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
  zip64: boolean;
  directory: boolean;
}

/** Somewhere to put the archive: a file on disk, or memory. */
export interface ZipSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export class ZipWriter {
  private offset = 0;
  private readonly entries: CentralEntry[] = [];
  private readonly names = new Set<string>();
  private readonly sink: ZipSink;

  constructor(sink: ZipSink) {
    this.sink = sink;
  }

  private async put(chunk: Uint8Array): Promise<void> {
    await this.sink.write(chunk);
    this.offset += chunk.length;
  }

  /**
   * Make a name unique within the archive. Two selected folders can easily
   * contain the same relative path, and a duplicate entry would leave one of
   * them unextractable.
   */
  private uniqueName(name: string): string {
    if (!this.names.has(name)) {
      this.names.add(name);
      return name;
    }
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let n = 2; ; n++) {
      const candidate = `${stem} (${n})${ext}`;
      if (!this.names.has(candidate)) {
        this.names.add(candidate);
        return candidate;
      }
    }
  }

  private localHeader(entry: {
    name: Uint8Array; utf8Flag: boolean; zip64: boolean; time: number; date: number;
  }): Uint8Array {
    // A zip64 extra field in the local header is what signals that this entry's
    // data descriptor carries 8-byte sizes.
    const extraLength = entry.zip64 ? 20 : 0;
    const record = new Record(30 + entry.name.length + extraLength);
    record
      .u32(LOCAL_SIG)
      .u16(entry.zip64 ? VERSION_ZIP64 : VERSION_STORE)
      .u16(FLAG_DESCRIPTOR | (entry.utf8Flag ? FLAG_UTF8 : 0))
      .u16(0) // stored
      .u16(entry.time)
      .u16(entry.date)
      .u32(0) // crc, in the descriptor
      .u32(0) // compressed size, in the descriptor
      .u32(0) // uncompressed size, in the descriptor
      .u16(entry.name.length)
      .u16(extraLength)
      .raw(entry.name);
    if (entry.zip64) {
      record.u16(0x0001).u16(16).u64(0).u64(0);
    }
    return record.build();
  }

  private dataDescriptor(crc: number, size: number, zip64: boolean): Uint8Array {
    const record = new Record(zip64 ? 24 : 16);
    record.u32(DESCRIPTOR_SIG).u32(crc);
    if (zip64) record.u64(size).u64(size);
    else record.u32(size).u32(size);
    return record.build();
  }

  /**
   * Append one entry, streaming `body` straight through. `expectedSize` decides
   * up front whether the entry is written as zip64, since that has to be
   * committed to in the local header before any bytes are read.
   */
  async add(
    name: string,
    expectedSize: number,
    body: ReadableStream<Uint8Array>,
    onChunk?: (bytes: number) => void,
    modified?: Date,
  ): Promise<void> {
    const entryName = this.uniqueName(name);
    const encoded = utf8.encode(entryName);
    // A leading slash or a drive-style name would make the entry unextractable
    // (or, worse, extractable outside the target directory).
    if (entryName.startsWith('/') || entryName.includes('..')) {
      throw new Error(`Unsafe archive entry name: ${entryName}`);
    }
    const utf8Flag = encoded.length !== entryName.length;
    // A backend that reports an unknown size gets zip64 too: a 32-bit entry
    // could not be corrected once its header was written.
    const zip64 = expectedSize < 0 || expectedSize >= ZIP64_THRESHOLD;
    // Keep each file's own timestamp; falling back to now only when the
    // backend did not report a usable one.
    const stamp = modified && !Number.isNaN(modified.getTime()) ? modified : new Date();
    const { time, date } = dosDateTime(stamp);
    const offset = this.offset;

    await this.put(this.localHeader({ name: encoded, utf8Flag, zip64, time, date }));

    const crc = new Crc32();
    let size = 0;
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        crc.update(value);
        size += value.length;
        // The entry committed to 32-bit sizes; a file that grew on the remote
        // since it was listed must fail loudly rather than corrupt the archive.
        if (!zip64 && size >= ZIP64_THRESHOLD) {
          throw new Error(`${entryName} is larger than it was listed as (over 4 GiB)`);
        }
        await this.put(value);
        onChunk?.(value.length);
      }
    } finally {
      reader.releaseLock();
    }

    await this.put(this.dataDescriptor(crc.value, size, zip64));

    this.entries.push({
      name: encoded, utf8Flag, crc: crc.value, size, offset, time, date, zip64,
      directory: entryName.endsWith('/'),
    });
  }

  /** Record an empty directory, so a folder with no files in it still survives. */
  async addDirectory(name: string): Promise<void> {
    const withSlash = name.endsWith('/') ? name : `${name}/`;
    await this.add(withSlash, 0, new ReadableStream({ start: c => c.close() }));
  }

  private centralHeader(entry: CentralEntry): Uint8Array {
    // A zip64 extra is needed here if either the size or the local header's
    // offset is too large for its 32-bit slot.
    const bigSize = entry.size >= ZIP64_THRESHOLD;
    const bigOffset = entry.offset >= ZIP64_THRESHOLD;
    const extraLength = bigSize ? (bigOffset ? 28 : 20) : bigOffset ? 12 : 0;
    const record = new Record(46 + entry.name.length + extraLength);
    record
      .u32(CENTRAL_SIG)
      .u16(VERSION_ZIP64) // made by
      .u16(entry.zip64 || bigOffset ? VERSION_ZIP64 : VERSION_STORE)
      .u16(FLAG_DESCRIPTOR | (entry.utf8Flag ? FLAG_UTF8 : 0))
      .u16(0) // stored
      .u16(entry.time)
      .u16(entry.date)
      .u32(entry.crc)
      .u32(bigSize ? U32_MAX : entry.size)
      .u32(bigSize ? U32_MAX : entry.size)
      .u16(entry.name.length)
      .u16(extraLength)
      .u16(0) // comment length
      .u16(0) // disk number
      .u16(0) // internal attributes
      // Unix mode in the high half: 0755 for a directory, 0644 for a file.
      .u32(entry.directory ? 0x41ed0010 : 0x81a40000)
      .u32(bigOffset ? U32_MAX : entry.offset)
      .raw(entry.name);

    if (extraLength > 0) {
      record.u16(0x0001).u16(extraLength - 4);
      // Order is fixed by the spec: sizes first, then the offset.
      if (bigSize) record.u64(entry.size).u64(entry.size);
      if (bigOffset) record.u64(entry.offset);
    }
    return record.build();
  }

  /** Write the central directory and the trailers, then close the sink. */
  async finish(): Promise<void> {
    const centralStart = this.offset;
    for (const entry of this.entries) {
      await this.put(this.centralHeader(entry));
    }
    const centralSize = this.offset - centralStart;
    const count = this.entries.length;

    // The trailers only need their zip64 form when one of their own fields
    // would overflow — not merely because some entry used zip64.
    const needsZip64 =
      count > U16_MAX || centralStart >= ZIP64_THRESHOLD || centralSize >= ZIP64_THRESHOLD;

    if (needsZip64) {
      const eocd64Offset = this.offset;
      await this.put(
        new Record(56)
          .u32(ZIP64_EOCD_SIG)
          .u64(44) // size of this record, less its first 12 bytes
          .u16(VERSION_ZIP64) // made by
          .u16(VERSION_ZIP64) // needed
          .u32(0) // this disk
          .u32(0) // disk with the central directory
          .u64(count)
          .u64(count)
          .u64(centralSize)
          .u64(centralStart)
          .build(),
      );
      await this.put(
        new Record(20)
          .u32(ZIP64_LOCATOR_SIG)
          .u32(0)
          .u64(eocd64Offset)
          .u32(1)
          .build(),
      );
    }

    await this.put(
      new Record(22)
        .u32(EOCD_SIG)
        .u16(0)
        .u16(0)
        .u16(needsZip64 ? U16_MAX : count)
        .u16(needsZip64 ? U16_MAX : count)
        .u32(needsZip64 ? U32_MAX : centralSize)
        .u32(needsZip64 ? U32_MAX : centralStart)
        .u16(0)
        .build(),
    );

    await this.sink.close();
  }
}
