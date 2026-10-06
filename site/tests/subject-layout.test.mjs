import test from "node:test";
import assert from "node:assert/strict";

import {
  compareSubjectLayouts,
  extractSubjectLayout,
  summarizeSubjectLayoutComparison,
} from "../public/subject-layout.js";

function pose({ dx = 0, dy = 0, scale = 1, includeFeet = true } = {}) {
  const points = Array.from({ length: 33 }, () => null);
  const set = (index, x, y) => {
    points[index] = {
      x: x * scale + dx,
      y: y * scale + dy,
      visibility: 1,
      presence: 1,
    };
  };
  set(0, 0.5, 0.1);
  set(7, 0.46, 0.11);
  set(8, 0.54, 0.11);
  set(11, 0.4, 0.25);
  set(12, 0.6, 0.25);
  set(15, 0.28, 0.58);
  set(16, 0.72, 0.58);
  set(23, 0.44, 0.55);
  set(24, 0.56, 0.55);
  set(25, 0.43, 0.75);
  set(26, 0.57, 0.75);
  if (includeFeet) {
    set(27, 0.42, 0.95);
    set(28, 0.58, 0.95);
  }
  return points;
}

test("extracts normalized subject size, headroom, footroom, and edge clearance", () => {
  const layout = extractSubjectLayout(pose());

  assert.equal(layout.valid, true);
  assert.equal(layout.coverage_class, "full_body");
  assert.ok(Math.abs(layout.center.x - 0.5) < 1e-9);
  assert.ok(Math.abs(layout.head_center.x - 0.5) < 1e-9);
  assert.ok(layout.headroom > 0 && layout.headroom < 0.1);
  assert.ok(layout.footroom > 0 && layout.footroom < 0.1);
  assert.ok(Math.abs(layout.left_clearance - layout.right_clearance) < 1e-9);
  assert.ok(layout.area_ratio > 0 && layout.area_ratio < 1);
});

test("identical layouts produce a complete perfect comparison", () => {
  const layout = extractSubjectLayout(pose());
  const comparison = compareSubjectLayouts(layout, extractSubjectLayout(pose()));

  assert.equal(comparison.valid, true);
  assert.ok(comparison.similarity > 0.999999);
  assert.equal(comparison.feature_coverage, 1);
  assert.deepEqual(comparison.measured_features, [
    "center", "size", "edges", "head_center", "headroom", "footroom",
  ]);
});

test("translation has distinct center, headroom, and edge deltas", () => {
  const target = extractSubjectLayout(pose());
  const live = extractSubjectLayout(pose({ dx: 0.12, dy: -0.06 }));
  const comparison = compareSubjectLayouts(target, live);

  assert.ok(comparison.deltas.center_x < -0.11);
  assert.ok(comparison.deltas.center_y > 0.04);
  assert.ok(comparison.deltas.head_center_x < -0.11);
  assert.ok(comparison.deltas.headroom > 0);
  assert.ok(comparison.deltas.left_clearance < -0.11);
  assert.ok(comparison.deltas.right_clearance > 0.11);
  assert.ok(comparison.similarity < 0.8);
});

test("scale changes expose width, height, and area ratios", () => {
  const target = extractSubjectLayout(pose());
  const live = extractSubjectLayout(pose({ dx: 0.1, dy: 0.1, scale: 0.8 }));
  const comparison = compareSubjectLayouts(target, live);

  assert.ok(comparison.deltas.width_ratio > 1.1);
  assert.ok(comparison.deltas.height_ratio > 1.1);
  assert.ok(comparison.deltas.area_ratio > 1.3);
});

test("footroom stays unavailable when both feet are not visible", () => {
  const target = extractSubjectLayout(pose({ includeFeet: false }));
  const live = extractSubjectLayout(pose({ includeFeet: false, dx: 0.02 }));
  const comparison = compareSubjectLayouts(target, live);

  assert.equal(target.coverage_class, "three_quarter");
  assert.equal(target.footroom, null);
  assert.equal(comparison.deltas.footroom, null);
  assert.equal(comparison.measured_features.includes("footroom"), false);
  assert.ok(comparison.feature_coverage < 1);
});

test("cropped subjects report clipped edges instead of negative margins", () => {
  const layout = extractSubjectLayout(pose({ dx: -0.45 }));

  assert.equal(layout.valid, true);
  assert.equal(layout.left_clearance, 0);
  assert.equal(layout.clipped.left, true);
  assert.ok(layout.right_clearance >= 0);
});

test("summary rounds the research payload while preserving unavailable values", () => {
  const comparison = compareSubjectLayouts(
    extractSubjectLayout(pose({ includeFeet: false })),
    extractSubjectLayout(pose({ includeFeet: false, dx: 0.01234 })),
  );
  const summary = summarizeSubjectLayoutComparison(comparison);

  assert.equal(summary.metric_version, "subject-layout-v1-uncalibrated");
  assert.equal(summary.deltas.center_x, -0.012);
  assert.equal(summary.deltas.footroom, null);
  assert.equal(summary.target.footroom, null);
});
