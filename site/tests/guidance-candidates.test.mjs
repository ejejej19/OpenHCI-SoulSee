import test from "node:test";
import assert from "node:assert/strict";

import { buildGuidanceCandidates } from "../public/guidance-candidates.js";
import { measurePoseMatch } from "../public/pose-similarity.js";

function landmarkPose({ dx = 0, dy = 0 } = {}) {
  const points = Array.from({ length: 33 }, () => null);
  const set = (index, x, y) => {
    points[index] = { x: x + dx, y: y + dy, visibility: 1, presence: 1 };
  };
  set(0, 0.5, 0.12);
  set(11, 0.4, 0.28);
  set(12, 0.6, 0.28);
  set(13, 0.34, 0.46);
  set(14, 0.66, 0.46);
  set(15, 0.3, 0.64);
  set(16, 0.7, 0.64);
  set(23, 0.44, 0.58);
  set(24, 0.56, 0.58);
  set(25, 0.43, 0.76);
  set(26, 0.57, 0.76);
  set(27, 0.42, 0.94);
  set(28, 0.58, 0.94);
  return points;
}

function alignment(overrides = {}) {
  return {
    valid: true,
    confidence: 0.9,
    placement: { delta_x: 0.12, delta_y: -0.08, scale_ratio: 1.25 },
    layout: {
      confidence: 0.85,
      deltas: { headroom: 0.08, footroom: -0.07 },
      target: { clipped: { top: false, bottom: false } },
      live: { clipped: { top: false, bottom: false } },
    },
    ...overrides,
  };
}

test("layout and placement differences become separate explainable candidates", () => {
  const candidates = buildGuidanceCandidates({ alignment: alignment() });

  assert.deepEqual(candidates.map(item => item.id), [
    "subject-scale",
    "subject-center-x",
    "subject-center-y",
    "subject-headroom",
    "subject-footroom",
  ]);
  assert.ok(candidates.every(item => item.text.includes("，")));
  assert.ok(candidates.every(item => item.reason.length > 0));
  assert.equal(candidates.find(item => item.id === "subject-scale").text.includes("靠近"), true);
});

test("landmark displacement produces the correct subject movement direction", () => {
  const measurement = measurePoseMatch(
    landmarkPose(),
    landmarkPose({ dx: -0.12 }),
  );
  const horizontal = buildGuidanceCandidates({ alignment: measurement })
    .find(item => item.id === "subject-center-x");

  assert.equal(measurement.valid, true);
  assert.ok(measurement.placement.delta_x > 0.1);
  assert.match(horizontal.text, /人物往右/);
  assert.equal(horizontal.reason, "人物中心比參考偏左");
});

test("unavailable or clipped margins do not produce guessed guidance", () => {
  const input = alignment({
    layout: {
      confidence: 0.9,
      deltas: { headroom: 0.1, footroom: null },
      target: { clipped: { top: true, bottom: false } },
      live: { clipped: { top: false, bottom: false } },
    },
  });
  const ids = buildGuidanceCandidates({ alignment: input }).map(item => item.id);

  assert.equal(ids.includes("subject-headroom"), false);
  assert.equal(ids.includes("subject-footroom"), false);
});

test("horizon roll and height are emitted as distinct camera corrections", () => {
  const roll = buildGuidanceCandidates({
    composition: { valid: true, score: 0.4, roll_delta_degrees: 8, height_delta: 0.1, confidence: 0.8 },
  });
  const height = buildGuidanceCandidates({
    composition: { valid: true, score: 0.6, roll_delta_degrees: 1, height_delta: -0.12, confidence: 0.8 },
  });

  assert.deepEqual(roll.map(item => item.id), ["composition-roll"]);
  assert.deepEqual(height.map(item => item.id), ["composition-horizon-height"]);
  assert.match(height[0].text, /鏡頭再往下/);
});

test("device leveling is used only for a level target without unresolved image roll", () => {
  const base = {
    orientation: { valid: true, roll_degrees: 7, confidence: 0.9 },
    targetComposition: { valid: true, roll_degrees: 1 },
  };
  const available = buildGuidanceCandidates(base);
  const blocked = buildGuidanceCandidates({
    ...base,
    composition: { valid: true, score: 0.5, roll_delta_degrees: 6, height_delta: 0, confidence: 0.8 },
  });

  assert.deepEqual(available.map(item => item.id), ["device-level"]);
  assert.equal(blocked.some(item => item.id === "device-level"), false);
});
