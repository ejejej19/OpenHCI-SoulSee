// 火柴人骨架渲染 — 把 MediaPipe pose landmarks 畫成去像化的抽象幽靈。
// 輸入座標約定:已經過 mapLandmarksToCover 映射、再換算成像素的點
// ({ x, y, visibility? },以畫布像素為單位)。

import { POSE_LANDMARK } from "./pose-similarity.js";

const SKELETON_SEGMENTS = Object.freeze([
  [POSE_LANDMARK.LEFT_SHOULDER, POSE_LANDMARK.RIGHT_SHOULDER],
  [POSE_LANDMARK.LEFT_SHOULDER, POSE_LANDMARK.LEFT_ELBOW],
  [POSE_LANDMARK.LEFT_ELBOW, POSE_LANDMARK.LEFT_WRIST],
  [POSE_LANDMARK.RIGHT_SHOULDER, POSE_LANDMARK.RIGHT_ELBOW],
  [POSE_LANDMARK.RIGHT_ELBOW, POSE_LANDMARK.RIGHT_WRIST],
  [POSE_LANDMARK.LEFT_SHOULDER, POSE_LANDMARK.LEFT_HIP],
  [POSE_LANDMARK.RIGHT_SHOULDER, POSE_LANDMARK.RIGHT_HIP],
  [POSE_LANDMARK.LEFT_HIP, POSE_LANDMARK.RIGHT_HIP],
  [POSE_LANDMARK.LEFT_HIP, POSE_LANDMARK.LEFT_KNEE],
  [POSE_LANDMARK.LEFT_KNEE, POSE_LANDMARK.LEFT_ANKLE],
  [POSE_LANDMARK.RIGHT_HIP, POSE_LANDMARK.RIGHT_KNEE],
  [POSE_LANDMARK.RIGHT_KNEE, POSE_LANDMARK.RIGHT_ANKLE],
]);

const DEFAULT_VISIBILITY_MIN = 0.5;
const HEAD_RADIUS_SHOULDER_RATIO = 0.34;
const HEAD_RADIUS_MIN_PX = 10;

function usable(point, visibilityMin) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  return !Number.isFinite(point.visibility) || point.visibility >= visibilityMin;
}

export function skeletonGeometry(points, { visibilityMin = DEFAULT_VISIBILITY_MIN } = {}) {
  if (!Array.isArray(points)) return { segments: [], head: null };
  const ok = index => usable(points[index], visibilityMin);

  const segments = SKELETON_SEGMENTS
    .filter(([a, b]) => ok(a) && ok(b))
    .map(([a, b]) => [
      { x: points[a].x, y: points[a].y },
      { x: points[b].x, y: points[b].y },
    ]);

  let head = null;
  const nose = POSE_LANDMARK.NOSE;
  const ls = POSE_LANDMARK.LEFT_SHOULDER;
  const rs = POSE_LANDMARK.RIGHT_SHOULDER;
  if (ok(nose) && ok(ls) && ok(rs)) {
    const shoulderDistance = Math.hypot(points[ls].x - points[rs].x, points[ls].y - points[rs].y);
    head = {
      x: points[nose].x,
      y: points[nose].y,
      r: Math.max(HEAD_RADIUS_MIN_PX, shoulderDistance * HEAD_RADIUS_SHOULDER_RATIO),
    };
    const midShoulder = {
      x: (points[ls].x + points[rs].x) / 2,
      y: (points[ls].y + points[rs].y) / 2,
    };
    segments.push([{ x: head.x, y: head.y + head.r }, midShoulder]);
  }

  return { segments, head };
}

export function drawSkeleton(ctx, geometry, {
  color = "rgba(255,255,255,.92)",
  lineWidth = 6,
  glowColor = "rgba(255,255,255,.35)",
  glowBlur = 14,
} = {}) {
  if (!geometry) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  if (glowBlur > 0) {
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = glowBlur;
  }
  for (const [start, end] of geometry.segments) {
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
  }
  if (geometry.head) {
    ctx.beginPath();
    ctx.arc(geometry.head.x, geometry.head.y, geometry.head.r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}
