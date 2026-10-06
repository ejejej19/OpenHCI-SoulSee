import { CameraController } from '/camera-controller.js';
import {
  EFFECT_PRESETS,
  FILTER_PRESETS,
  applyPreviewLook,
  cameraLookLabel,
  renderCameraFrame,
  resolveCameraLook,
} from '/camera-effects.js';
import { PoseAlignmentController } from '/pose-alignment-controller.js';
import { matchBand, mapLandmarksToCover, MATCH_METRIC_VERSION } from '/pose-similarity.js';
import { skeletonGeometry, drawSkeleton } from '/ghost-skeleton.js';
import { drawContour, expressionRegionFromPose } from '/ghost-contour.js';

/* ── 設定 ──
   同一套引擎服務多個介面(/play 調參版、/cuts 展場版)。
   介面沒有的控制項一律視為「不存在即用預設值」,引擎邏輯不分支。
   預設值可由 <body data-model / data-strategy / data-ghost-form /
   data-log-key / data-camera-facing> 指定。功能與 prompt 與 /play 完全相同。 */
const config = document.body.dataset;
const LOG_KEY = config.logKey || 'play_log';
const DEFAULT_CAMERA_FACING = config.cameraFacing === 'user' ? 'user' : 'environment';
const LIVE_PHOTO_ENABLED = config.livePhoto === 'true';

const keyEl = document.getElementById('key');
const stylePromptEl = document.getElementById('stylePrompt');
if (keyEl) {
  keyEl.value = localStorage.getItem('gemini_key') || '';
  keyEl.onchange = () => localStorage.setItem('gemini_key', keyEl.value.trim());
}

const video = document.getElementById('cam'), ghost = document.getElementById('ghost');
const stage = document.getElementById('stage');
const skeletonCanvas = document.getElementById('ghostSkeleton');
const cameraEffect = document.getElementById('cameraEffect');
const formSelect = document.getElementById('formSelect');
const filterSelect = document.getElementById('filterSelect');
const effectSelect = document.getElementById('effectSelect');
const opEl = document.getElementById('op');
const meter = document.getElementById('meter');
const matchState = document.getElementById('matchState');
const poseState = document.getElementById('poseState');
const frameState = document.getElementById('frameState');
const result = document.getElementById('result');
const statusEl = document.getElementById('status');
let ghostReady = false, alignmentController, ghostGenerationEpoch = 0;
let log = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
const setStatus = s => { if (statusEl) statusEl.textContent = s; };

const FORM_LABEL = {
  contour: '描邊',
  'face-contour': '只有表情描邊',
  'body-contour': '只有肢體輪廓沒有表情',
  stick: '火柴人',
  hybrid: '照片+骨架',
  photo: '照片',
};
const CONTOUR_REGION = {
  contour: 'all',
  'face-contour': 'face',
  'body-contour': 'body',
};
const DEFAULT_FORM = 'contour';
let ghostForm = formSelect
  ? (localStorage.getItem('ghost_form') || DEFAULT_FORM)
  : (config.ghostForm || DEFAULT_FORM);
if (!FORM_LABEL[ghostForm]) ghostForm = DEFAULT_FORM;
if (formSelect) formSelect.value = ghostForm;

const strategySelect = document.getElementById('strategySelect');
const reasonEl = document.getElementById('reason');
const STRATEGY_LABEL = {
  'together': '圖+文一次',
  'image-then-text': '先圖後文',
  'text-then-image': '先文後圖',
};
// 預設走「先圖後文」:實測影像模型在被要求生圖的那次呼叫不會回文字,
// 只有把圖當輸入、單純要文字的呼叫才拿得到情境。
const DEFAULT_STRATEGY = 'image-then-text';
// 一次性遷移:先前預設是 together,測試者手機裡存的舊偏好會讓他們永遠看不到文字。
if (!localStorage.getItem('strategy_migrated_v2')) {
  if (localStorage.getItem('suggest_strategy') === 'together') localStorage.removeItem('suggest_strategy');
  localStorage.setItem('strategy_migrated_v2', '1');
}
let suggestStrategy = strategySelect
  ? (localStorage.getItem('suggest_strategy') || DEFAULT_STRATEGY)
  : (config.strategy || DEFAULT_STRATEGY);
if (!STRATEGY_LABEL[suggestStrategy]) suggestStrategy = DEFAULT_STRATEGY;
if (strategySelect) {
  strategySelect.value = suggestStrategy;
  strategySelect.onchange = () => {
    suggestStrategy = strategySelect.value;
    localStorage.setItem('suggest_strategy', suggestStrategy);
    setStatus(`建議策略:${STRATEGY_LABEL[suggestStrategy]}`);
  };
}
if (reasonEl) reasonEl.onclick = () => { reasonEl.hidden = true; };

const modelSelect = document.getElementById('modelSelect');
const MODEL_LABEL = {
  'gemini-3.1-flash-image': '3.1',
  'gemini-3.1-flash-lite-image': '3.1 Lite',
  'gemini-2.5-flash-image': '2.5',
};
let ghostModel = modelSelect
  ? (localStorage.getItem('ghost_model') || 'gemini-3.1-flash-image')
  : (config.model || 'gemini-3.1-flash-image');
if (!MODEL_LABEL[ghostModel]) ghostModel = 'gemini-3.1-flash-image';
if (modelSelect) {
  modelSelect.value = ghostModel;
  modelSelect.onchange = () => {
    ghostModel = modelSelect.value;
    localStorage.setItem('ghost_model', ghostModel);
    setStatus(`模型:${MODEL_LABEL[ghostModel]}`);
  };
}

function showReason(text, strategy) {
  if (!reasonEl) return;
  if (!text) { reasonEl.hidden = true; return; }
  reasonEl.textContent = text;
  if (strategySelect) {
    const hint = document.createElement('small');
    hint.textContent = `策略:${STRATEGY_LABEL[strategy]}(點一下收起)`;
    reasonEl.append(hint);
  }
  reasonEl.hidden = false;
}

function storedCameraLook() {
  try {
    return resolveCameraLook(JSON.parse(localStorage.getItem('camera_look') || '{}'));
  } catch {
    return resolveCameraLook();
  }
}

function fillPresetSelect(select, presets) {
  const groups = new Map();
  for (const preset of presets) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.label;
    if (!preset.group) {
      select.append(option);
      continue;
    }
    if (!groups.has(preset.group)) {
      const group = document.createElement('optgroup');
      group.label = preset.group;
      groups.set(preset.group, group);
      select.append(group);
    }
    groups.get(preset.group).append(option);
  }
}

if (filterSelect) fillPresetSelect(filterSelect, FILTER_PRESETS);
if (effectSelect) fillPresetSelect(effectSelect, EFFECT_PRESETS);
let cameraLook = storedCameraLook();

function setCameraLook(nextLook, { announce = true } = {}) {
  cameraLook = applyPreviewLook(video, cameraEffect, nextLook);
  if (filterSelect) filterSelect.value = cameraLook.filter;
  if (effectSelect) effectSelect.value = cameraLook.effect;
  localStorage.setItem('camera_look', JSON.stringify(cameraLook));
  if (announce) setStatus(`相機效果:${cameraLookLabel(cameraLook)}`);
}

if (filterSelect) filterSelect.onchange = () => setCameraLook({ ...cameraLook, filter: filterSelect.value });
if (effectSelect) effectSelect.onchange = () => setCameraLook({ ...cameraLook, effect: effectSelect.value });
const resetLookBtn = document.getElementById('resetLook');
if (resetLookBtn) resetLookBtn.onclick = () => setCameraLook();
setCameraLook(cameraLook, { announce: false });

const BAND_TEXT = {
  adjusting: '調整中',
  close: '接近',
  matched: '對上了',
  unavailable: '無法評分',
};
const REASON_TEXT = {
  target_missing: '提案姿勢無法辨識',
  target_multiple: '提案影像中有多人',
  live_missing: '請讓身體進入畫面',
  live_multiple: '畫面中請只留一人',
  insufficient_landmarks: '請讓肩膀與髖部入鏡',
  insufficient_pose_edges: '可見的手腳不足',
  low_confidence: '姿勢辨識信心不足',
  invalid_framing: '取景範圍不足',
  worker_error: '姿勢分析暫不可用',
  frame_capture_failed: '無法讀取相機畫面',
  runtime_error: '姿勢分析暫不可用',
};

function componentText(label, score) {
  return `${label} ${BAND_TEXT[matchBand(score)]}`;
}

function setMeterMessage(message) {
  if (!meter) return;
  meter.style.display = 'block';
  meter.dataset.band = 'unavailable';
  if (matchState) matchState.textContent = message;
  if (poseState) poseState.textContent = '姿勢 --';
  if (frameState) frameState.textContent = '取景 --';
}

function renderAlignment({ measurement }) {
  if (!meter) return;
  meter.style.display = 'block';
  if (!measurement?.valid) {
    setMeterMessage(REASON_TEXT[measurement?.reason] || '暫無姿勢資料');
    return;
  }
  meter.dataset.band = measurement.band;
  if (matchState) matchState.textContent = BAND_TEXT[measurement.band];
  if (poseState) poseState.textContent = componentText('姿勢', measurement.pose);
  if (frameState) frameState.textContent = componentText('取景', measurement.framing);
}

/* ── 幽靈形式:照片 / 照片+骨架 / 火柴人 ── */
function renderSkeleton() {
  const target = alignmentController?.target();
  if (!target) return false;
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return false;
  const dpr = window.devicePixelRatio || 1;
  skeletonCanvas.width = Math.round(w * dpr);
  skeletonCanvas.height = Math.round(h * dpr);
  const ctx = skeletonCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const mapped = mapLandmarksToCover(target.landmarks, target.size, { width: w, height: h }, {
    mirrored: camera.mode === 'user',
  });
  const points = mapped.map(p => (p ? { ...p, x: p.x * w, y: p.y * h } : p));
  drawSkeleton(ctx, skeletonGeometry(points), { lineWidth: Math.max(4, Math.round(w * 0.012)) });
  return true;
}

// 描邊直接來自提案影像,不需要姿勢辨識成功
function renderContour(region = 'all') {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h || !ghost.naturalWidth) return { drawn: false, maskApplied: false };
  const dpr = window.devicePixelRatio || 1;
  skeletonCanvas.width = Math.round(w * dpr);
  skeletonCanvas.height = Math.round(h * dpr);
  const width = skeletonCanvas.width, height = skeletonCanvas.height;
  let expressionRegion = null;
  if (region !== 'all') {
    const target = alignmentController?.target();
    if (target) {
      const mapped = mapLandmarksToCover(target.landmarks, target.size, { width, height }, {
        mirrored: camera.mode === 'user',
      });
      expressionRegion = expressionRegionFromPose(mapped.map(point => point ? {
        ...point,
        x: point.x * width,
        y: point.y * height,
      } : point));
    }
  }
  const maskApplied = region === 'all' || Boolean(expressionRegion);
  const drawn = drawContour(skeletonCanvas, ghost, {
    mirrored: camera.mode === 'user',
    region: maskApplied ? region : 'all',
    expressionRegion,
  });
  return { drawn, maskApplied };
}

function applyGhostForm({ announce = false } = {}) {
  const opacity = opEl.value / 100;
  if (!ghostReady) {
    ghost.style.display = 'none';
    skeletonCanvas.style.display = 'none';
    return;
  }

  const contourRegion = CONTOUR_REGION[ghostForm];
  if (contourRegion) {
    const { drawn, maskApplied } = renderContour(contourRegion);
    skeletonCanvas.style.display = drawn ? 'block' : 'none';
    skeletonCanvas.style.opacity = Math.min(1, opacity * 1.6);
    ghost.style.display = drawn ? 'none' : 'block';
    ghost.style.opacity = opacity;
    if (!drawn && announce) setStatus('描邊失敗,暫用照片疊層');
    else if (!maskApplied && announce) setStatus('提案表情無法辨識,暫用完整描邊');
    return;
  }

  const hasSkeleton = Boolean(alignmentController?.target());
  let form = ghostForm;
  if (form !== 'photo' && !hasSkeleton) {
    form = 'photo';
    if (announce) setStatus('提案姿勢無法辨識,暫用照片疊層');
  }
  const showSkeleton = form !== 'photo' && renderSkeleton();
  skeletonCanvas.style.display = showSkeleton ? 'block' : 'none';
  skeletonCanvas.style.opacity = Math.min(1, opacity * 1.6);
  ghost.style.display = form === 'stick' && showSkeleton ? 'none' : 'block';
  ghost.style.opacity = form === 'hybrid' && showSkeleton ? opacity * 0.5 : opacity;
}

if (formSelect) formSelect.onchange = () => {
  ghostForm = formSelect.value;
  localStorage.setItem('ghost_form', ghostForm);
  applyGhostForm({ announce: true });
  if (ghostReady) {
    log.push({ ts: new Date().toISOString(), event: 'ghost_form_changed', ghost_form: ghostForm });
    save();
  }
};
window.addEventListener('resize', () => applyGhostForm());

function clearGhost() {
  ghostGenerationEpoch += 1;
  alignmentController?.stop();
  ghostReady = false;
  ghost.style.display = 'none';
  ghost.removeAttribute('src');
  skeletonCanvas.style.display = 'none';
  if (meter) meter.style.display = 'none';
  if (reasonEl) reasonEl.hidden = true;
  const spinEl = document.getElementById('spin');
  if (spinEl) spinEl.style.display = 'none';
  const summonButton = document.getElementById('summon');
  if (summonButton) summonButton.disabled = false;
}
document.addEventListener('openhci:clear-ghost', clearGhost);

/* ── 相機 ── */
const camera = new CameraController({
  video,
  mirrorTargets: [video, ghost],
  trigger: document.getElementById('start'),
  buttons: document.querySelectorAll('[data-camera-facing]'),
  defaultMode: DEFAULT_CAMERA_FACING,
  onStarted: mode => {
    const replacedGhost = ghostReady;
    if (replacedGhost) clearGhost();
    setStatus(`${mode === 'user' ? '前' : '後'}鏡頭已啟動,${replacedGhost ? '請重新產生姿勢提案' : '按「姿勢提案」'}`);
  },
  onError: error => setStatus('無法開啟相機:' + error.message),
});

alignmentController = new PoseAlignmentController({
  video,
  targetImage: ghost,
  stage,
  isMirrored: () => camera.mode === 'user',
  onUpdate: renderAlignment,
  onState: state => {
    if (state.state === 'loading') setMeterMessage('分析提案姿勢');
    if (state.state === 'unavailable') setMeterMessage(REASON_TEXT[state.reason] || '姿勢分析暫不可用');
  },
});

window.addEventListener('pagehide', () => {
  stopCountdown();
  stopLivePhoto();
  alignmentController.dispose();
  camera.stop();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopCountdown();
    stopLivePhoto({ preserveRequest: true });
  } else if (livePhotoRequested) {
    armLivePhoto();
  }
});

function captureAspect() {
  const match = stage?.dataset.captureAspect?.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const aspect = Number(match[1]) / Number(match[2]);
  return Number.isFinite(aspect) && aspect > 0 ? aspect : null;
}

function drawVideoCover(context, width, height) {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = width / height;
  let sx = 0, sy = 0, sw = sourceWidth, sh = sourceHeight;
  if (sourceAspect > targetAspect) {
    sw = sourceHeight * targetAspect;
    sx = (sourceWidth - sw) / 2;
  } else if (sourceAspect < targetAspect) {
    sh = sourceWidth / targetAspect;
    sy = (sourceHeight - sh) / 2;
  }
  context.drawImage(video, sx, sy, sw, sh, 0, 0, width, height);
}

function croppedVideoFrame(width, height) {
  const canvas = Object.assign(document.createElement('canvas'), { width, height });
  drawVideoCover(canvas.getContext('2d'), width, height);
  return canvas;
}

/* ── /cuts 原況照片:快門前後低解析影格 ── */
const LIVE_PHOTO_INTERVAL_MS = 167;
const LIVE_PHOTO_PRE_FRAMES = 4;
const LIVE_PHOTO_POST_FRAMES = 4;
const LIVE_PHOTO_MAX_EDGE = 480;
let livePhotoArmed = false;
let livePhotoRequested = false;
let livePhotoReady = false;
let livePhotoSampleTimer = null;
let livePhotoRing = [];
let livePhotoRingSignature = '';
let activeLivePhotoCapture = null;
let livePhotoCaptureSequence = 0;

function livePhotoSignature() {
  return JSON.stringify([
    camera.mode,
    stage?.dataset.captureAspect || '',
    video.videoWidth,
    video.videoHeight,
    cameraLook,
  ]);
}

function livePhotoFrameSettings() {
  const aspect = captureAspect() || (video.videoWidth / video.videoHeight) || 1;
  const width = aspect >= 1 ? LIVE_PHOTO_MAX_EDGE : Math.round(LIVE_PHOTO_MAX_EDGE * aspect);
  const height = aspect >= 1 ? Math.round(LIVE_PHOTO_MAX_EDGE / aspect) : LIVE_PHOTO_MAX_EDGE;
  return {
    width,
    height,
    mirrored: camera.mode === 'user',
    look: JSON.parse(JSON.stringify(cameraLook)),
    signature: livePhotoSignature(),
  };
}

function renderLivePhotoFrame(settings) {
  if (!video.videoWidth || !video.videoHeight || livePhotoSignature() !== settings.signature) return null;
  const source = Object.assign(document.createElement('canvas'), {
    width: settings.width,
    height: settings.height,
  });
  drawVideoCover(source.getContext('2d'), settings.width, settings.height);
  const output = Object.assign(document.createElement('canvas'), {
    width: settings.width,
    height: settings.height,
  });
  renderCameraFrame(
    output.getContext('2d'),
    source,
    settings.width,
    settings.height,
    settings.look,
    { mirrored: settings.mirrored },
  );
  return output.toDataURL('image/jpeg', 0.8);
}

function shutterLivePhotoFrame(shutterCanvas, settings) {
  const output = Object.assign(document.createElement('canvas'), {
    width: settings.width,
    height: settings.height,
  });
  output.getContext('2d').drawImage(shutterCanvas, 0, 0, settings.width, settings.height);
  return output.toDataURL('image/jpeg', 0.82);
}

function setLivePhotoReady(ready) {
  if (!LIVE_PHOTO_ENABLED) return;
  const changed = livePhotoReady !== ready;
  livePhotoReady = ready;
  shootBtn.disabled = !ready;
  if (changed) {
    document.dispatchEvent(new CustomEvent('openhci:live-photo-ready', { detail: { ready } }));
  }
}

function stopLivePhotoRing() {
  livePhotoArmed = false;
  setLivePhotoReady(false);
  clearTimeout(livePhotoSampleTimer);
  livePhotoSampleTimer = null;
  livePhotoRing = [];
  livePhotoRingSignature = '';
}

function sampleLivePhotoRing() {
  if (!livePhotoArmed) return;
  try {
    const settings = livePhotoFrameSettings();
    if (settings.signature !== livePhotoRingSignature) {
      livePhotoRing = [];
      livePhotoRingSignature = settings.signature;
      setLivePhotoReady(false);
    }
    const frame = renderLivePhotoFrame(settings);
    if (frame) {
      livePhotoRing.push(frame);
      if (livePhotoRing.length > LIVE_PHOTO_PRE_FRAMES) livePhotoRing.shift();
      if (livePhotoRing.length >= LIVE_PHOTO_PRE_FRAMES) setLivePhotoReady(true);
    }
  } catch {
    // 相機剛切換或頁面進入背景時略過這一幀,不影響靜態拍照。
  }
  livePhotoSampleTimer = setTimeout(sampleLivePhotoRing, LIVE_PHOTO_INTERVAL_MS);
}

function cancelActiveLivePhoto() {
  activeLivePhotoCapture?.cancel();
  activeLivePhotoCapture = null;
}

function armLivePhoto() {
  if (!LIVE_PHOTO_ENABLED) return;
  livePhotoRequested = true;
  stopLivePhotoRing();
  livePhotoArmed = true;
  sampleLivePhotoRing();
}

function stopLivePhoto({ cancelActive = true, preserveRequest = false } = {}) {
  const shouldResume = preserveRequest && livePhotoRequested;
  stopLivePhotoRing();
  livePhotoRequested = shouldResume;
  if (cancelActive) cancelActiveLivePhoto();
}

function beginLivePhotoCapture(shutterCanvas) {
  if (!LIVE_PHOTO_ENABLED) return null;
  const settings = livePhotoFrameSettings();
  const preFrames = livePhotoRingSignature === settings.signature
    ? livePhotoRing.slice(-LIVE_PHOTO_PRE_FRAMES)
    : [];
  const shutterFrame = shutterLivePhotoFrame(shutterCanvas, settings);
  livePhotoRequested = false;
  stopLivePhotoRing();

  const captureId = `live-${Date.now()}-${++livePhotoCaptureSequence}`;
  let cancelled = false;
  let releaseWait = null;
  const cancel = () => {
    cancelled = true;
    releaseWait?.();
  };
  const waitForNextFrame = () => new Promise(resolve => {
    const timer = setTimeout(() => {
      releaseWait = null;
      resolve();
    }, LIVE_PHOTO_INTERVAL_MS);
    releaseWait = () => {
      clearTimeout(timer);
      releaseWait = null;
      resolve();
    };
  });

  const ready = (async () => {
    try {
      const frames = preFrames.slice();
      const firstFrame = frames[0] || shutterFrame;
      while (frames.length < LIVE_PHOTO_PRE_FRAMES) frames.unshift(firstFrame);
      frames.push(shutterFrame);
      let lastFrame = shutterFrame;
      for (let index = 0; index < LIVE_PHOTO_POST_FRAMES; index += 1) {
        await waitForNextFrame();
        if (cancelled) throw new DOMException('原況照片已取消', 'AbortError');
        lastFrame = renderLivePhotoFrame(settings) || lastFrame;
        frames.push(lastFrame);
      }
      return {
        captureId,
        frames,
        width: settings.width,
        height: settings.height,
        delayMs: LIVE_PHOTO_INTERVAL_MS,
        shutterIndex: LIVE_PHOTO_PRE_FRAMES,
      };
    } finally {
      if (activeLivePhotoCapture?.captureId === captureId) activeLivePhotoCapture = null;
    }
  })();

  activeLivePhotoCapture = { captureId, cancel };
  return { captureId, ready, cancel };
}

document.addEventListener('openhci:live-photo-start', armLivePhoto);
document.addEventListener('openhci:live-photo-stop', event => {
  stopLivePhoto({ cancelActive: event.detail?.cancelActive !== false });
});

/* ── 抓 frame → base64 ── */
function frameB64(size = 768) {
  const aspect = captureAspect();
  const w = size, h = aspect ? Math.round(size / aspect) : Math.round(size * video.videoHeight / video.videoWidth) || size;
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
  if (aspect) drawVideoCover(c.getContext('2d'), w, h);
  else c.getContext('2d').drawImage(video, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.85).split(',')[1];
}

/* ── 核心:產生姿勢提案(不美化、不動色調) ── */
const BASE_GHOST_PROMPT = `Redraw this exact scene with the SAME person, same clothing, same location, same background.
Change ONLY the pose, facial expression, and framing/composition: propose one natural, physically easy pose variation this person could actually do right now.
Do NOT beautify anything: keep the real face, real body proportions, skin, lighting, and colors exactly as they are. No retouching, no color grading.
Photorealistic. Output the image only.`;

function normalizeStylePreference(value) {
  return value.trim().replace(/\s+/g, ' ').slice(0, 280);
}

function buildGhostPrompt(stylePreference) {
  if (!stylePreference) return BASE_GHOST_PROMPT;
  return `${BASE_GHOST_PROMPT}

The person wants this photo to feel: ${stylePreference}
Express that feeling ONLY through pose, facial expression, and framing.
Never express it through color, lighting changes, retouching, or altering identity, clothing, or location.`;
}

/* ── 三種建議策略:文字說明怎麼產生(測 prompt 干擾) ── */
// 文字說明的定位:不是重新描述圖(姿勢/構圖規格),而是給情境、聯想、動機——
// 像導演給演員一個可以住進去的時刻,讓感覺自己長出姿勢。
const REASON_RULES = `Reply in Traditional Chinese (繁體中文), 1–2 sentences, max 60 characters total, starting with 「如果你想要…」.
Do NOT describe or re-state the image, pose, expression, or framing.
Instead, give the user a scenario, association, memory, or motivation to inhabit — a concrete imagined moment that would naturally produce this feeling, the way a director gives an actor a situation instead of stage directions. Example register: 「如果你想要 chill——想像剛下課走出教室,晚風吹過來的那一刻」.
Never judge quality (no 好看/更好/best). Never mention color, lighting, retouching, or beautification.`;

// Google 端的每分鐘配額(RESOURCE_EXHAUSTED)會間歇性 429,自動退避重試;
// 本站每日預算用完(Daily image generation limit)重試也沒用,直接失敗。
const RETRY_DELAYS_MS = [2500, 6000];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function callGhost(parts, modalities) {
  const key = keyEl?.value?.trim() || '';
  // key 留空 → 走同源代理 /api/ghost(部署版,key 存在伺服器);有填 → 直連 Google
  const endpoint = key
    ? `https://generativelanguage.googleapis.com/v1beta/models/${ghostModel}:generateContent?key=${key}`
    : `/api/ghost`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openhci-model': ghostModel },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseModalities: modalities },
      }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === 'object') {
        data._openhci = {
          model: res.headers.get('x-openhci-model') || ghostModel,
          upstream: res.headers.get('x-openhci-upstream') || (key ? 'google-api-key' : 'vertex'),
        };
      }
      return data;
    }
    const message = (await res.json().catch(() => ({})))?.error?.message || '';
    const retryable = (res.status === 429 || res.status === 503) &&
      !/Daily image generation limit/i.test(message);
    if (!retryable || attempt >= RETRY_DELAYS_MS.length) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(message)}`);
    }
    const delay = RETRY_DELAYS_MS[attempt];
    setStatus(`上游忙碌(HTTP ${res.status}),${Math.round(delay / 1000)} 秒後自動重試(第 ${attempt + 1}/${RETRY_DELAYS_MS.length} 次)…`);
    log.push({ ts: new Date().toISOString(), event: 'ghost_retry', status: res.status, attempt: attempt + 1 });
    save();
    await wait(delay);
  }
}

const responseParts = data => data.candidates?.[0]?.content?.parts || [];
const extractImagePart = data => responseParts(data).find(p => p.inlineData);
const extractText = data => responseParts(data)
  .map(p => p.text || '')
  .join(' ')
  .replace(/\s+/g, ' ')
  .trim();
const responseGenerationMeta = data => ({
  model: data?._openhci?.model || ghostModel,
  upstream: data?._openhci?.upstream || 'requested',
});

// 圖像模型不一定接受純 TEXT 回應,失敗就退回 TEXT+IMAGE 只取文字
async function ghostTextCall(parts) {
  try {
    return extractText(await callGhost(parts, ["TEXT"]));
  } catch {
    return extractText(await callGhost(parts, ["TEXT", "IMAGE"]));
  }
}

function feelingLabel(stylePreference) {
  return stylePreference || '自然放鬆';
}

async function runStrategy(strategy, framePart, stylePreference) {
  const feeling = feelingLabel(stylePreference);
  const timed = async fn => {
    const started = performance.now();
    const value = await fn();
    return { value, seconds: +(((performance.now() - started) / 1000).toFixed(1)) };
  };

  if (strategy === 'together') {
    const imagePrompt = `${buildGhostPrompt(stylePreference)}

In addition to the image, also output a short text for the user: ${REASON_RULES}`;
    const { value: data, seconds } = await timed(() => callGhost([
      framePart,
      { text: imagePrompt },
    ], ["TEXT", "IMAGE"]));
    const reason = extractText(data);
    const generation = responseGenerationMeta(data);
    if (!reason) setStatus('注意:此策略未回傳文字(已知限制),改用策略 2 或 3');
    return { imgPart: extractImagePart(data), reason, imagePrompt, imageSeconds: seconds, textSeconds: null, ...generation };
  }

  if (strategy === 'text-then-image') {
    const { value: scenario, seconds: textSeconds } = await timed(() => ghostTextCall([
      framePart,
      { text: `Do not generate an image yet. Look at this camera frame. The person wants the photo to feel 「${feeling}」. Write the scenario first: ${REASON_RULES}` },
    ]));
    setStatus(`情境完成,照著生成圖像中…`);
    const imagePrompt = `${buildGhostPrompt(stylePreference)}

Stage the person as if they are living this exact imagined moment (written in Traditional Chinese) — let the scenario decide the pose, expression, and framing:
${scenario}`;
    const { value: data, seconds: imageSeconds } = await timed(() => callGhost([
      framePart,
      { text: imagePrompt },
    ], ["TEXT", "IMAGE"]));
    return { imgPart: extractImagePart(data), reason: scenario, imagePrompt, imageSeconds, textSeconds, ...responseGenerationMeta(data) };
  }

  // image-then-text
  const imagePrompt = buildGhostPrompt(stylePreference);
  const { value: data, seconds: imageSeconds } = await timed(() => callGhost([
    framePart,
    { text: imagePrompt },
  ], ["TEXT", "IMAGE"]));
  const imgPart = extractImagePart(data);
  const generation = responseGenerationMeta(data);
  let reason = '';
  let textSeconds = null;
  if (imgPart) {
    setStatus('圖像完成,產生文字說明中…');
    ({ value: reason, seconds: textSeconds } = await timed(() => ghostTextCall([
      { inlineData: imgPart.inlineData },
      { text: `This image is a pose proposal shown to the user as a reference. The user wants the photo to feel 「${feeling}」. Use the image only as inspiration for what moment it could belong to — do not describe it. ${REASON_RULES}` },
    ])));
  }
  return { imgPart, reason, imagePrompt, imageSeconds, textSeconds, ...generation };
}

document.getElementById('summon').onclick = async () => {
  const summonButton = document.getElementById('summon');
  const promptInputRaw = stylePromptEl.value.slice(0, 280);
  const stylePreference = normalizeStylePreference(promptInputRaw);
  if (!video.videoWidth) return setStatus('先開相機');
  clearGhost();
  const generationEpoch = ghostGenerationEpoch;
  showReason(null);
  const spinEl = document.getElementById('spin');
  if (spinEl) spinEl.style.display = 'block';
  summonButton.disabled = true;
  document.dispatchEvent(new CustomEvent('openhci:ghost-start', {
    detail: { model: ghostModel, modelLabel: MODEL_LABEL[ghostModel], strategy: suggestStrategy },
  }));
  setStatus(`產生提案中(${STRATEGY_LABEL[suggestStrategy]})…${stylePreference ? `感覺:${stylePreference.slice(0, 24)}${stylePreference.length > 24 ? '…' : ''}` : ''}`);
  const t0 = performance.now();
  try {
    const framePart = { inlineData: { mimeType: "image/jpeg", data: frameB64() } };
    const { imgPart, reason, imagePrompt, imageSeconds, textSeconds, model: servedModel, upstream } = await runStrategy(suggestStrategy, framePart, stylePreference);
    if (generationEpoch !== ghostGenerationEpoch) return;
    if (!imgPart) throw new Error('回應沒有影像');
    ghost.src = `data:${imgPart.inlineData.mimeType};base64,${imgPart.inlineData.data}`;
    await ghost.decode();
    if (generationEpoch !== ghostGenerationEpoch) return;
    ghostReady = true;
    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    let alignmentAvailable = false;
    try {
      await alignmentController.setTarget();
      alignmentAvailable = true;
    } catch (error) {
      setMeterMessage(error.message || '提案姿勢無法辨識');
    }
    if (generationEpoch !== ghostGenerationEpoch) return;
    applyGhostForm({ announce: true });
    showReason(reason, suggestStrategy);
    // 通知介面層(如 /cuts 的流程畫面);純通知,不影響本頁行為
    const servedModelLabel = MODEL_LABEL[servedModel] || servedModel;
    document.dispatchEvent(new CustomEvent('openhci:ghost', {
      detail: {
        src: ghost.src,
        reason,
        promptInputRaw,
        stylePreference,
        imagePrompt,
        model: servedModel,
        modelLabel: servedModelLabel,
        requestedModel: ghostModel,
        upstream,
        strategy: suggestStrategy,
      },
    }));
    setStatus(`提案就緒(${dt}s,${servedModelLabel},${FORM_LABEL[ghostForm]},${STRATEGY_LABEL[suggestStrategy]})——${alignmentAvailable ? '試著把自己對進去,或故意不照做' : '可看疊層,但暫不評分'}`);
    log.push({
      ts: new Date().toISOString(),
      event: 'ghost_generated',
      latency_s: +dt,
      model: servedModel,
      requested_model: ghostModel,
      upstream,
      strategy: suggestStrategy,
      image_latency_s: imageSeconds,
      text_latency_s: textSeconds,
      reason_len: reason ? reason.length : 0,
      ghost_form: ghostForm,
      style_mode: stylePreference ? 'custom' : 'default',
      style_prompt_len: stylePreference.length,
      alignment_mode: alignmentAvailable ? MATCH_METRIC_VERSION : 'unavailable'
    });
    save();
  } catch (e) {
    if (generationEpoch === ghostGenerationEpoch) setStatus('產生失敗:' + e.message);
  } finally {
    if (generationEpoch === ghostGenerationEpoch) {
      if (spinEl) spinEl.style.display = 'none';
      summonButton.disabled = false;
    }
  }
};

opEl.oninput = () => applyGhostForm();

/* ── 倒數快門:自己決定何時開始,倒數讓你有時間用身體就位 ── */
const timerSelect = document.getElementById('timerSelect');
const countdownEl = document.getElementById('countdown');
const shootBtn = document.getElementById('shoot');
let countdownTimer = null;

timerSelect.value = localStorage.getItem('shutter_timer') ?? '5';
timerSelect.onchange = () => {
  localStorage.setItem('shutter_timer', timerSelect.value);
  setStatus(timerSelect.value === '0' ? '倒數:關(按下即拍)' : `倒數:${timerSelect.value} 秒`);
};

function stopCountdown() {
  clearTimeout(countdownTimer);
  countdownTimer = null;
  countdownEl.dataset.visible = 'false';
  countdownEl.textContent = '';
  shootBtn.textContent = '📸 拍照';
}

function buzz(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

function startCountdown(seconds) {
  const started = seconds;
  shootBtn.textContent = '✕ 取消';
  countdownEl.dataset.visible = 'true';
  log.push({ ts: new Date().toISOString(), event: 'countdown_started', seconds: started });
  save();

  const step = remaining => {
    if (remaining <= 0) {
      stopCountdown();
      buzz([120, 60, 120]);
      capture({ countdownSeconds: started });
      return;
    }
    countdownEl.replaceChildren(Object.assign(document.createElement('span'), {
      textContent: String(remaining),
    }));
    buzz(remaining <= 3 ? 60 : 25);
    countdownTimer = setTimeout(() => step(remaining - 1), 1000);
  };
  step(seconds);
}

/* ── 拍照 ── */
function capture({ countdownSeconds = null } = {}) {
  if (!video.videoWidth) return;
  if (LIVE_PHOTO_ENABLED && (
    !livePhotoArmed ||
    livePhotoRingSignature !== livePhotoSignature() ||
    livePhotoRing.length < LIVE_PHOTO_PRE_FRAMES
  )) {
    armLivePhoto();
    setStatus('原況照片準備中，請稍候再按一次快門');
    return;
  }
  const aspect = captureAspect();
  const width = aspect ? Math.round(Math.min(video.videoWidth, video.videoHeight * aspect)) : video.videoWidth;
  const height = aspect ? Math.round(width / aspect) : video.videoHeight;
  const source = aspect ? croppedVideoFrame(width, height) : video;
  const c = Object.assign(document.createElement('canvas'), { width, height });
  renderCameraFrame(
    c.getContext('2d'),
    source,
    c.width,
    c.height,
    cameraLook,
    { mirrored: camera.mode === 'user' },
  );
  const real = c.toDataURL('image/jpeg', 0.9);
  const livePhoto = beginLivePhotoCapture(c);
  const alignment = ghostReady ? alignmentController.summary() : null;
  log.push({
    ts: new Date().toISOString(),
    event: 'shot',
    ghost_form: ghostReady ? ghostForm : null,
    strategy: ghostReady ? suggestStrategy : null,
    model: ghostReady ? ghostModel : null,
    countdown_s: countdownSeconds,
    alignment,
    camera_look: cameraLook,
    capture_aspect: stage?.dataset.captureAspect || null,
  });
  save();
  document.getElementById('resReal').src = real;
  const ghostPane = document.getElementById('ghostPane');
  const resGhost = document.getElementById('resGhost');
  const showGhostPane = Boolean(ghostPane && resGhost && ghostReady && ghost.src);
  if (ghostPane) ghostPane.hidden = !showGhostPane;
  if (showGhostPane) {
    resGhost.src = ghost.src;
    resGhost.classList.toggle('is-front-camera', camera.mode === 'user');
  }
  result.dataset.mode = showGhostPane ? 'comparison' : 'solo';
  resetSaveReminder();
  result.style.display = 'grid';
  // 通知介面層;/cuts 用它收集連拍並自行接手結果畫面
  document.dispatchEvent(new CustomEvent('openhci:shot', {
    detail: {
      dataUrl: real,
      alignment,
      livePhoto,
      cameraFacing: camera.mode,
      capturedMirrored: camera.mode === 'user',
    },
  }));
  const lookText = cameraLookLabel(cameraLook);
  if (ghostReady && alignment?.final) {
    const initial = alignment.baseline ? BAND_TEXT[matchBand(alignment.baseline.match / 100)] : '剛開始';
    const final = BAND_TEXT[matchBand(alignment.final.match / 100)];
    setStatus(`拍下了（${lookText}）。對齊:${initial} → ${final}——照不照提案都是你的決定。`);
  } else if (ghostReady) {
    setStatus(`拍下了（${lookText}）。姿勢資料不足,未產生對齊紀錄。`);
  } else {
    setStatus(`拍下了（${lookText},無提案)。`);
  }
}

shootBtn.onclick = () => {
  if (countdownTimer) return stopCountdown();
  const seconds = Number(timerSelect.value);
  if (seconds > 0) return startCountdown(seconds);
  capture();
};
/* ── 關閉前提醒儲存:未下載時第一下 ✕ 只提醒,再按一次才關 ── */
const downloadBtn = document.getElementById('download');
const saveHint = document.getElementById('saveHint');
let shotDownloaded = false;
let closeArmed = false;
let closeArmTimer = null;

function resetSaveReminder() {
  shotDownloaded = false;
  closeArmed = false;
  clearTimeout(closeArmTimer);
  saveHint.hidden = true;
  downloadBtn.dataset.done = 'false';
  downloadBtn.textContent = '⬇ 下載照片';
}

downloadBtn.onclick = () => {
  const modelTag = ghostModel.replace(/^gemini-|-image$/g, '');
  const link = document.createElement('a');
  link.href = document.getElementById('resReal').src;
  link.download = `play_${modelTag}_${suggestStrategy}_${Date.now()}.jpg`;
  link.click();
  shotDownloaded = true;
  closeArmed = false;
  clearTimeout(closeArmTimer);
  saveHint.hidden = true;
  downloadBtn.dataset.done = 'true';
  downloadBtn.textContent = '✓ 已下載';
  log.push({ ts: new Date().toISOString(), event: 'shot_downloaded', model: ghostModel, strategy: suggestStrategy });
  save();
};

document.getElementById('close').onclick = () => {
  if (!shotDownloaded && !closeArmed) {
    closeArmed = true;
    saveHint.hidden = false;
    clearTimeout(closeArmTimer);
    closeArmTimer = setTimeout(() => {
      closeArmed = false;
      saveHint.hidden = true;
    }, 6000);
    return;
  }
  result.style.display = 'none';
  resetSaveReminder();
};

const save = () => localStorage.setItem(LOG_KEY, JSON.stringify(log));
