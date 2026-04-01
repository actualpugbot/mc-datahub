import { inflateSync } from "node:zlib";

export type RgbColor = [number, number, number];

export interface DecodedPng {
  width: number;
  height: number;
  pixels: RgbColor[];
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
