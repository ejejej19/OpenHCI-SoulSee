export const INTENT_METRIC_VERSION = "observable-intent-v1";

export const INTENT_DIMENSIONS = Object.freeze([
  Object.freeze({ id: "pose", label: "姿勢" }),
  Object.freeze({ id: "placement", label: "人物位置" }),
  Object.freeze({ id: "composition", label: "構圖" }),
  Object.freeze({ id: "look", label: "色調" }),
]);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function observableIntentBand(score) {
  if (!Number.isFinite(score)) return "unavailable";
  if (score >= 0.78) return "aligned";
  if (score >= 0.55) return "partial";
  return "drifted";
}

export function observableIntentBandLabel(band) {
  return {
    aligned: "接近原始意圖",
    partial: "部分偏離",
    drifted: "明顯偏離",
    unavailable: "資料不足",
  }[band] ?? "資料不足";
}

function normalizeDimension(spec, input, minimumConfidence) {
  const score = input?.score;
  const confidence = Number.isFinite(input?.confidence) ? input.confidence : 0;
  const available = Number.isFinite(score) && confidence >= minimumConfidence;
  const normalizedScore = available ? clamp(score, 0, 1) : null;
  const band = observableIntentBand(normalizedScore);
  return {
    ...spec,
    available,
    score: normalizedScore,
    confidence: Number.isFinite(confidence) ? clamp(confidence, 0, 1) : 0,
    band,
    label_text: observableIntentBandLabel(band),
    reason: available ? null : input?.reason ?? "not_measured",
  };
}

export function buildIntentReceipt({
  prompt = "",
  pose,
  placement,
  composition,
  look,
  minimumConfidence = 0.45,
} = {}) {
  const inputs = { pose, placement, composition, look };
  const dimensions = INTENT_DIMENSIONS.map(spec => (
    normalizeDimension(spec, inputs[spec.id], minimumConfidence)
  ));
  const measured = dimensions.filter(dimension => dimension.available);
  const observableScore = measured.length >= 2
    ? measured.reduce((sum, dimension) => sum + dimension.score, 0) / measured.length
    : null;
  const band = observableIntentBand(observableScore);

  return {
    valid: measured.length >= 2,
    metric_version: INTENT_METRIC_VERSION,
    original_intent: prompt.trim() || "未填寫風格偏好",
    observable_score: observableScore,
    observable_drift: observableScore === null ? null : 1 - observableScore,
    band,
    band_label: observableIntentBandLabel(band),
    coverage: {
      measured: measured.length,
      total: INTENT_DIMENSIONS.length,
    },
    dimensions,
    requires_user_judgment: true,
  };
}

export function normalizeIntentJudgment(value) {
  return ["aligned", "partial", "not_aligned"].includes(value) ? value : null;
}

export function formatIntentDimensionEvidence(dimension) {
  if (!dimension?.available) return "未量測";
  const confidence = clamp(Number.isFinite(dimension.confidence) ? dimension.confidence : 0, 0, 1);
  return `${dimension.label_text} · 信心 ${Math.round(confidence * 100)}%`;
}
