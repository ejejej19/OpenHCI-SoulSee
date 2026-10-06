import {
  DEFAULT_LOOK_ADJUSTMENTS,
  isNeutralLookAdjustments,
  normalizeLookAdjustments,
} from "./look-matching.js";

const freezePreset = preset => Object.freeze(preset);

// 拍貼機調色的共同語彙:陰影不壓死(霧面提亮)、對比放低、亮度提高,
// 再用分通道的陰影染色決定是暖霧還是冷霧。這是 purikura 的 fuwafuwa 與
// 韓系自助照相館(photogray)看起來跟一般相機濾鏡不同的主因。
// redOffset/greenOffset/blueOffset 省略時退回單一 offset。
export const FILTER_PRESETS = Object.freeze([
  freezePreset({
    id: "original",
    label: "原始",
    cssFilter: "none",
    saturation: 1,
    contrast: 1,
    brightness: 1,
    red: 1,
    green: 1,
    blue: 1,
    offset: 0,
  }),
  freezePreset({
    id: "cream",
    label: "奶油",
    group: "拍貼機",
    cssFilter: "brightness(1.07) contrast(.86) saturate(.94)",
    saturation: 0.94,
    contrast: 0.86,
    brightness: 1.07,
    red: 1.02,
    green: 1,
    blue: 0.99,
    offset: 16,
    redOffset: 20,
    greenOffset: 17,
    blueOffset: 13,
  }),
  freezePreset({
    id: "photogray",
    label: "冷霧",
    group: "拍貼機",
    cssFilter: "brightness(1.05) contrast(.92) saturate(.8) hue-rotate(4deg)",
    saturation: 0.8,
    contrast: 0.92,
    brightness: 1.05,
    red: 0.98,
    green: 1,
    blue: 1.04,
    offset: 14,
    redOffset: 11,
    greenOffset: 14,
    blueOffset: 19,
  }),
  freezePreset({
    id: "peach",
    label: "蜜桃",
    group: "拍貼機",
    cssFilter: "brightness(1.05) contrast(.9) saturate(1.06) sepia(.06)",
    saturation: 1.06,
    contrast: 0.9,
    brightness: 1.05,
    red: 1.05,
    green: 0.99,
    blue: 0.99,
    offset: 13,
    redOffset: 18,
    greenOffset: 11,
    blueOffset: 13,
  }),
  freezePreset({
    id: "matte-mono",
    label: "霧面黑白",
    group: "拍貼機",
    cssFilter: "grayscale(1) brightness(1.05) contrast(.95)",
    saturation: 0,
    contrast: 0.95,
    brightness: 1.05,
    red: 1,
    green: 1,
    blue: 1,
    offset: 18,
  }),
  freezePreset({
    id: "y2k",
    label: "千禧",
    group: "拍貼機",
    cssFilter: "saturate(1.14) contrast(1.12) brightness(.99) hue-rotate(-4deg)",
    saturation: 1.14,
    contrast: 1.12,
    brightness: 0.99,
    red: 1.01,
    green: 1.02,
    blue: 0.97,
    offset: 6,
    redOffset: 4,
    greenOffset: 7,
    blueOffset: 8,
  }),
  freezePreset({
    id: "vivid",
    label: "鮮明",
    group: "經典",
    cssFilter: "saturate(1.35) contrast(1.08) brightness(1.01)",
    saturation: 1.35,
    contrast: 1.08,
    brightness: 1.01,
    red: 1.02,
    green: 1,
    blue: 1.01,
    offset: 0,
  }),
  freezePreset({
    id: "warm",
    label: "暖陽",
    group: "經典",
    cssFilter: "sepia(.16) saturate(1.18) contrast(1.03) brightness(1.01)",
    saturation: 1.12,
    contrast: 1.03,
    brightness: 1.01,
    red: 1.08,
    green: 1.02,
    blue: 0.92,
    offset: 0,
  }),
  freezePreset({
    id: "cool",
    label: "冷調",
    group: "經典",
    cssFilter: "saturate(.92) hue-rotate(8deg) contrast(1.06)",
    saturation: 0.92,
    contrast: 1.06,
    brightness: 1,
    red: 0.94,
    green: 1.02,
    blue: 1.09,
    offset: 0,
  }),
  freezePreset({
    id: "film",
    label: "底片",
    group: "經典",
    cssFilter: "sepia(.12) saturate(.78) contrast(1.1) brightness(1.04)",
    saturation: 0.78,
    contrast: 1.1,
    brightness: 1.04,
    red: 1.06,
    green: 1.01,
    blue: 0.92,
    offset: 4,
  }),
  freezePreset({
    id: "mono",
    label: "黑白",
    group: "經典",
    cssFilter: "grayscale(1) contrast(1.15)",
    saturation: 0,
    contrast: 1.15,
    brightness: 1,
    red: 1,
    green: 1,
    blue: 1,
    offset: 0,
  }),
]);

export const EFFECT_PRESETS = Object.freeze([
  freezePreset({ id: "none", label: "無", group: "基本" }),
  freezePreset({ id: "vignette", label: "暗角", group: "質感" }),
  freezePreset({ id: "glow", label: "柔光", group: "質感" }),
  freezePreset({ id: "grain", label: "顆粒", group: "質感" }),
  freezePreset({ id: "vhs", label: "VHS 故障", group: "玩味" }),
  freezePreset({ id: "neon", label: "霓虹光暈", group: "玩味" }),
]);

const FILTERS_BY_ID = new Map(FILTER_PRESETS.map(preset => [preset.id, preset]));
const EFFECTS_BY_ID = new Map(EFFECT_PRESETS.map(preset => [preset.id, preset]));

const clampChannel = value => Math.min(255, Math.max(0, Math.round(value)));

export function resolveCameraLook(look = {}) {
  const resolved = {
    filter: FILTERS_BY_ID.has(look?.filter) ? look.filter : FILTER_PRESETS[0].id,
    effect: EFFECTS_BY_ID.has(look?.effect) ? look.effect : EFFECT_PRESETS[0].id,
  };
  if (look?.adjustments) resolved.adjustments = normalizeLookAdjustments(look.adjustments);
  return resolved;
}

export function resetLookAdjustments(look = {}) {
  const resolved = resolveCameraLook(look);
  return {
    filter: resolved.filter,
    effect: resolved.effect,
    adjustments: { ...DEFAULT_LOOK_ADJUSTMENTS },
  };
}

export function cameraLookLabel(look) {
  const resolved = resolveCameraLook(look);
  const synced = resolved.adjustments && !isNeutralLookAdjustments(resolved.adjustments)
    ? " / AI 色調"
    : "";
  return `${FILTERS_BY_ID.get(resolved.filter).label} / ${EFFECTS_BY_ID.get(resolved.effect).label}${synced}`;
}

export function applyPreviewLook(video, overlay, look) {
  const resolved = resolveCameraLook(look);
  const presetFilter = FILTERS_BY_ID.get(resolved.filter).cssFilter;
  const filters = presetFilter === "none" ? [] : [presetFilter];
  if (resolved.adjustments) {
    const { brightness, contrast, saturation, temperature } = resolved.adjustments;
    filters.push(`brightness(${brightness})`, `contrast(${contrast})`, `saturate(${saturation})`);
    if (Math.abs(temperature) >= 0.005) {
      const amount = Math.abs(temperature) * 0.42;
      const rotation = temperature > 0 ? -10 : 155;
      filters.push(`sepia(${amount})`, `hue-rotate(${rotation}deg)`);
    }
  }
  video.style.filter = filters.length ? filters.join(" ") : "none";
  overlay.dataset.effect = resolved.effect;
  return resolved;
}

export function applyFilterToImageData(imageData, filterId, adjustments) {
  if (!imageData?.data) throw new TypeError("imageData with pixel data is required");
  const preset = FILTERS_BY_ID.get(filterId) ?? FILTER_PRESETS[0];
  const custom = normalizeLookAdjustments(adjustments);
  if (preset.id === "original" && isNeutralLookAdjustments(custom)) return imageData;

  const saturation = preset.saturation * custom.saturation;
  const contrast = preset.contrast * custom.contrast;
  const brightness = preset.brightness * custom.brightness;
  const redTemperature = 1 + custom.temperature * 0.22;
  const blueTemperature = 1 - custom.temperature * 0.22;

  // 霧面提亮:把整段動態範圍壓進 [lift, 255],陰影抬起而高光不被推爆。
  // 直接加常數會讓亮部整片溢出成白色,那正是「很醜」的來源。
  const redLift = preset.redOffset ?? preset.offset;
  const greenLift = preset.greenOffset ?? preset.offset;
  const blueLift = preset.blueOffset ?? preset.offset;
  const redScale = 1 - redLift / 255;
  const greenScale = 1 - greenLift / 255;
  const blueScale = 1 - blueLift / 255;

  const pixels = imageData.data;
  for (let index = 0; index < pixels.length; index += 4) {
    const sourceRed = pixels[index];
    const sourceGreen = pixels[index + 1];
    const sourceBlue = pixels[index + 2];
    const luminance = 0.2126 * sourceRed + 0.7152 * sourceGreen + 0.0722 * sourceBlue;
    const saturatedRed = luminance + (sourceRed - luminance) * saturation;
    const saturatedGreen = luminance + (sourceGreen - luminance) * saturation;
    const saturatedBlue = luminance + (sourceBlue - luminance) * saturation;

    pixels[index] = clampChannel(
      ((saturatedRed * brightness - 128) * contrast + 128) * preset.red * redTemperature * redScale + redLift,
    );
    pixels[index + 1] = clampChannel(
      ((saturatedGreen * brightness - 128) * contrast + 128) * preset.green * greenScale + greenLift,
    );
    pixels[index + 2] = clampChannel(
      ((saturatedBlue * brightness - 128) * contrast + 128) * preset.blue * blueTemperature * blueScale + blueLift,
    );
  }
  return imageData;
}

function fillGradient(context, gradient, width, height, compositeOperation = "source-over") {
  context.save();
  context.globalCompositeOperation = compositeOperation;
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  context.restore();
}

function drawVignette(context, width, height) {
  const outerRadius = Math.hypot(width, height) * 0.58;
  const gradient = context.createRadialGradient(
    width * 0.5,
    height * 0.47,
    Math.min(width, height) * 0.2,
    width * 0.5,
    height * 0.47,
    outerRadius,
  );
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(0.55, "rgba(0,0,0,0.04)");
  gradient.addColorStop(1, "rgba(0,0,0,0.68)");
  fillGradient(context, gradient, width, height);
}

function drawGlow(context, width, height) {
  const gradient = context.createRadialGradient(
    width * 0.18,
    height * 0.12,
    0,
    width * 0.18,
    height * 0.12,
    Math.max(width, height) * 0.72,
  );
  gradient.addColorStop(0, "rgba(255,236,203,0.34)");
  gradient.addColorStop(0.42, "rgba(255,190,145,0.13)");
  gradient.addColorStop(1, "rgba(255,190,145,0)");
  fillGradient(context, gradient, width, height, "screen");
}

function drawGrain(context, width, height) {
  const dotCount = Math.min(1_600, Math.max(450, Math.round((width * height) / 3_500)));
  const dotSize = Math.max(1, Math.round(Math.min(width, height) / 720));
  let seed = ((width * 73_856_093) ^ (height * 19_349_663)) >>> 0;

  context.save();
  context.globalCompositeOperation = "soft-light";
  context.globalAlpha = 0.16;
  for (let index = 0; index < dotCount; index += 1) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const x = (seed >>> 0) % width;
    const y = (Math.imul(seed, 2_654_435_761) >>> 0) % height;
    context.fillStyle = seed & 1 ? "#fff" : "#000";
    context.fillRect(x, y, dotSize, dotSize);
  }
  context.restore();
}

function drawVhs(context, width, height) {
  const scanlineStep = Math.max(3, Math.round(height / 220));
  const scanlineHeight = Math.max(1, Math.round(scanlineStep / 3));

  context.save();
  context.globalAlpha = 0.2;
  context.fillStyle = "#000";
  for (let y = 0; y < height; y += scanlineStep) {
    context.fillRect(0, y, width, scanlineHeight);
  }
  context.globalCompositeOperation = "screen";
  context.globalAlpha = 0.18;
  context.fillStyle = "#00d9ff";
  context.fillRect(0, height * 0.19, width, Math.max(2, height * 0.018));
  context.fillStyle = "#ff2ca8";
  context.fillRect(0, height * 0.73, width, Math.max(2, height * 0.024));
  context.globalAlpha = 0.1;
  context.fillStyle = "#fff";
  context.fillRect(0, height * 0.49, width, Math.max(1, height * 0.008));
  context.restore();
  drawGrain(context, width, height);
}

function drawNeon(context, width, height) {
  const radius = Math.max(width, height) * 0.72;
  const cyan = context.createRadialGradient(
    width * 0.08,
    height * 0.82,
    0,
    width * 0.08,
    height * 0.82,
    radius,
  );
  cyan.addColorStop(0, "rgba(0,229,255,0.48)");
  cyan.addColorStop(0.46, "rgba(0,147,255,0.17)");
  cyan.addColorStop(1, "rgba(0,147,255,0)");
  fillGradient(context, cyan, width, height, "screen");

  const magenta = context.createRadialGradient(
    width * 0.94,
    height * 0.16,
    0,
    width * 0.94,
    height * 0.16,
    radius,
  );
  magenta.addColorStop(0, "rgba(255,34,181,0.5)");
  magenta.addColorStop(0.48, "rgba(165,45,255,0.18)");
  magenta.addColorStop(1, "rgba(165,45,255,0)");
  fillGradient(context, magenta, width, height, "screen");
}

export function drawCameraEffect(context, width, height, effectId) {
  switch (EFFECTS_BY_ID.has(effectId) ? effectId : "none") {
    case "vignette":
      drawVignette(context, width, height);
      break;
    case "glow":
      drawGlow(context, width, height);
      break;
    case "grain":
      drawGrain(context, width, height);
      break;
    case "vhs":
      drawVhs(context, width, height);
      break;
    case "neon":
      drawNeon(context, width, height);
      break;
  }
}

export function renderCameraFrame(
  context,
  source,
  width,
  height,
  look,
  { mirrored = false } = {},
) {
  if (!context || !source) throw new TypeError("canvas context and frame source are required");
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new TypeError("frame dimensions must be positive");
  }

  const resolved = resolveCameraLook(look);
  context.save();
  if (mirrored) {
    context.translate(width, 0);
    context.scale(-1, 1);
  }
  context.drawImage(source, 0, 0, width, height);
  context.restore();

  if (resolved.filter !== "original" || !isNeutralLookAdjustments(resolved.adjustments)) {
    const imageData = context.getImageData(0, 0, width, height);
    applyFilterToImageData(imageData, resolved.filter, resolved.adjustments);
    context.putImageData(imageData, 0, 0);
  }
  drawCameraEffect(context, width, height, resolved.effect);
  return resolved;
}
