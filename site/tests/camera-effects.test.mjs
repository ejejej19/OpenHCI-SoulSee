import test from "node:test";
import assert from "node:assert/strict";
import {
  EFFECT_PRESETS,
  FILTER_PRESETS,
  applyFilterToImageData,
  applyPreviewLook,
  cameraLookLabel,
  renderCameraFrame,
  resetLookAdjustments,
  resolveCameraLook,
} from "../public/camera-effects.js";

function fakeContext(pixelData = [240, 80, 20, 255, 20, 80, 240, 255]) {
  const calls = [];
  const imageData = { data: new Uint8ClampedArray(pixelData) };
  const gradients = [];
  return {
    calls,
    imageData,
    gradients,
    save() { calls.push(["save"]); },
    restore() { calls.push(["restore"]); },
    translate(x, y) { calls.push(["translate", x, y]); },
    scale(x, y) { calls.push(["scale", x, y]); },
    drawImage(...args) { calls.push(["drawImage", ...args]); },
    getImageData(...args) {
      calls.push(["getImageData", ...args]);
      return imageData;
    },
    putImageData(...args) { calls.push(["putImageData", ...args]); },
    createRadialGradient(...args) {
      calls.push(["createRadialGradient", ...args]);
      const gradient = {
        stops: [],
        addColorStop(offset, color) { this.stops.push([offset, color]); },
      };
      gradients.push(gradient);
      return gradient;
    },
    fillRect(...args) { calls.push(["fillRect", ...args]); },
  };
}

test("camera look presets expose stable identifiers and safe fallbacks", () => {
  assert.deepEqual(FILTER_PRESETS.map(preset => preset.id), [
    "original",
    "cream",
    "photogray",
    "peach",
    "matte-mono",
    "y2k",
    "vivid",
    "warm",
    "cool",
    "film",
    "mono",
  ]);
  assert.deepEqual(EFFECT_PRESETS.map(preset => preset.id), [
    "none",
    "vignette",
    "glow",
    "grain",
    "vhs",
    "neon",
  ]);
  assert.deepEqual(EFFECT_PRESETS.slice(-2).map(preset => preset.group), ["玩味", "玩味"]);
  assert.deepEqual(resolveCameraLook({ filter: "missing", effect: "missing" }), {
    filter: "original",
    effect: "none",
  });
});

test("resetting numeric adjustments preserves the selected filter and effect", () => {
  assert.deepEqual(resetLookAdjustments({
    filter: "film",
    effect: "grain",
    adjustments: { brightness: 1.2, contrast: 1.3, saturation: 0.7, temperature: 0.2 },
  }), {
    filter: "film",
    effect: "grain",
    adjustments: { brightness: 1, contrast: 1, saturation: 1, temperature: 0 },
  });
});

test("preview look applies the filter and effect without changing the video stream", () => {
  const video = { style: {} };
  const overlay = { dataset: {} };
  const resolved = applyPreviewLook(video, overlay, { filter: "vivid", effect: "grain" });

  assert.deepEqual(resolved, { filter: "vivid", effect: "grain" });
  assert.match(video.style.filter, /saturate\(1\.35\)/);
  assert.equal(overlay.dataset.effect, "grain");
  assert.equal(cameraLookLabel(resolved), "鮮明 / 顆粒");
});

test("pixel fallback produces real monochrome output without Canvas filter support", () => {
  const imageData = { data: new Uint8ClampedArray([240, 80, 20, 255]) };
  applyFilterToImageData(imageData, "mono");

  assert.equal(imageData.data[0], imageData.data[1]);
  assert.equal(imageData.data[1], imageData.data[2]);
  assert.equal(imageData.data[3], 255);
});

test("AI look adjustments affect both preview CSS and captured pixels", () => {
  const look = {
    filter: "original",
    effect: "none",
    adjustments: { brightness: 1.2, contrast: 1.1, saturation: 1.3, temperature: 0.2 },
  };
  const video = { style: {} };
  const overlay = { dataset: {} };
  const resolved = applyPreviewLook(video, overlay, look);

  assert.match(video.style.filter, /brightness\(1\.2\)/);
  assert.match(video.style.filter, /sepia\(/);
  assert.match(cameraLookLabel(resolved), /AI 色調/);

  const context = fakeContext([100, 100, 100, 255]);
  renderCameraFrame(context, {}, 1, 1, look);
  assert.ok(context.calls.some(call => call[0] === "getImageData"));
  assert.ok(context.imageData.data[0] > context.imageData.data[2]);
});

test("rendered front-camera frames mirror pixels and persist filter plus effect", () => {
  const context = fakeContext();
  const source = { id: "camera" };
  const resolved = renderCameraFrame(
    context,
    source,
    2,
    1,
    { filter: "mono", effect: "vignette" },
    { mirrored: true },
  );

  assert.deepEqual(resolved, { filter: "mono", effect: "vignette" });
  assert.ok(context.calls.some(call => call[0] === "translate" && call[1] === 2));
  assert.ok(context.calls.some(call => call[0] === "scale" && call[1] === -1));
  assert.ok(context.calls.some(call => call[0] === "getImageData"));
  assert.ok(context.calls.some(call => call[0] === "putImageData"));
  assert.ok(context.calls.some(call => call[0] === "fillRect"));
  assert.equal(context.gradients[0].stops.length, 3);
  assert.equal(context.imageData.data[0], context.imageData.data[1]);
});

test("original frames skip the pixel readback path", () => {
  const context = fakeContext();
  renderCameraFrame(context, {}, 2, 1, { filter: "original", effect: "none" });

  assert.equal(context.calls.some(call => call[0] === "getImageData"), false);
  assert.equal(context.calls.some(call => call[0] === "putImageData"), false);
});

test("flashy effects render deterministic VHS and neon overlays into the photo", () => {
  const vhsContext = fakeContext();
  renderCameraFrame(vhsContext, {}, 320, 180, { filter: "original", effect: "vhs" });
  const vhsFillCount = vhsContext.calls.filter(call => call[0] === "fillRect").length;

  const neonContext = fakeContext();
  renderCameraFrame(neonContext, {}, 320, 180, { filter: "original", effect: "neon" });

  assert.ok(vhsFillCount > 100);
  assert.equal(neonContext.gradients.length, 2);
  assert.deepEqual(neonContext.gradients.map(gradient => gradient.stops.length), [3, 3]);
});

test("matte photobooth filters lift shadows without clipping highlights", () => {
  const pixel = value => {
    const imageData = { width: 1, height: 1, data: new Uint8ClampedArray([value, value, value, 255]) };
    return imageData;
  };
  const apply = (value, filterId) => {
    const data = pixel(value);
    applyFilterToImageData(data, filterId, undefined);
    return [data.data[0], data.data[1], data.data[2]];
  };

  for (const filterId of ["cream", "photogray", "peach", "matte-mono"]) {
    const black = apply(0, filterId);
    const white = apply(255, filterId);
    // 陰影被抬起,不再是死黑
    assert.ok(Math.min(...black) > 8, `${filterId} should lift blacks`);
    // 高光沒有整片溢出成純白(霧面而非過曝)
    assert.ok(Math.max(...white) <= 255, `${filterId} must not exceed range`);
    assert.ok(black.every((channel, index) => channel < white[index]), `${filterId} keeps tonal order`);
  }
});

test("channel-specific lifts tint the shadows warm or cool", () => {
  const shadow = filterId => {
    const data = { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) };
    applyFilterToImageData(data, filterId, undefined);
    return { red: data.data[0], blue: data.data[2] };
  };
  const cream = shadow("cream");
  const photogray = shadow("photogray");
  assert.ok(cream.red > cream.blue, "cream shadows lean warm");
  assert.ok(photogray.blue > photogray.red, "photogray shadows lean cool");
});
