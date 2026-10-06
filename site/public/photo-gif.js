const GIF_COLOR_COUNT = 256;
const HISTOGRAM_SIZE = 32 * 32 * 32;

function normalizeFrames(frames, width, height) {
  if (!Array.isArray(frames) || frames.length < 2) {
    throw new Error('動態 GIF 至少需要兩張照片');
  }
  const expectedLength = width * height * 4;
  return frames.map(frame => {
    const pixels = frame?.data || frame;
    if (!ArrayBuffer.isView(pixels) || pixels.length !== expectedLength) {
      throw new Error('GIF 畫格尺寸不一致');
    }
    return pixels;
  });
}

function makeColorBox(colors) {
  let population = 0;
  let minR = 255, minG = 255, minB = 255;
  let maxR = 0, maxG = 0, maxB = 0;
  for (const color of colors) {
    population += color.count;
    minR = Math.min(minR, color.r);
    minG = Math.min(minG, color.g);
    minB = Math.min(minB, color.b);
    maxR = Math.max(maxR, color.r);
    maxG = Math.max(maxG, color.g);
    maxB = Math.max(maxB, color.b);
  }
  const ranges = [maxR - minR, maxG - minG, maxB - minB];
  return {
    colors,
    population,
    ranges,
    score: population * (Math.max(...ranges) + 1),
  };
}

function splitColorBox(box) {
  const channel = box.ranges.indexOf(Math.max(...box.ranges));
  const property = ['r', 'g', 'b'][channel];
  const sorted = box.colors.slice().sort((a, b) => a[property] - b[property]);
  const midpoint = box.population / 2;
  let population = 0;
  let splitAt = sorted.length - 1;
  for (let index = 0; index < sorted.length - 1; index += 1) {
    population += sorted[index].count;
    if (population >= midpoint) {
      splitAt = index + 1;
      break;
    }
  }
  return [makeColorBox(sorted.slice(0, splitAt)), makeColorBox(sorted.slice(splitAt))];
}

function quantizeFrames(frames) {
  const counts = new Uint32Array(HISTOGRAM_SIZE);
  const sumsR = new Uint32Array(HISTOGRAM_SIZE);
  const sumsG = new Uint32Array(HISTOGRAM_SIZE);
  const sumsB = new Uint32Array(HISTOGRAM_SIZE);

  for (const pixels of frames) {
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const r = pixels[offset];
      const g = pixels[offset + 1];
      const b = pixels[offset + 2];
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      counts[key] += 1;
      sumsR[key] += r;
      sumsG[key] += g;
      sumsB[key] += b;
    }
  }

  const colors = [];
  for (let key = 0; key < HISTOGRAM_SIZE; key += 1) {
    const count = counts[key];
    if (!count) continue;
    colors.push({
      key,
      count,
      sumR: sumsR[key],
      sumG: sumsG[key],
      sumB: sumsB[key],
      r: sumsR[key] / count,
      g: sumsG[key] / count,
      b: sumsB[key] / count,
    });
  }

  const boxes = [makeColorBox(colors)];
  while (boxes.length < GIF_COLOR_COUNT) {
    let selected = -1;
    for (let index = 0; index < boxes.length; index += 1) {
      if (boxes[index].colors.length < 2) continue;
      if (selected < 0 || boxes[index].score > boxes[selected].score) selected = index;
    }
    if (selected < 0) break;
    const [first, second] = splitColorBox(boxes[selected]);
    boxes.splice(selected, 1, first, second);
  }

  const palette = new Uint8Array(GIF_COLOR_COUNT * 3);
  const lookup = new Uint8Array(HISTOGRAM_SIZE);
  boxes.forEach((box, paletteIndex) => {
    let population = 0, sumR = 0, sumG = 0, sumB = 0;
    for (const color of box.colors) {
      population += color.count;
      sumR += color.sumR;
      sumG += color.sumG;
      sumB += color.sumB;
      lookup[color.key] = paletteIndex;
    }
    const paletteOffset = paletteIndex * 3;
    palette[paletteOffset] = Math.round(sumR / population);
    palette[paletteOffset + 1] = Math.round(sumG / population);
    palette[paletteOffset + 2] = Math.round(sumB / population);
  });

  const indexedFrames = frames.map(pixels => {
    const indexed = new Uint8Array(pixels.length / 4);
    for (let offset = 0, pixel = 0; offset < pixels.length; offset += 4, pixel += 1) {
      const key = ((pixels[offset] >> 3) << 10)
        | ((pixels[offset + 1] >> 3) << 5)
        | (pixels[offset + 2] >> 3);
      indexed[pixel] = lookup[key];
    }
    return indexed;
  });

  return { palette, indexedFrames };
}

function writeCodeStream(indices) {
  const bytes = [];
  let bitBuffer = 0;
  let bitCount = 0;
  const writeCode = code => {
    bitBuffer |= code << bitCount;
    bitCount += 9;
    while (bitCount >= 8) {
      bytes.push(bitBuffer & 0xff);
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  };

  const clearCode = 256;
  const endCode = 257;
  writeCode(clearCode);
  let literalsSinceClear = 0;
  for (const index of indices) {
    // Clearing before literal 255 keeps the decoder's dictionary below the
    // 10-bit boundary, so this deliberately simple stream stays 9-bit.
    if (literalsSinceClear === 254) {
      writeCode(clearCode);
      literalsSinceClear = 0;
    }
    writeCode(index);
    literalsSinceClear += 1;
  }
  writeCode(endCode);
  if (bitCount) bytes.push(bitBuffer & 0xff);
  return bytes;
}

function encodeGif(indexedFrames, palette, { width, height, delayMs, loop }) {
  const bytes = [];
  const writeByte = value => bytes.push(value & 0xff);
  const writeUint16 = value => {
    writeByte(value);
    writeByte(value >> 8);
  };
  const writeString = value => {
    for (let index = 0; index < value.length; index += 1) writeByte(value.charCodeAt(index));
  };

  writeString('GIF89a');
  writeUint16(width);
  writeUint16(height);
  writeByte(0xf7); // Global 256-color table, 8-bit color resolution.
  writeByte(0);
  writeByte(0);
  for (const channel of palette) writeByte(channel);

  writeByte(0x21);
  writeByte(0xff);
  writeByte(0x0b);
  writeString('NETSCAPE2.0');
  writeByte(0x03);
  writeByte(0x01);
  writeUint16(loop);
  writeByte(0x00);

  const delayCentiseconds = Math.max(0, Math.min(0xffff, Math.round(delayMs / 10)));
  for (const frame of indexedFrames) {
    writeByte(0x21);
    writeByte(0xf9);
    writeByte(0x04);
    writeByte(0x04); // Keep this frame until the next full-canvas frame.
    writeUint16(delayCentiseconds);
    writeByte(0x00);
    writeByte(0x00);

    writeByte(0x2c);
    writeUint16(0);
    writeUint16(0);
    writeUint16(width);
    writeUint16(height);
    writeByte(0x00);
    writeByte(0x08);

    const compressed = writeCodeStream(frame);
    for (let offset = 0; offset < compressed.length; offset += 255) {
      const length = Math.min(255, compressed.length - offset);
      writeByte(length);
      for (let index = 0; index < length; index += 1) writeByte(compressed[offset + index]);
    }
    writeByte(0x00);
  }

  writeByte(0x3b);
  return Uint8Array.from(bytes);
}

export function encodePhotoGif(rawFrames, {
  width = 640,
  height = 480,
  delayMs = 900,
  loop = 0,
} = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 0xffff || height > 0xffff) {
    throw new Error('GIF 畫布尺寸無效');
  }
  const frames = normalizeFrames(rawFrames, width, height);
  const { palette, indexedFrames } = quantizeFrames(frames);
  const bytes = encodeGif(indexedFrames, palette, { width, height, delayMs, loop });
  return new Blob([bytes], { type: 'image/gif' });
}
