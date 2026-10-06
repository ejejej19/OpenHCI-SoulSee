import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeImageData,
  estimateLookRecipe,
  measureLookSimilarity,
  normalizeLookAdjustments,
} from "../public/look-matching.js";

function imageData(colors, repeat = 8) {
  const data = [];
  for (let index = 0; index < repeat; index += 1) {
    for (const color of colors) data.push(...color, 255);
  }
  return { data: new Uint8ClampedArray(data) };
}

test("image analysis separates brightness, contrast, saturation, and temperature", () => {
  const warm = analyzeImageData(imageData([[245, 150, 60], [120, 40, 10]]));
  const cool = analyzeImageData(imageData([[90, 150, 245], [10, 40, 120]]));

  assert.equal(warm.valid, true);
  assert.ok(warm.contrast > 0);
  assert.ok(warm.saturation > 0.5);
  assert.ok(warm.temperature > 0);
  assert.ok(cool.temperature < 0);
});

test("look recipe moves source statistics toward the target within bounded controls", () => {
  const source = {
    valid: true,
    mean_luma: 0.4,
    contrast: 0.1,
    saturation: 0.25,
    temperature: -0.1,
    confidence: 0.9,
  };
  const target = {
    valid: true,
    mean_luma: 0.5,
    contrast: 0.13,
    saturation: 0.35,
    temperature: 0.1,
    confidence: 0.8,
  };
  const recipe = estimateLookRecipe(target, source);

  assert.equal(recipe.valid, true);
  assert.equal(recipe.adjustments.brightness, 1.25);
  assert.equal(recipe.adjustments.contrast, 1.3);
  assert.equal(recipe.adjustments.saturation, 1.4);
  assert.ok(Math.abs(recipe.adjustments.temperature - 0.16) < 1e-9);
  assert.equal(recipe.confidence, 0.8);
});

test("look controls clamp unsafe or unreadable values", () => {
  assert.deepEqual(normalizeLookAdjustments({
    brightness: 9,
    contrast: 0,
    saturation: 4,
    temperature: -2,
  }), {
    brightness: 1.3,
    contrast: 0.7,
    saturation: 1.6,
    temperature: -0.35,
  });
});

test("look similarity reports identical images as a full match", () => {
  const stats = analyzeImageData(imageData([[245, 150, 60], [120, 40, 10]]));
  const result = measureLookSimilarity(stats, stats);

  assert.equal(result.valid, true);
  assert.ok(result.score > 0.999);
  assert.ok(Object.values(result.dimensions).every(value => value > 0.999));
});
