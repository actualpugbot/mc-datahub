import { deflateSync, inflateSync } from "node:zlib";

export type RgbColor = [number, number, number];

export interface DecodedPng {
  width: number;
  height: number;
  pixels: RgbColor[];
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC32_TABLE = buildCrc32Table();

export function encodePng(width: number, height: number, pixels: RgbColor[]): Buffer {
  if (pixels.length !== width * height) {
    throw new Error(`Expected ${width * height} pixels but received ${pixels.length}.`);
  }

  const raw = Buffer.alloc(height * (1 + width * 3));
  let rawOffset = 0;

  for (let y = 0; y < height; y += 1) {
    raw.writeUInt8(0, rawOffset);
    rawOffset += 1;

    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = pixels[y * width + x] ?? [0, 0, 0];
      raw.writeUInt8(clampColor(red), rawOffset);
      raw.writeUInt8(clampColor(green), rawOffset + 1);
      raw.writeUInt8(clampColor(blue), rawOffset + 2);
      rawOffset += 3;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(2, 9);
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  return Buffer.concat([
    PNG_SIGNATURE,
    createPngChunk("IHDR", ihdr),
    createPngChunk("IDAT", deflateSync(raw)),
    createPngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function decodePng(buffer: Buffer): DecodedPng {
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("Unsupported PNG signature.");
  }

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlaceMethod = 0;
  const idatChunks: Buffer[] = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    offset += 4;

    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    offset += 4;

    const chunkData = buffer.subarray(offset, offset + length);
    offset += length;
    offset += 4;

    if (type === "IHDR") {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData.readUInt8(8);
      colorType = chunkData.readUInt8(9);
      interlaceMethod = chunkData.readUInt8(12);
      continue;
    }

    if (type === "IDAT") {
      idatChunks.push(chunkData);
      continue;
    }

    if (type === "IEND") {
      break;
    }
  }

  if (bitDepth !== 8) {
    throw new Error(`Unsupported PNG bit depth ${bitDepth}; expected 8.`);
  }

  if (![0, 2, 6].includes(colorType)) {
    throw new Error(`Unsupported PNG color type ${colorType}; expected grayscale, RGB, or RGBA.`);
  }

  if (interlaceMethod !== 0) {
    throw new Error("Unsupported interlaced PNG.");
  }

  const bytesPerPixel = colorType === 0 ? 1 : colorType === 2 ? 3 : 4;
  const stride = width * bytesPerPixel;
  const raw = inflateSync(Buffer.concat(idatChunks));
  const pixels: RgbColor[] = [];
  let rawOffset = 0;
  let previousRow = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filterType = raw.readUInt8(rawOffset);
    rawOffset += 1;

    const row = Buffer.from(raw.subarray(rawOffset, rawOffset + stride));
    rawOffset += stride;
    applyPngFilter(row, previousRow, bytesPerPixel, filterType);

    for (let x = 0; x < width; x += 1) {
      const pixelOffset = x * bytesPerPixel;
      if (colorType === 0) {
        const value = row.readUInt8(pixelOffset);
        pixels.push([value, value, value]);
        continue;
      }

      pixels.push([
        row.readUInt8(pixelOffset),
        row.readUInt8(pixelOffset + 1),
        row.readUInt8(pixelOffset + 2),
      ]);
    }

    previousRow = row;
  }

  return {
    width,
    height,
    pixels,
  };
}

function clampColor(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function createPngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(calculateCrc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function applyPngFilter(row: Buffer, previousRow: Buffer, bytesPerPixel: number, filterType: number): void {
  if (filterType === 0) {
    return;
  }

  for (let index = 0; index < row.length; index += 1) {
    const left = index >= bytesPerPixel ? row.readUInt8(index - bytesPerPixel) : 0;
    const above = previousRow.readUInt8(index);
    const upperLeft = index >= bytesPerPixel ? previousRow.readUInt8(index - bytesPerPixel) : 0;
    const filtered = row.readUInt8(index);

    const restored =
      filterType === 1
        ? filtered + left
        : filterType === 2
          ? filtered + above
          : filterType === 3
            ? filtered + Math.floor((left + above) / 2)
            : filterType === 4
              ? filtered + paethPredictor(left, above, upperLeft)
              : Number.NaN;

    if (Number.isNaN(restored)) {
      throw new Error(`Unsupported PNG filter type ${filterType}.`);
    }

    row.writeUInt8(restored & 0xff, index);
  }
}

function paethPredictor(left: number, above: number, upperLeft: number): number {
  const prediction = left + above - upperLeft;
  const distanceLeft = Math.abs(prediction - left);
  const distanceAbove = Math.abs(prediction - above);
  const distanceUpperLeft = Math.abs(prediction - upperLeft);

  if (distanceLeft <= distanceAbove && distanceLeft <= distanceUpperLeft) {
    return left;
  }

  if (distanceAbove <= distanceUpperLeft) {
    return above;
  }

  return upperLeft;
}

function calculateCrc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const value of buffer) {
    crc = (CRC32_TABLE[(crc ^ value) & 0xff] ?? 0) ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }

    table[index] = crc >>> 0;
  }

  return table;
}
