import {
  compareSubjectLayouts,
  extractSubjectLayout,
  landmarkConfidence,
  summarizeSubjectLayoutComparison,
} from "./subject-layout.js";

export const MATCH_METRIC_VERSION = "pose-layout-v2-uncalibrated";

export const POSE_LANDMARK = Object.freeze({
  NOSE: 0,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
});

const CORE_LANDMARKS = Object.freeze([
  POSE_LANDMARK.NOSE,
  POSE_LANDMARK.LEFT_SHOULDER,
  POSE_LANDMARK.RIGHT_SHOULDER,
  POSE_LANDMARK.LEFT_ELBOW,
  POSE_LANDMARK.RIGHT_ELBOW,
  POSE_LANDMARK.LEFT_WRIST,
  POSE_LANDMARK.RIGHT_WRIST,
  POSE_LANDMARK.LEFT_HIP,
  POSE_LANDMARK.RIGHT_HIP,
  POSE_LANDMARK.LEFT_KNEE,
  POSE_LANDMARK.RIGHT_KNEE,
  POSE_LANDMARK.LEFT_ANKLE,
  POSE_LANDMARK.RIGHT_ANKLE,
]);

const POSE_EDGES = Object.freeze([
  [POSE_LANDMARK.LEFT_SHOULDER, POSE_LANDMARK.LEFT_ELBOW],
  [POSE_LANDMARK.LEFT_ELBOW, POSE_LANDMARK.LEFT_WRIST],
  [POSE_LANDMARK.RIGHT_SHOULDER, POSE_LANDMARK.RIGHT_ELBOW],
  [POSE_LANDMARK.RIGHT_ELBOW, POSE_LANDMARK.RIGHT_WRIST],
  [POSE_LANDMARK.LEFT_HIP, POSE_LANDMARK.LEFT_KNEE],
  [POSE_LANDMARK.LEFT_KNEE, POSE_LANDMARK.LEFT_ANKLE],
  [POSE_LANDMARK.RIGHT_HIP, POSE_LANDMARK.RIGHT_KNEE],
  [POSE_LANDMARK.RIGHT_KNEE, POSE_LANDMARK.RIGHT_ANKLE],
  [POSE_LANDMARK.LEFT_SHOULDER, POSE_LANDMARK.RIGHT_SHOULDER],
  [POSE_LANDMARK.LEFT_HIP, POSE_LANDMARK.RIGHT_HIP],
  [POSE_LANDMARK.LEFT_SHOULDER, POSE_LANDMARK.LEFT_HIP],
  [POSE_LANDMARK.RIGHT_SHOULDER, POSE_LANDMARK.RIGHT_HIP],
]);

const DEFAULTS = Object.freeze({
  visibilityThreshold: 0.6,
  minimumSharedLandmarks: 6,
  minimumPoseEdges: 4,
  minimumConfidence: 0.45,
  angleSigmaRadians: Math.PI / 6,
  centerSigma: 0.12,
  scaleSigma: 0.32,
  poseWeight: 0.7,
  framingWeight: 0.3,
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const squared = value => value * value;

function finiteDimension(value) {
  return Number.isFinite(value) && value > 0;
}

function weightedMean(entries) {
  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (!totalWeight) return null;
  return entries.reduce((sum, entry) => sum + entry.value * entry.weight, 0) / totalWeight;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function invalid(reason, details = {}) {
  return { valid: false, reason, ...details };
}

export function mapLandmarksToCover(
  landmarks,
  sourceSize,
  stageSize,
  { mirrored = false } = {},
) {
  if (!Array.isArray(landmarks)) return [];
  if (
    !finiteDimension(sourceSize?.width) ||
    !finiteDimension(sourceSize?.height) ||
    !finiteDimension(stageSize?.width) ||
    !finiteDimension(stageSize?.height)
  ) {
    throw new TypeError("source and stage dimensions must be positive");
  }

  const scale = Math.max(
    stageSize.width / sourceSize.width,
    stageSize.height / sourceSize.height,
  );
  const renderedWidth = sourceSize.width * scale;
  const renderedHeight = sourceSize.height * scale;
  const cropX = (renderedWidth - stageSize.width) / 2;
  const cropY = (renderedHeight - stageSize.height) / 2;

  return landmarks.map(landmark => {
    if (!landmark) return landmark;
    const displayedX = (landmark.x * renderedWidth - cropX) / stageSize.width;
    return {
      ...landmark,
      x: mirrored ? 1 - displayedX : displayedX,
      y: (landmark.y * renderedHeight - cropY) / stageSize.height,
    };
  });
}

export function coverageClass(landmarks, visibilityThreshold = DEFAULTS.visibilityThreshold) {
  const visible = index => landmarkConfidence(landmarks?.[index]) >= visibilityThreshold;
  if (visible(POSE_LANDMARK.LEFT_ANKLE) && visible(POSE_LANDMARK.RIGHT_ANKLE)) return "full_body";
  if (visible(POSE_LANDMARK.LEFT_KNEE) || visible(POSE_LANDMARK.RIGHT_KNEE)) return "three_quarter";
  if (
    visible(POSE_LANDMARK.LEFT_SHOULDER) &&
    visible(POSE_LANDMARK.RIGHT_SHOULDER) &&
    (visible(POSE_LANDMARK.LEFT_HIP) || visible(POSE_LANDMARK.RIGHT_HIP))
  ) return "upper_body";
  return "insufficient";
}

export function measurePoseMatch(targetLandmarks, liveLandmarks, options = {}) {
  const config = { ...DEFAULTS, ...options };
  if (!Array.isArray(targetLandmarks) || !targetLandmarks.length) return invalid("target_missing");
  if (!Array.isArray(liveLandmarks) || !liveLandmarks.length) return invalid("live_missing");

  const targetVisible = CORE_LANDMARKS.filter(
    index => landmarkConfidence(targetLandmarks[index]) >= config.visibilityThreshold,
  );
  const shared = targetVisible.filter(
    index => landmarkConfidence(liveLandmarks[index]) >= config.visibilityThreshold,
  );
  const coverage = targetVisible.length ? shared.length / targetVisible.length : 0;

  if (shared.length < config.minimumSharedLandmarks) {
    return invalid("insufficient_landmarks", {
      shared_landmarks: shared.length,
      coverage,
    });
  }

  const edgeScores = [];
  for (const [start, end] of POSE_EDGES) {
    if (!shared.includes(start) || !shared.includes(end)) continue;
    const targetStart = targetLandmarks[start];
    const targetEnd = targetLandmarks[end];
    const liveStart = liveLandmarks[start];
    const liveEnd = liveLandmarks[end];
    const targetVector = {
      x: targetEnd.x - targetStart.x,
      y: targetEnd.y - targetStart.y,
    };
    const liveVector = {
      x: liveEnd.x - liveStart.x,
      y: liveEnd.y - liveStart.y,
    };
    const targetLength = Math.hypot(targetVector.x, targetVector.y);
    const liveLength = Math.hypot(liveVector.x, liveVector.y);
    if (targetLength < 1e-6 || liveLength < 1e-6) continue;
    const cosine = clamp(
      (targetVector.x * liveVector.x + targetVector.y * liveVector.y) /
        (targetLength * liveLength),
      -1,
      1,
    );
    const angle = Math.acos(cosine);
    const confidence = Math.min(
      landmarkConfidence(targetStart),
      landmarkConfidence(targetEnd),
      landmarkConfidence(liveStart),
      landmarkConfidence(liveEnd),
    );
    edgeScores.push({
      value: Math.exp(-0.5 * squared(angle / config.angleSigmaRadians)),
      weight: confidence,
    });
  }

  if (edgeScores.length < config.minimumPoseEdges) {
    return invalid("insufficient_pose_edges", {
      shared_landmarks: shared.length,
      pose_edges: edgeScores.length,
      coverage,
    });
  }

  const pose = weightedMean(edgeScores);
  const targetLayout = extractSubjectLayout(targetLandmarks, {
    indices: shared,
    visibilityThreshold: config.visibilityThreshold,
  });
  const liveLayout = extractSubjectLayout(liveLandmarks, {
    indices: shared,
    visibilityThreshold: config.visibilityThreshold,
  });
  const layout = compareSubjectLayouts(targetLayout, liveLayout, {
    centerSigma: config.centerSigma,
    sizeSigma: config.scaleSigma,
  });
  if (!layout.valid) return invalid("invalid_framing", { coverage, layout_reason: layout.reason });

  const framing = layout.similarity;
  const poseConfidence = weightedMean(shared.map(index => ({
    value: Math.min(
      landmarkConfidence(targetLandmarks[index]),
      landmarkConfidence(liveLandmarks[index]),
    ),
    weight: 1,
  }))) * coverage;
  const confidence = Math.min(poseConfidence, layout.confidence);

  if (confidence < config.minimumConfidence) {
    return invalid("low_confidence", {
      shared_landmarks: shared.length,
      coverage,
      confidence,
    });
  }

  const weightTotal = config.poseWeight + config.framingWeight;
  const match = (
    pose * config.poseWeight + framing * config.framingWeight
  ) / weightTotal;

  return {
    valid: true,
    metric_version: MATCH_METRIC_VERSION,
    coverage_class: layout.live.coverage_class,
    pose: clamp(pose, 0, 1),
    framing: clamp(framing, 0, 1),
    match: clamp(match, 0, 1),
    confidence: clamp(confidence, 0, 1),
    coverage,
    shared_landmarks: shared.length,
    pose_edges: edgeScores.length,
    placement: {
      delta_x: layout.deltas.center_x,
      delta_y: layout.deltas.center_y,
      scale_ratio: layout.deltas.height_ratio,
    },
    layout,
  };
}

export function matchBand(score) {
  if (!Number.isFinite(score)) return "unavailable";
  if (score >= 0.78) return "matched";
  if (score >= 0.55) return "close";
  return "adjusting";
}

function roundedScore(measurement) {
  if (!measurement) return null;
  return {
    pose: Math.round(measurement.pose * 100),
    framing: Math.round(measurement.framing * 100),
    match: Math.round(measurement.match * 100),
    confidence: Math.round(measurement.confidence * 100) / 100,
  };
}

export class MatchTracker {
  constructor({
    windowSize = 5,
    alpha = 0.3,
    baselineFrames = 3,
    matchHoldMs = 1000,
    missingGraceMs = 500,
  } = {}) {
    this.windowSize = windowSize;
    this.alpha = alpha;
    this.baselineFrames = baselineFrames;
    this.matchHoldMs = matchHoldMs;
    this.missingGraceMs = missingGraceMs;
    this.reset();
  }

  reset() {
    this.history = [];
    this.smoothed = null;
    this.baseline = null;
    this.baselineAt = null;
    this.peakMatch = null;
    this.matchedSince = null;
    this.timeToMatchMs = null;
    this.validFrames = 0;
    this.totalFrames = 0;
    this.coverageClass = null;
    this.lastValidAt = null;
    this.latestPlacement = null;
    this.latestLayout = null;
  }

  update(measurement, timestamp = Date.now()) {
    this.totalFrames += 1;
    if (!measurement?.valid) {
      if (
        this.smoothed &&
        this.lastValidAt !== null &&
        timestamp - this.lastValidAt <= this.missingGraceMs
      ) {
        return {
          valid: true,
          ...this.smoothed,
          band: matchBand(this.smoothed.match),
          stale: true,
          stale_reason: measurement?.reason,
        };
      }
      return measurement;
    }

    this.validFrames += 1;
    this.lastValidAt = timestamp;
    this.coverageClass = measurement.coverage_class;
    this.latestPlacement = measurement.placement ?? this.latestPlacement;
    this.latestLayout = measurement.layout ?? this.latestLayout;
    this.history.push(measurement);
    if (this.history.length > this.windowSize) this.history.shift();

    const filtered = {
      pose: median(this.history.map(item => item.pose)),
      framing: median(this.history.map(item => item.framing)),
      match: median(this.history.map(item => item.match)),
      confidence: median(this.history.map(item => item.confidence)),
    };
    this.smoothed = this.smoothed
      ? Object.fromEntries(Object.entries(filtered).map(([key, value]) => [
          key,
          this.alpha * value + (1 - this.alpha) * this.smoothed[key],
        ]))
      : filtered;

    if (!this.baseline && this.validFrames >= this.baselineFrames) {
      this.baseline = { ...this.smoothed };
      this.baselineAt = timestamp;
    }
    this.peakMatch = Math.max(this.peakMatch ?? 0, this.smoothed.match);

    if (this.smoothed.match >= 0.78) {
      this.matchedSince ??= timestamp;
      if (
        this.timeToMatchMs === null &&
        this.baselineAt !== null &&
        timestamp - this.matchedSince >= this.matchHoldMs
      ) {
        this.timeToMatchMs = timestamp - this.baselineAt;
      }
    } else {
      this.matchedSince = null;
    }

    return {
      ...measurement,
      ...this.smoothed,
      band: matchBand(this.smoothed.match),
    };
  }

  summary() {
    if (!this.smoothed) return null;
    const baseline = roundedScore(this.baseline);
    const final = roundedScore(this.smoothed);
    return {
      align_metric_version: MATCH_METRIC_VERSION,
      coverage_class: this.coverageClass,
      baseline,
      final,
      peak_match: Math.round((this.peakMatch ?? this.smoothed.match) * 100),
      match_gain: baseline ? final.match - baseline.match : null,
      time_to_match_ms: this.timeToMatchMs,
      valid_frame_ratio: this.totalFrames
        ? Math.round((this.validFrames / this.totalFrames) * 1000) / 1000
        : 0,
      final_placement: this.latestPlacement ? {
        delta_x: Math.round(this.latestPlacement.delta_x * 1000) / 1000,
        delta_y: Math.round(this.latestPlacement.delta_y * 1000) / 1000,
        scale_ratio: Math.round(this.latestPlacement.scale_ratio * 1000) / 1000,
      } : null,
      final_layout: summarizeSubjectLayoutComparison(this.latestLayout),
    };
  }
}
