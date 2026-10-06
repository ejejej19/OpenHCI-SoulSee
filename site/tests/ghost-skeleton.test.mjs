import test from "node:test";
import assert from "node:assert/strict";

import { skeletonGeometry } from "../public/ghost-skeleton.js";
import { POSE_LANDMARK } from "../public/pose-similarity.js";

function pointArray(entries) {
  const points = [];
  for (const [index, point] of Object.entries(entries)) points[Number(index)] = point;
  return points;
}

function basePose() {
  return pointArray({
    [POSE_LANDMARK.NOSE]: { x: 100, y: 40, visibility: 0.9 },
    [POSE_LANDMARK.LEFT_SHOULDER]: { x: 60, y: 100, visibility: 0.9 },
    [POSE_LANDMARK.RIGHT_SHOULDER]: { x: 140, y: 100, visibility: 0.9 },
    [POSE_LANDMARK.LEFT_ELBOW]: { x: 40, y: 160, visibility: 0.9 },
    [POSE_LANDMARK.LEFT_WRIST]: { x: 30, y: 220, visibility: 0.9 },
    [POSE_LANDMARK.LEFT_HIP]: { x: 70, y: 220, visibility: 0.9 },
    [POSE_LANDMARK.RIGHT_HIP]: { x: 130, y: 220, visibility: 0.9 },
  });
}

test("builds head from nose and shoulder distance, plus a neck segment", () => {
  const { head, segments } = skeletonGeometry(basePose());
  assert.ok(head);
  assert.equal(head.x, 100);
  assert.equal(head.y, 40);
  assert.ok(Math.abs(head.r - 80 * 0.34) < 1e-9);
  const neck = segments.at(-1);
  assert.deepEqual(neck[1], { x: 100, y: 100 });
  assert.equal(neck[0].x, 100);
  assert.ok(Math.abs(neck[0].y - (40 + head.r)) < 1e-9);
});

test("drops segments whose endpoints are missing or low visibility", () => {
  const points = basePose();
  points[POSE_LANDMARK.LEFT_WRIST].visibility = 0.2;
  const { segments } = skeletonGeometry(points);
  const hasWristSegment = segments.some(([a, b]) =>
    [a, b].some(p => p.x === 30 && p.y === 220));
  assert.equal(hasWristSegment, false);
  const hasElbowSegment = segments.some(([a, b]) =>
    [a, b].some(p => p.x === 40 && p.y === 160));
  assert.equal(hasElbowSegment, true);
});

test("omits head when nose is not usable and tolerates empty input", () => {
  const points = basePose();
  delete points[POSE_LANDMARK.NOSE];
  assert.equal(skeletonGeometry(points).head, null);
  assert.deepEqual(skeletonGeometry(undefined), { segments: [], head: null });
});

test("treats points without visibility as usable", () => {
  const points = basePose();
  for (const point of points) if (point) delete point.visibility;
  const { head, segments } = skeletonGeometry(points);
  assert.ok(head);
  assert.ok(segments.length >= 4);
});
