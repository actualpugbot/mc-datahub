import { gunzipSync } from "node:zlib";

/**
 * Minimal NBT (Named Binary Tag) reader for vanilla structure template files
 * (`data/minecraft/structure/**.nbt`). Parses straight to plain JS values:
 * compounds become records, lists become arrays, numeric tags become numbers.
 * Longs are converted through `Number` (template files never carry longs that
 * exceed the safe-integer range; DataVersion and positions are plain ints).
 */

const TAG_END = 0;
const TAG_BYTE = 1;
const TAG_SHORT = 2;
const TAG_INT = 3;
const TAG_LONG = 4;
const TAG_FLOAT = 5;
const TAG_DOUBLE = 6;
const TAG_BYTE_ARRAY = 7;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;
const TAG_INT_ARRAY = 11;
const TAG_LONG_ARRAY = 12;

export type NbtCompound = { [key: string]: unknown };

/** Decode a (possibly gzip-compressed) NBT buffer into its root compound. */
export function decodeNbt(buffer: Buffer): NbtCompound {
  const data = isGzip(buffer) ? gunzipSync(buffer) : buffer;
  const reader = new NbtReader(data);
  const rootType = reader.readByte();
  if (rootType !== TAG_COMPOUND) {
    throw new Error(`Expected a compound NBT root tag but found tag type ${rootType}.`);
  }

  reader.readString(); // Root tag name (empty for vanilla templates).
  return reader.readCompound();
}

function isGzip(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

class NbtReader {
  private offset = 0;

  constructor(private readonly data: Buffer) {}

  readByte(): number {
    const value = this.data.readInt8(this.offset);
    this.offset += 1;
    return value;
  }

  readCompound(): NbtCompound {
    const compound: NbtCompound = {};
    for (;;) {
      const type = this.readByte();
      if (type === TAG_END) {
        return compound;
      }

      const name = this.readString();
      compound[name] = this.readPayload(type);
    }
  }

  readString(): string {
    const length = this.data.readUInt16BE(this.offset);
    this.offset += 2;
    const value = this.data.toString("utf8", this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  private readPayload(type: number): unknown {
    switch (type) {
      case TAG_BYTE:
        return this.readByte();
      case TAG_SHORT: {
        const value = this.data.readInt16BE(this.offset);
        this.offset += 2;
        return value;
      }
      case TAG_INT:
        return this.readInt();
      case TAG_LONG: {
        const value = Number(this.data.readBigInt64BE(this.offset));
        this.offset += 8;
        return value;
      }
      case TAG_FLOAT: {
        const value = this.data.readFloatBE(this.offset);
        this.offset += 4;
        return value;
      }
      case TAG_DOUBLE: {
        const value = this.data.readDoubleBE(this.offset);
        this.offset += 8;
        return value;
      }
      case TAG_BYTE_ARRAY: {
        const length = this.readInt();
        const values: number[] = new Array(length);
        for (let index = 0; index < length; index += 1) {
          values[index] = this.readByte();
        }
        return values;
      }
      case TAG_STRING:
        return this.readString();
      case TAG_LIST: {
        const elementType = this.readByte();
        const length = this.readInt();
        const values: unknown[] = new Array(length);
        for (let index = 0; index < length; index += 1) {
          values[index] = this.readPayload(elementType);
        }
        return values;
      }
      case TAG_COMPOUND:
        return this.readCompound();
      case TAG_INT_ARRAY: {
        const length = this.readInt();
        const values: number[] = new Array(length);
        for (let index = 0; index < length; index += 1) {
          values[index] = this.readInt();
        }
        return values;
      }
      case TAG_LONG_ARRAY: {
        const length = this.readInt();
        const values: number[] = new Array(length);
        for (let index = 0; index < length; index += 1) {
          values[index] = Number(this.data.readBigInt64BE(this.offset));
          this.offset += 8;
        }
        return values;
      }
      default:
        throw new Error(`Unsupported NBT tag type ${type} at offset ${this.offset}.`);
    }
  }

  private readInt(): number {
    const value = this.data.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }
}
