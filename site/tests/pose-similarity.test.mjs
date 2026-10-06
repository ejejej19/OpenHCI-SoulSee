import test from "node:test";
import assert from "node:assert/strict";
import {
  MatchTracker,
  POSE_LANDMARK,
  mapLandmarksToCover,
  measurePoseMatch,
} from "../public/pose-similarity.js";
import { PoseAlignmentController } from "../public/pose-alignment-controller.js";

function pose({ dx = 0, dy = 0, scale = 1, visibility = 1 } = {}) {
  const points = Array.from({ length: 33 }, () => null);
  const set = (index, x, y) => {
    points[index] = { x: x * scale + dx, y: y * scale + dy, visibility, presence: visibility };
  };
  set(POSE_LANDMARK.NOSE, 0.5, 0.1);
  set(POSE_LANDMARK.LEFT_SHOULDER, 0.4, 0.25);
  set(POSE_LANDMARK.RIGHT_SHOULDER, 0.6, 0.25);
  set(POSE_LANDMARK.LEFT_ELBOW, 0.32, 0.42);
  set(POSE_LANDMARK.RIGHT_ELBOW, 0.68, 0.42);
  set(POSE_LANDMARK.LEFT_WRIST, 0.28, 0.58);
  set(POSE_LANDMARK.RIGHT_WRIST, 0.72, 0.58);
  set(POSE_LANDMARK.LEFT_HIP, 0.44, 0.55);
  set(POSE_LANDMARK.RIGHT_HIP, 0.56, 0.55);
  set(POSE_LANDMARK.LEFT_KNEE, 0.43, 0.75);
  set(POSE_LANDMARK.RIGHT_KNEE, 0.57, 0.75);
  set(POSE_LANDMARK.LEFT_ANKLE, 0.42, 0.95);
  set(POSE_LANDMARK.RIGHT_ANKLE, 0.58, 0.95);
  return points;
}

function mirror(points) {
  return points.map(point => point && { ...point, x: 1 - point.x });
}

test("identical poses produce full pose, framing, and match scores", () => {
  const target = pose();
  const result = measurePoseMatch(target, pose());

  assert.equal(result.valid, true);
  assert.ok(result.pose > 0.999);
  assert.ok(result.framing > 0.999);
  assert.ok(result.match > 0.999);
  assert.equal(result.coverage_class, "full_body");
  assert.equal(result.metric_version, "pose-layout-v2-uncalibrated");
  assert.ok(result.layout.similarity > 0.999);
});

test("translation changes framing without changing intrinsic pose", () => {
  const result = measurePoseMatch(pose(), pose({ dx: 0.16, dy: -0.08 }));

  assert.equal(result.valid, true);
  assert.ok(result.pose > 0.999);
  assert.ok(result.framing < 0.8);
  assert.ok(result.match < result.pose);
  assert.ok(result.placement.delta_x < -0.15);
  assert.ok(result.placement.delta_y > 0.07);
  assert.ok(result.layout.deltas.left_clearance < -0.15);
  assert.ok(result.layout.deltas.right_clearance > 0.15);
});

test("scale changes framing without changing intrinsic pose", () => {
  const result = measurePoseMatch(pose(), pose({ dx: -0.1, dy: -0.1, scale: 1.2 }));

  assert.equal(result.valid, true);
  assert.ok(result.pose > 0.999);
  assert.ok(result.framing < 0.95);
});

test("a changed arm angle lowers the pose score", () => {
  const live = pose();
  live[POSE_LANDMARK.LEFT_WRIST] = {
    ...live[POSE_LANDMARK.LEFT_WRIST],
    x: 0.52,
    y: 0.35,
  };
  const result = measurePoseMatch(pose(), live);

  assert.equal(result.valid, true);
  assert.ok(result.pose < 0.95);
});

test("mirroring both inputs preserves their similarity", () => {
  const result = measurePoseMatch(mirror(pose()), mirror(pose()));

  assert.equal(result.valid, true);
  assert.ok(result.match > 0.999);
});

test("occluded joints are excluded when enough shared landmarks remain", () => {
  const live = pose();
  for (const index of [POSE_LANDMARK.LEFT_WRIST, POSE_LANDMARK.LEFT_ANKLE]) {
    live[index] = { ...live[index], visibility: 0.1, presence: 0.1 };
  }
  const result = measurePoseMatch(pose(), live);

  assert.equal(result.valid, true);
  assert.equal(result.shared_landmarks, 11);
});

test("low-confidence poses return unavailable instead of a number", () => {
  const result = measurePoseMatch(pose(), pose({ visibility: 0.2 }));

  assert.equal(result.valid, false);
  assert.equal(result.reason, "insufficient_landmarks");
});

test("object-fit cover coordinates reflect the visible crop", () => {
  const mapped = mapLandmarksToCover(
    [{ x: 0, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }],
    { width: 1920, height: 1080 },
    { width: 300, height: 500 },
  );

  assert.ok(mapped[0].x < 0);
  assert.ok(Math.abs(mapped[1].x - 0.5) < 1e-9);
  assert.ok(mapped[2].x > 1);
});

test("tracker records a stable baseline and baseline-to-final gain", () => {
  const tracker = new MatchTracker({ windowSize: 1, alpha: 1, baselineFrames: 2, matchHoldMs: 100 });
  const measurement = match => ({
    valid: true,
    coverage_class: "full_body",
    pose: match,
    framing: match,
    match,
    confidence: 0.9,
  });

  tracker.update(measurement(0.4), 0);
  tracker.update(measurement(0.5), 100);
  tracker.update(measurement(0.8), 200);
  tracker.update(measurement(0.82), 320);
  const summary = tracker.summary();

  assert.equal(summary.baseline.match, 50);
  assert.equal(summary.final.match, 82);
  assert.equal(summary.match_gain, 32);
  assert.equal(summary.time_to_match_ms, 220);
  assert.equal(summary.valid_frame_ratio, 1);
  assert.equal(summary.final_placement, null);
});

test("tracker briefly holds the last valid score through detection jitter", () => {
  const tracker = new MatchTracker({ windowSize: 1, alpha: 1, baselineFrames: 1, missingGraceMs: 500 });
  tracker.update({
    valid: true,
    coverage_class: "upper_body",
    pose: 0.7,
    framing: 0.6,
    match: 0.67,
    confidence: 0.9,
  }, 1000);

  const held = tracker.update({ valid: false, reason: "live_missing" }, 1300);
  const expired = tracker.update({ valid: false, reason: "live_missing" }, 1600);

  assert.equal(held.valid, true);
  assert.equal(held.stale, true);
  assert.equal(held.stale_reason, "live_missing");
  assert.equal(expired.valid, false);
});

test("tracker preserves the final explainable layout comparison", () => {
  const tracker = new MatchTracker({ windowSize: 1, alpha: 1, baselineFrames: 1 });
  tracker.update(measurePoseMatch(pose(), pose({ dx: 0.05 })), 1000);
  const summary = tracker.summary();

  assert.equal(summary.align_metric_version, "pose-layout-v2-uncalibrated");
  assert.equal(summary.final_layout.metric_version, "subject-layout-v1-uncalibrated");
  assert.equal(summary.final_layout.deltas.center_x, -0.05);
  assert.equal(summary.final_layout.measured_features.includes("headroom"), true);
});

test("controller detects the target once and compares live frames in display coordinates", async () => {
  const targetPose = pose();
  const livePose = pose();
  const updates = [];
  const runningModes = [];
  let targetResultClosed = false;
  let liveResultClosed = false;
  let createdMode = null;

  const landmarker = {
    async setOptions({ runningMode }) {
      runningModes.push(runningMode);
    },
    detect() {
      return {
        landmarks: [targetPose],
        close() {
          targetResultClosed = true;
          targetPose[POSE_LANDMARK.LEFT_SHOULDER].x = 99;
        },
      };
    },
    detectForVideo() {
      return {
        landmarks: [livePose],
        close() {
          liveResultClosed = true;
        },
      };
    },
    close() {},
  };
  const moduleLoader = async () => ({
    FilesetResolver: { forVisionTasks: async () => ({}) },
    PoseLandmarker: {
      createFromOptions: async (_vision, options) => {
        createdMode = options.runningMode;
        return landmarker;
      },
    },
  });
  const controller = new PoseAlignmentController({
    video: { readyState: 2, videoWidth: 300, videoHeight: 500 },
    targetImage: {
      naturalWidth: 300,
      naturalHeight: 500,
      decode: async () => {},
    },
    stage: { clientWidth: 300, clientHeight: 500 },
    moduleLoader,
    onUpdate: update => updates.push(update),
  });
  controller.scheduleFrame = () => {};

  await controller.setTarget();
  controller.captureFrame();

  assert.equal(createdMode, "IMAGE");
  assert.deepEqual(runningModes, ["VIDEO"]);
  assert.equal(targetResultClosed, true);
  assert.equal(liveResultClosed, true);
  assert.equal(controller.targetLandmarks[POSE_LANDMARK.LEFT_SHOULDER].x, 0.4);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].measurement.valid, true);
  assert.ok(updates[0].measurement.match > 0.999);

  controller.dispose();
});
