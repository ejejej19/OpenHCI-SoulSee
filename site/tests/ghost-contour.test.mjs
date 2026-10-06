import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// 測試環境沒有 ImageData,補一個等價實作
if (typeof globalThis.ImageData === "undefined") {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

const { contourImageData, expressionRegionFromPose } = await import("../public/ghost-contour.js");

function solidImage(width, height, fill = 0) {
  const data = new Uint8ClampedArray(width * height * 4).fill(fill);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width, height, data };
}

function withRect(image, x0, y0, x1, y1, value = 255) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * image.width + x) * 4;
      image.data[p] = image.data[p + 1] = image.data[p + 2] = value;
    }
  }
  return image;
}

function opaquePixels(imageData) {
  let count = 0;
  for (let i = 3; i < imageData.data.length; i += 4) if (imageData.data[i] > 0) count++;
  return count;
}

test("draws lines where contrast changes and leaves flat areas empty", () => {
  const flat = contourImageData(solidImage(32, 32, 120));
  assert.equal(opaquePixels(flat), 0);

  const edged = contourImageData(withRect(solidImage(32, 32, 0), 8, 8, 24, 24));
  assert.ok(opaquePixels(edged) > 0);
});

test("edge lines are white and traced near the shape boundary", () => {
  const result = contourImageData(withRect(solidImage(32, 32, 0), 8, 8, 24, 24));
  let insideDeep = 0;
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const p = (y * 32 + x) * 4;
      if (result.data[p + 3] === 0) continue;
      assert.equal(result.data[p], 255);
      assert.equal(result.data[p + 1], 255);
      assert.equal(result.data[p + 2], 255);
      // 形狀正中央應該是平坦區,不該出現線
      if (x > 12 && x < 20 && y > 12 && y < 20) insideDeep++;
    }
  }
  assert.equal(insideDeep, 0);
});

test("threshold controls how much detail survives", () => {
  const image = withRect(solidImage(32, 32, 0), 8, 8, 24, 24);
  const loose = opaquePixels(contourImageData(image, { threshold: 5 }));
  const strict = opaquePixels(contourImageData(image, { threshold: 200 }));
  assert.ok(loose > strict);
});

test("face and body contour modes partition the original contour", () => {
  const image = withRect(
    withRect(solidImage(64, 64, 0), 25, 18, 39, 32),
    5, 45, 17, 57,
  );
  const expressionRegion = { centerX: 32, centerY: 25, radiusX: 13, radiusY: 13 };
  const full = contourImageData(image);
  const face = contourImageData(image, { region: "face", expressionRegion });
  const body = contourImageData(image, { region: "body", expressionRegion });

  assert.ok(opaquePixels(face) > 0);
  assert.ok(opaquePixels(body) > 0);
  for (let i = 3; i < full.data.length; i += 4) {
    assert.equal(face.data[i] + body.data[i], full.data[i]);
  }
  assert.deepEqual(
    [...contourImageData(image, { region: "all", expressionRegion }).data],
    [...full.data],
  );
});

test("expression region follows visible face landmarks and rejects missing faces", () => {
  const points = Array(33).fill(null);
  const set = (index, x, y) => { points[index] = { x, y, visibility: 1 }; };
  set(0, 100, 80);
  set(1, 92, 72); set(2, 94, 71); set(3, 88, 72);
  set(4, 108, 72); set(5, 106, 71); set(6, 112, 72);
  set(7, 78, 80); set(8, 122, 80);
  set(9, 94, 94); set(10, 106, 94);
  set(11, 65, 130); set(12, 135, 130);

  const region = expressionRegionFromPose(points);
  assert.ok(region);
  assert.ok(region.centerX > 95 && region.centerX < 105);
  assert.ok(region.centerY > 78 && region.centerY < 90);
  assert.ok(region.radiusX > 12);
  assert.ok(region.radiusY > region.radiusX);
  assert.equal(expressionRegionFromPose(Array(33).fill(null)), null);
});

test("cuts and play keep every original ghost mode and add both contour modes", async () => {
  const [cuts, play, engine] = await Promise.all([
    readFile(new URL("../public/cuts.html", import.meta.url), "utf8"),
    readFile(new URL("../public/play.html", import.meta.url), "utf8"),
    readFile(new URL("../public/photobooth-engine.js", import.meta.url), "utf8"),
  ]);
  const expected = [
    ["contour", "描邊"],
    ["face-contour", "只有表情描邊"],
    ["body-contour", "只有肢體輪廓沒有表情"],
    ["stick", "火柴人"],
    ["hybrid", "照片+骨架"],
    ["photo", "照片"],
  ];
  for (const html of [cuts, play]) {
    const formSelect = html.match(/<select id="formSelect"[\s\S]*?<\/select>/)?.[0] || "";
    assert.equal((formSelect.match(/<option\b/g) || []).length, expected.length);
    for (const [value, label] of expected) {
      const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.match(formSelect, new RegExp(`<option value="${value}"[^>]*>${escapedLabel}<\\/option>`));
    }
  }
  assert.match(engine, /'face-contour': '只有表情描邊'/);
  assert.match(engine, /'body-contour': '只有肢體輪廓沒有表情'/);
});

test("returns null for empty dimensions", () => {
  assert.equal(contourImageData({ width: 0, height: 0, data: new Uint8ClampedArray() }), null);
});
