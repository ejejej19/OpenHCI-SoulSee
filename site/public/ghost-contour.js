// 描邊幽靈 — 從提案影像抽邊緣線,保留輪廓、衣服線條與交疊處的立體線索,
// 但不保留膚質與色彩。資訊量介於火柴人骨架與完整照片之間。
//
// 火柴人只有關節連線:沒有表情、沒有輪廓、沒有立體感。
// 描邊留下這些線索,又不會產生一張「更好看的我」可供比較。

const DEFAULT_OPTIONS = Object.freeze({
  blurRadius: 1,
  threshold: 34,
  lineAlpha: 0.95,
});

const EXPRESSION_LANDMARKS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 9, 10]);
const LEFT_EAR = 7;
const RIGHT_EAR = 8;
const LEFT_SHOULDER = 11;
const RIGHT_SHOULDER = 12;

function usablePoint(point, visibilityMin) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  return !Number.isFinite(point.visibility) || point.visibility >= visibilityMin;
}

function pointDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// MediaPipe Pose 的臉部點只涵蓋眼、鼻、嘴與耳朵。這裡以五官範圍為核心，
// 留出少量邊界，讓「表情」模式保留五官線條，而「肢體」模式仍保有頭髮與頭部外輪廓。
export function expressionRegionFromPose(points, {
  visibilityMin = 0.35,
  minimumRadius = 4,
} = {}) {
  if (!Array.isArray(points)) return null;
  const features = EXPRESSION_LANDMARKS
    .map(index => points[index])
    .filter(point => usablePoint(point, visibilityMin));
  if (features.length < 3) return null;

  const xs = features.map(point => point.x);
  const ys = features.map(point => point.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const featureWidth = maxX - minX;
  const featureHeight = maxY - minY;

  const leftEar = points[LEFT_EAR], rightEar = points[RIGHT_EAR];
  const leftShoulder = points[LEFT_SHOULDER], rightShoulder = points[RIGHT_SHOULDER];
  const earWidth = usablePoint(leftEar, visibilityMin) && usablePoint(rightEar, visibilityMin)
    ? pointDistance(leftEar, rightEar)
    : 0;
  const shoulderWidth = usablePoint(leftShoulder, visibilityMin) && usablePoint(rightShoulder, visibilityMin)
    ? pointDistance(leftShoulder, rightShoulder) * 0.42
    : 0;
  const referenceWidth = Math.max(featureWidth * 1.25, featureHeight * 1.7, earWidth, shoulderWidth);
  if (!Number.isFinite(referenceWidth) || referenceWidth <= 0) return null;

  return {
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2 + referenceWidth * 0.03,
    radiusX: Math.max(minimumRadius, featureWidth * 0.62, referenceWidth * 0.34),
    radiusY: Math.max(minimumRadius, featureHeight * 0.8, referenceWidth * 0.42),
  };
}

function validRegion(region) {
  return region &&
    Number.isFinite(region.centerX) && Number.isFinite(region.centerY) &&
    Number.isFinite(region.radiusX) && region.radiusX > 0 &&
    Number.isFinite(region.radiusY) && region.radiusY > 0;
}

function insideRegion(x, y, region) {
  const dx = (x - region.centerX) / region.radiusX;
  const dy = (y - region.centerY) / region.radiusY;
  return dx * dx + dy * dy <= 1;
}

function toGrayscale(data, width, height) {
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return gray;
}

// 盒狀模糊,壓掉雜訊邊,避免整張圖佈滿細碎線條
function blur(gray, width, height, radius) {
  if (radius <= 0) return gray;
  const out = new Float32Array(gray.length);
  const span = radius * 2 + 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          sum += gray[yy * width + xx];
          count++;
        }
      }
      out[y * width + x] = sum / (count || span * span);
    }
  }
  return out;
}

const SOBEL_X = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
const SOBEL_Y = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

export function contourImageData(sourceImageData, options = {}) {
  const {
    blurRadius,
    threshold,
    lineAlpha,
    region = 'all',
    expressionRegion = null,
  } = { ...DEFAULT_OPTIONS, ...options };
  const { width, height, data } = sourceImageData;
  if (!width || !height) return null;

  const maskEnabled = region !== 'all' && validRegion(expressionRegion);

  const gray = blur(toGrayscale(data, width, height), width, height, blurRadius);
  const out = new Uint8ClampedArray(width * height * 4);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let gx = 0;
      let gy = 0;
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++, k++) {
          const value = gray[(y + dy) * width + (x + dx)];
          gx += value * SOBEL_X[k];
          gy += value * SOBEL_Y[k];
        }
      }
      const magnitude = Math.hypot(gx, gy);
      if (magnitude < threshold) continue;
      if (maskEnabled) {
        const insideExpression = insideRegion(x, y, expressionRegion);
        if (region === 'face' && !insideExpression) continue;
        if (region === 'body' && insideExpression) continue;
      }
      // 邊越強線越實,保留強弱層次讓輪廓與細節有分別
      const strength = Math.min(1, (magnitude - threshold) / (threshold * 2));
      const p = (y * width + x) * 4;
      out[p] = 255;
      out[p + 1] = 255;
      out[p + 2] = 255;
      out[p + 3] = Math.round(255 * lineAlpha * (0.35 + 0.65 * strength));
    }
  }

  return new ImageData(out, width, height);
}

// 以 object-fit: cover 的方式把來源影像畫進畫布,再就地轉成描邊
export function drawContour(canvas, sourceImage, { mirrored = false, ...options } = {}) {
  const width = canvas.width;
  const height = canvas.height;
  const naturalWidth = sourceImage.naturalWidth || sourceImage.width;
  const naturalHeight = sourceImage.naturalHeight || sourceImage.height;
  if (!width || !height || !naturalWidth || !naturalHeight) return false;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const scale = Math.max(width / naturalWidth, height / naturalHeight);
  const drawWidth = naturalWidth * scale;
  const drawHeight = naturalHeight * scale;

  ctx.save();
  if (mirrored) {
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(sourceImage, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  ctx.restore();

  const contour = contourImageData(ctx.getImageData(0, 0, width, height), options);
  ctx.clearRect(0, 0, width, height);
  if (!contour) return false;
  ctx.putImageData(contour, 0, 0);
  return true;
}
