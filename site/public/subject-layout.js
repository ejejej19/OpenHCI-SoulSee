export const SUBJECT_LAYOUT_METRIC_VERSION = "subject-layout-v1-uncalibrated";

const LANDMARK = Object.freeze({
  FACE_START: 0,
  FACE_END: 10,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
});

const DEFAULTS = Object.freeze({
  visibilityThreshold: 0.6,
  centerSigma: 0.12,
  headCenterSigma: 0.1,
  sizeSigma: 0.25,
  marginSigma: 0.08,
});

const FEATURE_WEIGHTS = Object.freeze({
  center: 0.2,
  head_center: 0.15,
  size: 0.25,
  headroom: 0.1,
  footroom: 0.1,
  edges: 0.2,
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const squared = value => value * value;
const round = value => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;

export function landmarkConfidence(landmark) {
  if (!landmark) return 0;
  const visibility = Number.isFinite(landmark.visibility) ? landmark.visibility : 1;
  const presence = Number.isFinite(landmark.presence) ? landmark.presence : 1;
  return clamp(Math.min(visibility, presence), 0, 1);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function pointMean(points) {
  if (!points.length) return null;
  return {
    x: mean(points.map(point => point.x)),
    y: mean(points.map(point => point.y)),
  };
}

function coverageClass(visibleIndices) {
  const visible = index => visibleIndices.includes(index);
  if (visible(LANDMARK.LEFT_ANKLE) && visible(LANDMARK.RIGHT_ANKLE)) return "full_body";
  if (visible(LANDMARK.LEFT_KNEE) || visible(LANDMARK.RIGHT_KNEE)) return "three_quarter";
  if (
    visible(LANDMARK.LEFT_SHOULDER) &&
    visible(LANDMARK.RIGHT_SHOULDER) &&
    (visible(LANDMARK.LEFT_HIP) || visible(LANDMARK.RIGHT_HIP))
  ) return "upper_body";
  return "insufficient";
}

function invalid(reason, details = {}) {
  return {
    valid: false,
    metric_version: SUBJECT_LAYOUT_METRIC_VERSION,
    reason,
    ...details,
  };
}

export function extractSubjectLayout(landmarks, {
  indices,
  visibilityThreshold = DEFAULTS.visibilityThreshold,
} = {}) {
  if (!Array.isArray(landmarks) || !landmarks.length) return invalid("landmarks_missing");
  const candidateIndices = Array.isArray(indices)
    ? [...new Set(indices)]
    : landmarks.map((_, index) => index);
  const visibleIndices = candidateIndices.filter(index => (
    Number.isInteger(index) &&
    Number.isFinite(landmarks[index]?.x) &&
    Number.isFinite(landmarks[index]?.y) &&
    landmarkConfidence(landmarks[index]) >= visibilityThreshold
  ));
  const hasShoulder = visibleIndices.some(index => (
    index === LANDMARK.LEFT_SHOULDER || index === LANDMARK.RIGHT_SHOULDER
  ));
  const hasHip = visibleIndices.some(index => (
    index === LANDMARK.LEFT_HIP || index === LANDMARK.RIGHT_HIP
  ));
  if (visibleIndices.length < 3 || !hasShoulder || !hasHip) {
    return invalid("layout_landmarks_insufficient", { visible_landmarks: visibleIndices.length });
  }

  const points = visibleIndices.map(index => landmarks[index]);
  const rawLeft = Math.min(...points.map(point => point.x));
  const rawRight = Math.max(...points.map(point => point.x));
  const rawTop = Math.min(...points.map(point => point.y));
  const rawBottom = Math.max(...points.map(point => point.y));
  const rawWidth = rawRight - rawLeft;
  const leftShoulder = landmarks[LANDMARK.LEFT_SHOULDER];
  const rightShoulder = landmarks[LANDMARK.RIGHT_SHOULDER];
  const shouldersVisible = visibleIndices.includes(LANDMARK.LEFT_SHOULDER) &&
    visibleIndices.includes(LANDMARK.RIGHT_SHOULDER);
  const shoulderWidth = shouldersVisible
    ? Math.hypot(rightShoulder.x - leftShoulder.x, rightShoulder.y - leftShoulder.y)
    : rawWidth * 0.4;
  const faceIndices = visibleIndices.filter(index => (
    index >= LANDMARK.FACE_START && index <= LANDMARK.FACE_END
  ));
  const facePoints = faceIndices.map(index => landmarks[index]);
  const framingClass = coverageClass(visibleIndices);
  const fullBody = framingClass === "full_body";

  const left = clamp(rawLeft - shoulderWidth * 0.12, 0, 1);
  const right = clamp(rawRight + shoulderWidth * 0.12, 0, 1);
  const top = clamp(rawTop - (facePoints.length ? shoulderWidth * 0.35 : 0), 0, 1);
  const bottom = clamp(rawBottom + (fullBody ? shoulderWidth * 0.08 : 0), 0, 1);
  const width = right - left;
  const height = bottom - top;
  if (width < 1e-6 || height < 1e-6) {
    return invalid("layout_bounds_invalid", { visible_landmarks: visibleIndices.length });
  }

  return {
    valid: true,
    metric_version: SUBJECT_LAYOUT_METRIC_VERSION,
    basis: "pose_landmark_envelope",
    calibrated: false,
    coverage_class: framingClass,
    visible_landmarks: visibleIndices.length,
    confidence: mean(visibleIndices.map(index => landmarkConfidence(landmarks[index]))),
    center: {
      x: clamp((rawLeft + rawRight) / 2, 0, 1),
      y: clamp((rawTop + rawBottom) / 2, 0, 1),
    },
    head_center: pointMean(facePoints),
    width,
    height,
    area_ratio: width * height,
    headroom: facePoints.length ? top : null,
    footroom: fullBody ? 1 - bottom : null,
    left_clearance: left,
    right_clearance: 1 - right,
    clipped: {
      top: rawTop < 0 || top === 0,
      right: rawRight > 1 || right === 1,
      bottom: rawBottom > 1 || bottom === 1,
      left: rawLeft < 0 || left === 0,
    },
  };
}

function gaussianSimilarity(error, sigma) {
  return Math.exp(-0.5 * squared(error / sigma));
}

function ratioSimilarity(target, live, sigma) {
  if (!(target > 0) || !(live > 0)) return 0;
  return gaussianSimilarity(Math.abs(Math.log(live / target)), sigma);
}

function feature(value, weight, details = {}) {
  return { available: true, similarity: clamp(value, 0, 1), weight, ...details };
}

export function compareSubjectLayouts(target, live, options = {}) {
  const config = { ...DEFAULTS, ...options };
  if (!target?.valid) return invalid(target?.reason || "target_layout_missing");
  if (!live?.valid) return invalid(live?.reason || "live_layout_missing");

  const centerDelta = {
    x: target.center.x - live.center.x,
    y: target.center.y - live.center.y,
  };
  const features = {
    center: feature(
      gaussianSimilarity(Math.hypot(centerDelta.x, centerDelta.y) / Math.SQRT2, config.centerSigma),
      FEATURE_WEIGHTS.center,
      { delta_x: centerDelta.x, delta_y: centerDelta.y },
    ),
    size: feature(
      Math.sqrt(
        ratioSimilarity(target.width, live.width, config.sizeSigma) *
        ratioSimilarity(target.height, live.height, config.sizeSigma)
      ),
      FEATURE_WEIGHTS.size,
      {
        width_ratio: target.width / live.width,
        height_ratio: target.height / live.height,
        area_ratio: target.area_ratio / live.area_ratio,
      },
    ),
    edges: feature(
      gaussianSimilarity(
        Math.hypot(
          target.left_clearance - live.left_clearance,
          target.right_clearance - live.right_clearance,
        ) / Math.SQRT2,
        config.marginSigma,
      ),
      FEATURE_WEIGHTS.edges,
      {
        left_delta: target.left_clearance - live.left_clearance,
        right_delta: target.right_clearance - live.right_clearance,
      },
    ),
  };

  if (target.head_center && live.head_center) {
    const deltaX = target.head_center.x - live.head_center.x;
    const deltaY = target.head_center.y - live.head_center.y;
    features.head_center = feature(
      gaussianSimilarity(Math.hypot(deltaX, deltaY) / Math.SQRT2, config.headCenterSigma),
      FEATURE_WEIGHTS.head_center,
      { delta_x: deltaX, delta_y: deltaY },
    );
  }
  if (Number.isFinite(target.headroom) && Number.isFinite(live.headroom)) {
    const delta = target.headroom - live.headroom;
    features.headroom = feature(
      gaussianSimilarity(Math.abs(delta), config.marginSigma),
      FEATURE_WEIGHTS.headroom,
      { delta },
    );
  }
  if (Number.isFinite(target.footroom) && Number.isFinite(live.footroom)) {
    const delta = target.footroom - live.footroom;
    features.footroom = feature(
      gaussianSimilarity(Math.abs(delta), config.marginSigma),
      FEATURE_WEIGHTS.footroom,
      { delta },
    );
  }

  const measured = Object.entries(features);
  const measuredWeight = measured.reduce((sum, [, entry]) => sum + entry.weight, 0);
  const totalWeight = Object.values(FEATURE_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
  const similarity = measured.reduce(
    (sum, [, entry]) => sum + entry.similarity * entry.weight,
    0,
  ) / measuredWeight;
  const featureCoverage = measuredWeight / totalWeight;

  return {
    valid: true,
    metric_version: SUBJECT_LAYOUT_METRIC_VERSION,
    calibrated: false,
    similarity: clamp(similarity, 0, 1),
    confidence: Math.min(target.confidence, live.confidence) * featureCoverage,
    feature_coverage: featureCoverage,
    measured_features: measured.map(([name]) => name),
    features,
    target,
    live,
    deltas: {
      center_x: centerDelta.x,
      center_y: centerDelta.y,
      head_center_x: features.head_center?.delta_x ?? null,
      head_center_y: features.head_center?.delta_y ?? null,
      width_ratio: features.size.width_ratio,
      height_ratio: features.size.height_ratio,
      area_ratio: features.size.area_ratio,
      headroom: features.headroom?.delta ?? null,
      footroom: features.footroom?.delta ?? null,
      left_clearance: features.edges.left_delta,
      right_clearance: features.edges.right_delta,
    },
  };
}

function compactLayout(layout) {
  if (!layout?.valid) return null;
  return {
    coverage_class: layout.coverage_class,
    visible_landmarks: layout.visible_landmarks,
    confidence: round(layout.confidence),
    center: { x: round(layout.center.x), y: round(layout.center.y) },
    head_center: layout.head_center
      ? { x: round(layout.head_center.x), y: round(layout.head_center.y) }
      : null,
    width: round(layout.width),
    height: round(layout.height),
    area_ratio: round(layout.area_ratio),
    headroom: round(layout.headroom),
    footroom: round(layout.footroom),
    left_clearance: round(layout.left_clearance),
    right_clearance: round(layout.right_clearance),
    clipped: layout.clipped,
  };
}

export function summarizeSubjectLayoutComparison(comparison) {
  if (!comparison?.valid) return null;
  return {
    metric_version: comparison.metric_version,
    calibrated: false,
    similarity: round(comparison.similarity),
    confidence: round(comparison.confidence),
    feature_coverage: round(comparison.feature_coverage),
    measured_features: comparison.measured_features,
    deltas: Object.fromEntries(
      Object.entries(comparison.deltas).map(([key, value]) => [key, round(value)]),
    ),
    target: compactLayout(comparison.target),
    live: compactLayout(comparison.live),
  };
}
