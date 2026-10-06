export const COMPOSITION_METRIC_VERSION = "composition-horizon-v1-heuristic";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function invalid(reason, details = {}) {
  return { valid: false, reason, metric_version: COMPOSITION_METRIC_VERSION, ...details };
}

function lumaAt(data, width, x, y) {
  const index = (y * width + x) * 4;
  return (
    0.2126 * data[index] +
    0.7152 * data[index + 1] +
    0.0722 * data[index + 2]
  ) / 255;
}

export function detectDominantHorizon(imageData, { minimumConfidence = 0.35 } = {}) {
  const { data, width, height } = imageData ?? {};
  if (!data || !Number.isInteger(width) || !Number.isInteger(height)) {
    return invalid("image_data_missing");
  }
  if (width < 24 || height < 24 || data.length < width * height * 4) {
    return invalid("image_too_small");
  }

  const firstRow = Math.max(2, Math.round(height * 0.12));
  const lastRow = Math.min(height - 3, Math.round(height * 0.88));
  const xStep = Math.max(1, Math.floor(width / 96));
  const rowScores = [];

  for (let y = firstRow; y <= lastRow; y += 1) {
    let score = 0;
    let count = 0;
    for (let x = 1; x < width - 1; x += xStep) {
      score += Math.abs(lumaAt(data, width, x, y + 1) - lumaAt(data, width, x, y - 1));
      count += 1;
    }
    rowScores.push({ y, score: count ? score / count : 0 });
  }

  const peak = rowScores.reduce((best, row) => row.score > best.score ? row : best, rowScores[0]);
  const meanScore = rowScores.reduce((sum, row) => sum + row.score, 0) / rowScores.length;
  if (!peak || peak.score < 0.025) return invalid("no_dominant_boundary");

  const searchRadius = Math.max(4, Math.round(height * 0.14));
  const points = [];
  for (let x = 1; x < width - 1; x += xStep) {
    let best = { y: peak.y, score: 0 };
    const start = Math.max(firstRow, peak.y - searchRadius);
    const end = Math.min(lastRow, peak.y + searchRadius);
    for (let y = start; y <= end; y += 1) {
      const score = Math.abs(lumaAt(data, width, x, y + 1) - lumaAt(data, width, x, y - 1));
      if (score > best.score) best = { y, score };
    }
    if (best.score >= Math.max(0.035, peak.score * 0.45)) points.push({ x, ...best });
  }

  if (points.length < 8) return invalid("boundary_too_sparse");
  const weightTotal = points.reduce((sum, point) => sum + point.score, 0);
  const meanX = points.reduce((sum, point) => sum + point.x * point.score, 0) / weightTotal;
  const meanY = points.reduce((sum, point) => sum + point.y * point.score, 0) / weightTotal;
  const covariance = points.reduce(
    (sum, point) => sum + point.score * (point.x - meanX) * (point.y - meanY),
    0,
  );
  const xVariance = points.reduce(
    (sum, point) => sum + point.score * (point.x - meanX) ** 2,
    0,
  );
  const slope = xVariance > 1e-6 ? covariance / xVariance : 0;
  const intercept = meanY - slope * meanX;
  const residual = Math.sqrt(points.reduce(
    (sum, point) => sum + point.score * (point.y - (intercept + slope * point.x)) ** 2,
    0,
  ) / weightTotal);
  const centerY = intercept + slope * (width - 1) / 2;
  const coverage = clamp(points.length / Math.ceil((width - 2) / xStep), 0, 1);
  const prominence = clamp((peak.score - meanScore) / Math.max(peak.score, 1e-6), 0, 1);
  const coherence = Math.exp(-0.5 * (residual / Math.max(2, height * 0.04)) ** 2);
  const confidence = Math.sqrt(prominence * coherence * coverage);

  if (confidence < minimumConfidence) {
    return invalid("low_confidence", { confidence });
  }

  return {
    valid: true,
    metric_version: COMPOSITION_METRIC_VERSION,
    horizon_y: clamp(centerY / (height - 1), 0, 1),
    roll_degrees: Math.atan(slope) * 180 / Math.PI,
    confidence: clamp(confidence, 0, 1),
    edge_strength: peak.score,
  };
}

export function placementInstruction(placement, { positionThreshold = 0.045, scaleThreshold = 0.1 } = {}) {
  if (!placement || !Number.isFinite(placement.delta_x) || !Number.isFinite(placement.delta_y)) {
    return { matched: false, text: null, reason: "placement_missing" };
  }

  if (Number.isFinite(placement.scale_ratio)) {
    if (placement.scale_ratio > 1 + scaleThreshold) return { matched: false, text: "再靠近一點", axis: "scale" };
    if (placement.scale_ratio < 1 - scaleThreshold) return { matched: false, text: "退後一點", axis: "scale" };
  }
  if (placement.delta_x > positionThreshold) return { matched: false, text: "人物往右", axis: "x" };
  if (placement.delta_x < -positionThreshold) return { matched: false, text: "人物往左", axis: "x" };
  if (placement.delta_y > positionThreshold) return { matched: false, text: "人物往下", axis: "y" };
  if (placement.delta_y < -positionThreshold) return { matched: false, text: "人物往上", axis: "y" };
  return { matched: true, text: "人物位置對上了", axis: null };
}

export function compareHorizons(target, current) {
  if (!target?.valid) return invalid("target_horizon_unavailable");
  if (!current?.valid) return invalid("current_horizon_unavailable");

  const heightDelta = target.horizon_y - current.horizon_y;
  const rollDelta = target.roll_degrees - current.roll_degrees;
  const heightScore = Math.exp(-0.5 * (heightDelta / 0.1) ** 2);
  const rollScore = Math.exp(-0.5 * (rollDelta / 6) ** 2);
  const score = Math.sqrt(heightScore * rollScore);
  let instruction = "構圖線對上了";
  if (Math.abs(rollDelta) > 3) instruction = `旋轉手機 ${Math.round(Math.abs(rollDelta))}° 對齊藍線`;
  else if (heightDelta > 0.05) instruction = "鏡頭再往上";
  else if (heightDelta < -0.05) instruction = "鏡頭再往下";

  return {
    valid: true,
    metric_version: COMPOSITION_METRIC_VERSION,
    score: clamp(score, 0, 1),
    height_delta: heightDelta,
    roll_delta_degrees: rollDelta,
    instruction,
    confidence: Math.min(target.confidence, current.confidence),
  };
}

export function levelInstruction(orientation, { threshold = 2.5 } = {}) {
  if (!orientation?.valid || !Number.isFinite(orientation.roll_degrees)) return null;
  if (Math.abs(orientation.roll_degrees) <= threshold) return "手機已水平";
  return `手機再轉正 ${Math.round(Math.abs(orientation.roll_degrees))}°`;
}
