export const LOOK_MATCH_VERSION = "ghost-look-v1-heuristic";

export const DEFAULT_LOOK_ADJUSTMENTS = Object.freeze({
  brightness: 1,
  contrast: 1,
  saturation: 1,
  temperature: 0,
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

export function normalizeLookAdjustments(adjustments = {}) {
  return {
    brightness: clamp(finiteOr(adjustments.brightness, 1), 0.7, 1.3),
    contrast: clamp(finiteOr(adjustments.contrast, 1), 0.7, 1.4),
    saturation: clamp(finiteOr(adjustments.saturation, 1), 0.5, 1.6),
    temperature: clamp(finiteOr(adjustments.temperature, 0), -0.35, 0.35),
  };
}

export function isNeutralLookAdjustments(adjustments) {
  const normalized = normalizeLookAdjustments(adjustments);
  return (
    Math.abs(normalized.brightness - 1) < 1e-6 &&
    Math.abs(normalized.contrast - 1) < 1e-6 &&
    Math.abs(normalized.saturation - 1) < 1e-6 &&
    Math.abs(normalized.temperature) < 1e-6
  );
}

function invalid(reason) {
  return { valid: false, reason, metric_version: LOOK_MATCH_VERSION };
}

export function analyzeImageData(imageData, { maxSamples = 4_096 } = {}) {
  const data = imageData?.data;
  if (!data || typeof data.length !== "number") return invalid("image_data_missing");

  const pixelCount = Math.floor(data.length / 4);
  if (pixelCount < 16) return invalid("insufficient_pixels");
  const step = Math.max(1, Math.ceil(pixelCount / maxSamples));
  let samples = 0;
  let lumaSum = 0;
  let lumaSquaredSum = 0;
  let saturationSum = 0;
  let temperatureSum = 0;

  for (let pixel = 0; pixel < pixelCount; pixel += step) {
    const index = pixel * 4;
    if (data[index + 3] < 128) continue;
    const red = data[index] / 255;
    const green = data[index + 1] / 255;
    const blue = data[index + 2] / 255;
    const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    const highest = Math.max(red, green, blue);
    const lowest = Math.min(red, green, blue);
    const saturation = highest > 1e-6 ? (highest - lowest) / highest : 0;

    samples += 1;
    lumaSum += luma;
    lumaSquaredSum += luma * luma;
    saturationSum += saturation;
    temperatureSum += red - blue;
  }

  if (samples < 16) return invalid("insufficient_opaque_pixels");
  const meanLuma = lumaSum / samples;
  const variance = Math.max(0, lumaSquaredSum / samples - meanLuma * meanLuma);

  return {
    valid: true,
    metric_version: LOOK_MATCH_VERSION,
    mean_luma: meanLuma,
    contrast: Math.sqrt(variance),
    saturation: saturationSum / samples,
    temperature: temperatureSum / samples,
    sample_count: samples,
    confidence: clamp(samples / 512, 0, 1),
  };
}

function safeRatio(target, source, fallback = 1) {
  if (!Number.isFinite(target) || !Number.isFinite(source) || source < 0.015) return fallback;
  return target / source;
}

export function estimateLookRecipe(target, source) {
  if (!target?.valid) return invalid("target_analysis_unavailable");
  if (!source?.valid) return invalid("source_analysis_unavailable");

  const adjustments = normalizeLookAdjustments({
    brightness: safeRatio(target.mean_luma, source.mean_luma),
    contrast: safeRatio(target.contrast, source.contrast),
    saturation: safeRatio(target.saturation, source.saturation),
    temperature: (target.temperature - source.temperature) * 0.8,
  });

  return {
    valid: true,
    metric_version: LOOK_MATCH_VERSION,
    adjustments,
    confidence: Math.min(target.confidence, source.confidence),
  };
}

function similarityScore(delta, tolerance) {
  return Math.exp(-0.5 * (delta / tolerance) ** 2);
}

export function measureLookSimilarity(target, actual) {
  if (!target?.valid) return invalid("target_analysis_unavailable");
  if (!actual?.valid) return invalid("actual_analysis_unavailable");

  const dimensions = {
    brightness: similarityScore(target.mean_luma - actual.mean_luma, 0.2),
    contrast: similarityScore(target.contrast - actual.contrast, 0.12),
    saturation: similarityScore(target.saturation - actual.saturation, 0.25),
    temperature: similarityScore(target.temperature - actual.temperature, 0.18),
  };
  const score = Object.values(dimensions).reduce((sum, value) => sum + value, 0) / 4;

  return {
    valid: true,
    metric_version: LOOK_MATCH_VERSION,
    score: clamp(score, 0, 1),
    dimensions,
    confidence: Math.min(target.confidence, actual.confidence),
  };
}
