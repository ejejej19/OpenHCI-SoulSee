import test from "node:test";
import assert from "node:assert/strict";
import {
  compareHorizons,
  detectDominantHorizon,
  levelInstruction,
  placementInstruction,
} from "../public/composition-guide.js";
import { screenRollFromOrientation } from "../public/orientation-sensor.js";

function horizonImage(width, height, { y = 0.6, slope = 0 } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const boundary = y * height + slope * (column - width / 2);
      const color = row < boundary ? [180, 220, 250] : [25, 95, 125];
      const index = (row * width + column) * 4;
      data.set([...color, 255], index);
    }
  }
  return { data, width, height };
}

test("dominant horizon detector finds scene ratio and camera roll", () => {
  const result = detectDominantHorizon(horizonImage(160, 120, { y: 0.64, slope: 0.08 }));

  assert.equal(result.valid, true);
  assert.ok(Math.abs(result.horizon_y - 0.64) < 0.03);
  assert.ok(Math.abs(result.roll_degrees - Math.atan(0.08) * 180 / Math.PI) < 1.5);
  assert.ok(result.confidence > 0.5);
});

test("dominant horizon stays unavailable when it does not pass the confidence gate", () => {
  const result = detectDominantHorizon(
    horizonImage(160, 120, { y: 0.58, slope: 0.04 }),
    { minimumConfidence: 1 },
  );

  assert.equal(result.valid, false);
  assert.equal(result.reason, "low_confidence");
  assert.ok(result.confidence > 0 && result.confidence < 1);
});

test("horizon comparison gives a distinct angle instruction even when height matches", () => {
  const target = detectDominantHorizon(horizonImage(160, 120, { y: 0.64, slope: 0 }));
  const current = detectDominantHorizon(horizonImage(160, 120, { y: 0.64, slope: 0.14 }));
  const result = compareHorizons(target, current);

  assert.equal(result.valid, true);
  assert.ok(result.score < 0.8);
  assert.match(result.instruction, /旋轉手機/);
});

test("placement guidance separates subject position from pose", () => {
  assert.equal(placementInstruction({ delta_x: 0.12, delta_y: 0, scale_ratio: 1 }).text, "人物往右");
  assert.equal(placementInstruction({ delta_x: 0, delta_y: 0, scale_ratio: 1.2 }).text, "再靠近一點");
  assert.equal(placementInstruction({ delta_x: 0.01, delta_y: 0.01, scale_ratio: 1.02 }).matched, true);
});

test("device orientation provides level guidance and rejects a flat device", () => {
  const upright = screenRollFromOrientation({ beta: 90, gamma: 0 }, 0);
  const tilted = screenRollFromOrientation({ beta: 80, gamma: 90 }, 0);
  const flat = screenRollFromOrientation({ beta: 0, gamma: 0 }, 0);

  assert.ok(Math.abs(upright.roll_degrees) < 0.1);
  assert.ok(Math.abs(tilted.roll_degrees) > 8);
  assert.equal(flat.valid, false);
  assert.equal(levelInstruction(tilted), "手機再轉正 10°");
});
