/**
 * A most-significant-bit-first bit writer, and the two CRCs FLAC checks with.
 *
 * FLAC is a bitstream, not a byte stream: a subframe can start and end
 * anywhere inside a byte, and everything is written from the top of the byte
 * down. Getting that order wrong produces a file that looks plausible and
 * decodes to noise, so it lives in one small piece of code with its own
 * tests rather than being open-coded at each call site.
 */
export class BitWriter {
  private bytes: number[] = [];
  /** Bits not yet flushed, held in the low end of `partial`. */
  private partial = 0;
  private partialBits = 0;

  /** Write the low `count` bits of `value`, most significant first. */
  write(value: number, count: number): void {
    for (let i = count - 1; i >= 0; i -= 1) {
      // Arithmetic rather than `>>` so a count above 31 stays correct.
      const bit = Math.floor(value / 2 ** i) & 1;
      this.partial = (this.partial << 1) | bit;
      this.partialBits += 1;
      if (this.partialBits === 8) {
        this.bytes.push(this.partial & 0xff);
        this.partial = 0;
        this.partialBits = 0;
      }
    }
  }

  /** A signed value in `count` bits, two's complement. */
  writeSigned(value: number, count: number): void {
    const modulus = 2 ** count;
    this.write(value < 0 ? value + modulus : value, count);
  }

  /** `value` zero bits then a one, which is how FLAC spells a Rice quotient. */
  writeUnary(value: number): void {
    for (let i = 0; i < value; i += 1) this.write(0, 1);
    this.write(1, 1);
  }

  /** Zero-fill to the next byte boundary. FLAC pads every frame this way. */
  align(): void {
    if (this.partialBits > 0) this.write(0, 8 - this.partialBits);
  }

  get bitLength(): number {
    return this.bytes.length * 8 + this.partialBits;
  }

  /** The bytes so far. Only valid on a byte boundary, so it aligns first. */
  toBytes(): Uint8Array {
    this.align();
    return Uint8Array.from(this.bytes);
  }
}

const CRC8 = (() => {
  // x^8 + x^2 + x + 1
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    table[i] = crc;
  }
  return table;
})();

export function crc8(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) crc = CRC8[crc ^ byte]!;
  return crc;
}

const CRC16 = (() => {
  // x^16 + x^15 + x^2 + 1
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
    table[i] = crc;
  }
  return table;
})();

export function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) crc = ((crc << 8) ^ CRC16[((crc >> 8) ^ byte) & 0xff]!) & 0xffff;
  return crc;
}

/**
 * The frame number, in FLAC's UTF-8-shaped integer encoding.
 *
 * It is UTF-8's byte layout used for a number rather than a code point, and
 * it goes up to 36 bits, which is why it is written out here instead of
 * handed to a text encoder.
 */
export function writeUtf8Number(writer: BitWriter, value: number): void {
  if (value < 0x80) {
    writer.write(value, 8);
    return;
  }
  const ranges: Array<{ limit: number; bytes: number; lead: number; leadBits: number }> = [
    { limit: 0x800, bytes: 2, lead: 0xc0, leadBits: 5 },
    { limit: 0x10000, bytes: 3, lead: 0xe0, leadBits: 4 },
    { limit: 0x200000, bytes: 4, lead: 0xf0, leadBits: 3 },
    { limit: 0x4000000, bytes: 5, lead: 0xf8, leadBits: 2 },
    { limit: 0x80000000, bytes: 6, lead: 0xfc, leadBits: 1 },
    { limit: 2 ** 36, bytes: 7, lead: 0xfe, leadBits: 0 },
  ];
  const range = ranges.find((r) => value < r.limit);
  if (!range) throw new RangeError(`frame number ${value} is beyond what FLAC can address`);
  const continuations = range.bytes - 1;
  writer.write(range.lead | Math.floor(value / 2 ** (6 * continuations)), 8);
  for (let i = continuations - 1; i >= 0; i -= 1) {
    writer.write(0x80 | (Math.floor(value / 2 ** (6 * i)) & 0x3f), 8);
  }
}
