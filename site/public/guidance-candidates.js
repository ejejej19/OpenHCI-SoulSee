export const GUIDANCE_CANDIDATE_VERSION = "guidance-candidates-v1";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function candidate({ id, dimension, severity, confidence, text, reason }) {
  return {
    candidate_version: GUIDANCE_CANDIDATE_VERSION,
    id,
    dimension,
    severity: clamp(severity, 0, 1),
    confidence: clamp(Number.isFinite(confidence) ? confidence : 0, 0, 1),
    text,
    reason,
  };
}

function addPlacementCandidates(candidates, alignment) {
  if (!alignment?.valid) return;
  const confidence = alignment.confidence;
  const placement = alignment.placement;
  const layout = alignment.layout;

  if (Number.isFinite(placement?.scale_ratio)) {
    const scaleError = Math.abs(Math.log(placement.scale_ratio));
    if (scaleError > Math.log(1.1)) {
      const needsCloser = placement.scale_ratio > 1;
      candidates.push(candidate({
        id: "subject-scale",
        dimension: "subject_scale",
        severity: scaleError / Math.log(1.6),
        confidence,
        text: needsCloser
          ? "攝影者再靠近一點，讓人物大小更接近參考構圖。"
          : "攝影者退後一點，讓人物大小更接近參考構圖。",
        reason: needsCloser ? "人物在畫面中比參考小" : "人物在畫面中比參考大",
      }));
    }
  }

  if (Number.isFinite(placement?.delta_x) && Math.abs(placement.delta_x) > 0.045) {
    const moveRight = placement.delta_x > 0;
    candidates.push(candidate({
      id: "subject-center-x",
      dimension: "subject_position",
      severity: Math.abs(placement.delta_x) / 0.2,
      confidence,
      text: moveRight
        ? "讓人物往右一些，使人物中心接近參考位置。"
        : "讓人物往左一些，使人物中心接近參考位置。",
      reason: moveRight ? "人物中心比參考偏左" : "人物中心比參考偏右",
    }));
  }

  if (Number.isFinite(placement?.delta_y) && Math.abs(placement.delta_y) > 0.045) {
    const moveDown = placement.delta_y > 0;
    candidates.push(candidate({
      id: "subject-center-y",
      dimension: "subject_position",
      severity: Math.abs(placement.delta_y) / 0.2,
      confidence,
      text: moveDown
        ? "讓人物往下一些，使人物中心接近參考位置。"
        : "讓人物往上一些，使人物中心接近參考位置。",
      reason: moveDown ? "人物中心比參考偏上" : "人物中心比參考偏下",
    }));
  }

  const deltas = layout?.deltas;
  const topClipped = layout?.target?.clipped?.top || layout?.live?.clipped?.top;
  if (!topClipped && Number.isFinite(deltas?.headroom) && Math.abs(deltas.headroom) > 0.05) {
    const needsMore = deltas.headroom > 0;
    candidates.push(candidate({
      id: "subject-headroom",
      dimension: "headroom",
      severity: Math.abs(deltas.headroom) / 0.15,
      confidence: Math.min(confidence, layout.confidence),
      text: needsMore
        ? "鏡頭稍微往上，增加人物頭頂留白以接近參考。"
        : "鏡頭稍微往下，減少人物頭頂留白以接近參考。",
      reason: needsMore ? "頭頂留白比參考少" : "頭頂留白比參考多",
    }));
  }

  const bottomClipped = layout?.target?.clipped?.bottom || layout?.live?.clipped?.bottom;
  if (!bottomClipped && Number.isFinite(deltas?.footroom) && Math.abs(deltas.footroom) > 0.05) {
    const needsMore = deltas.footroom > 0;
    candidates.push(candidate({
      id: "subject-footroom",
      dimension: "footroom",
      severity: Math.abs(deltas.footroom) / 0.15,
      confidence: Math.min(confidence, layout.confidence),
      text: needsMore
        ? "鏡頭稍微往下，增加人物腳底留白以接近參考。"
        : "鏡頭稍微往上，減少人物腳底留白以接近參考。",
      reason: needsMore ? "腳底留白比參考少" : "腳底留白比參考多",
    }));
  }
}

function addCompositionCandidate(candidates, composition) {
  if (!composition?.valid || composition.score >= 0.78) return;
  if (Math.abs(composition.roll_delta_degrees) > 3) {
    candidates.push(candidate({
      id: "composition-roll",
      dimension: "camera_roll",
      severity: Math.abs(composition.roll_delta_degrees) / 15,
      confidence: composition.confidence,
      text: `旋轉手機 ${Math.round(Math.abs(composition.roll_delta_degrees))}° 對齊藍線，讓畫面角度接近參考。`,
      reason: "主要水平線角度與參考不同",
    }));
    return;
  }
  if (Math.abs(composition.height_delta) > 0.05) {
    const moveUp = composition.height_delta > 0;
    candidates.push(candidate({
      id: "composition-horizon-height",
      dimension: "horizon_height",
      severity: Math.abs(composition.height_delta) / 0.2,
      confidence: composition.confidence,
      text: moveUp
        ? "鏡頭再往上，讓主要水平線高度接近參考。"
        : "鏡頭再往下，讓主要水平線高度接近參考。",
      reason: moveUp ? "主要水平線比參考偏上" : "主要水平線比參考偏下",
    }));
  }
}

function addOrientationCandidate(candidates, orientation, targetComposition, composition) {
  if (
    !orientation?.valid ||
    !Number.isFinite(orientation.roll_degrees) ||
    Math.abs(orientation.roll_degrees) <= 2.5 ||
    !targetComposition?.valid ||
    Math.abs(targetComposition.roll_degrees) > 5 ||
    (composition?.valid && composition.score < 0.78)
  ) return;
  candidates.push(candidate({
    id: "device-level",
    dimension: "device_roll",
    severity: Math.abs(orientation.roll_degrees) / 12,
    confidence: orientation.confidence,
    text: `手機再轉正 ${Math.round(Math.abs(orientation.roll_degrees))}°，讓畫面保持水平。`,
    reason: "裝置目前有左右傾斜",
  }));
}

export function buildGuidanceCandidates({
  alignment,
  composition,
  orientation,
  targetComposition,
} = {}) {
  const candidates = [];
  addPlacementCandidates(candidates, alignment);
  addCompositionCandidate(candidates, composition);
  addOrientationCandidate(candidates, orientation, targetComposition, composition);
  return candidates;
}
