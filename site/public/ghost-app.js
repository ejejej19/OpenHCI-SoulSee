import { CameraController } from "./camera-controller.js";
import { renderCameraFrame } from "./camera-effects.js";
import {
  captureSessionMetadata,
  dataUrlToBlob,
  saveCaptureSession,
} from "./capture-session.js";
import {
  compareHorizons,
  detectDominantHorizon,
} from "./composition-guide.js";
import { buildGuidanceCandidates } from "./guidance-candidates.js";
import { GuidanceController } from "./guidance-controller.js";
import {
  PHOTOGRAPHY_PROMPT_VERSION,
  buildPhotographyGhostPrompt,
} from "./ghost-prompt.js";
import { DeviceOrientationController } from "./orientation-sensor.js";
import {
  buildIntentReceipt,
  formatIntentDimensionEvidence,
  normalizeIntentJudgment,
} from "./intent-alignment.js";
import {
  buildIntentProfileSummary,
  inferIntentProfile,
  intentProfileMatchesPrompt,
  normalizeIntentProfile,
} from "./intent-profile.js";
import {
  analyzeImageData,
  measureLookSimilarity,
} from "./look-matching.js";
import { PoseAlignmentController } from "./pose-alignment-controller.js";
import { MATCH_METRIC_VERSION, matchBand } from "./pose-similarity.js";

const GEMINI_MODEL = "gemini-2.5-flash-image";
const DEFAULT_INTENT_LABEL = "自然旅拍、三分法、暖色光線";
const NEUTRAL_CAPTURE_LOOK = Object.freeze({ filter: "original", effect: "none" });

const element = id => document.getElementById(id);
const keyEl = element("key");
const stylePromptEl = element("stylePrompt");
const intentProfileStatus = element("intentProfileStatus");
const reviewIntentButton = element("reviewIntent");
const intentDialog = element("intentDialog");
const intentForm = element("intentForm");
const intentSourcePrompt = element("intentSourcePrompt");
const confirmIntentButton = element("confirmIntent");
const video = element("cam");
const ghost = element("ghost");
const stage = element("stage");
const meter = element("meter");
const matchState = element("matchState");
const poseState = element("poseState");
const frameState = element("frameState");
const compositionState = element("compositionState");
const compositionGuides = element("compositionGuides");
const targetHorizon = element("targetHorizon");
const guideToggle = element("guideToggle");
const pauseGuidanceButton = element("pauseGuidance");
const skipHintButton = element("skipHint");
const guideHint = element("guideHint");
const result = element("result");
const editPhotoButton = element("editPhoto");
const ghostResult = element("ghostResult");
const resultGhostImage = element("resGhost");
const intentReceipt = element("intentReceipt");
const receiptBand = element("receiptBand");
const receiptCoverage = element("receiptCoverage");
const receiptPrompt = element("receiptPrompt");
const receiptDimensions = element("receiptDimensions");

const BAND_TEXT = Object.freeze({
  adjusting: "調整中",
  close: "接近",
  matched: "對上了",
  unavailable: "無法評分",
});

const REASON_TEXT = Object.freeze({
  target_missing: "幽靈姿勢無法辨識",
  target_multiple: "幽靈影像中有多人",
  live_missing: "請讓身體進入畫面",
  live_multiple: "畫面中請只留一人",
  insufficient_landmarks: "請讓肩膀與髖部入鏡",
  insufficient_pose_edges: "可見的手腳不足",
  low_confidence: "姿勢辨識信心不足",
  invalid_framing: "取景範圍不足",
  worker_error: "姿勢分析暫不可用",
  frame_capture_failed: "無法讀取相機畫面",
  runtime_error: "姿勢分析暫不可用",
});

function readStoredJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || "") ?? fallback;
  } catch {
    return fallback;
  }
}

let log = readStoredJson("ghost_log", []);
if (!Array.isArray(log)) log = [];
let ghostReady = false;
let activeIntentSummary = DEFAULT_INTENT_LABEL;
let activeIntentProfile = null;
let confirmedIntentProfile = null;
let generateAfterIntentConfirmation = false;
let ghostLookStats = null;
let targetComposition = null;
let latestComposition = null;
let latestAlignment = null;
let latestOrientation = null;
let compositionTimer = null;
let guideEnabled = false;
let activeShotEntry = null;
let alignmentController;
let guidanceController;
let resultOriginalUrl = null;

function saveLog() {
  localStorage.setItem("ghost_log", JSON.stringify(log.slice(-200)));
}

guidanceController = new GuidanceController({
  onEvent: event => {
    log.push({ ts: new Date().toISOString(), ...event });
    saveLog();
  },
});

function setStatus(message) {
  element("status").textContent = message;
}

keyEl.value = localStorage.getItem("gemini_key") || "";
keyEl.onchange = () => localStorage.setItem("gemini_key", keyEl.value.trim());

function sourceDimensions(source) {
  return {
    width: source.videoWidth || source.naturalWidth || source.width || 0,
    height: source.videoHeight || source.naturalHeight || source.height || 0,
  };
}

function drawCover(context, source, width, height, mirrored = false) {
  const sourceSize = sourceDimensions(source);
  if (!sourceSize.width || !sourceSize.height) throw new Error("影像尚未載入");
  const scale = Math.max(width / sourceSize.width, height / sourceSize.height);
  const sourceWidth = width / scale;
  const sourceHeight = height / scale;
  const sourceX = (sourceSize.width - sourceWidth) / 2;
  const sourceY = (sourceSize.height - sourceHeight) / 2;
  context.save();
  if (mirrored) {
    context.translate(width, 0);
    context.scale(-1, 1);
  }
  context.drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
  context.restore();
}

function sampleDisplayedFrame(source, { width = 128, mirrored = false } = {}) {
  const sourceSize = sourceDimensions(source);
  const fallbackRatio = sourceSize.width ? sourceSize.height / sourceSize.width : 1;
  const stageRatio = stage.clientWidth ? stage.clientHeight / stage.clientWidth : fallbackRatio;
  const height = Math.max(64, Math.min(192, Math.round(width * stageRatio)));
  const canvas = Object.assign(document.createElement("canvas"), { width, height });
  const context = canvas.getContext("2d", { willReadFrequently: true });
  drawCover(context, source, width, height, mirrored);
  return context.getImageData(0, 0, width, height);
}

function analyzeLookSource(source, options) {
  try {
    return analyzeImageData(sampleDisplayedFrame(source, options));
  } catch (error) {
    return { valid: false, reason: error.message || "look_capture_failed" };
  }
}

function analyzeCompositionSource(source, options) {
  try {
    return detectDominantHorizon(sampleDisplayedFrame(source, options));
  } catch (error) {
    return { valid: false, reason: error.message || "composition_capture_failed" };
  }
}

function componentText(label, score) {
  return `${label} ${BAND_TEXT[matchBand(score)]}`;
}

function setMeterMessage(message) {
  meter.style.display = "block";
  meter.dataset.band = "unavailable";
  matchState.textContent = message;
  poseState.textContent = "姿勢 --";
  frameState.textContent = "人物位置 --";
  compositionState.textContent = "構圖 --";
}

function refreshOverallMeter() {
  if (!latestAlignment?.valid) return;
  const scores = [latestAlignment.match];
  if (latestComposition?.valid) scores.push(latestComposition.score);
  const band = matchBand(Math.min(...scores));
  meter.dataset.band = band;
  matchState.textContent = BAND_TEXT[band];
}

function renderGuideHint() {
  const controlsAvailable = guideEnabled && ghostReady;
  pauseGuidanceButton.hidden = !controlsAvailable;
  if (!guideEnabled || !ghostReady) {
    skipHintButton.hidden = true;
    guideHint.hidden = true;
    return;
  }

  const candidates = buildGuidanceCandidates({
    alignment: latestAlignment,
    composition: latestComposition,
    orientation: latestOrientation,
    targetComposition,
  });
  const guidance = guidanceController.update(candidates, performance.now());
  pauseGuidanceButton.setAttribute("aria-pressed", String(guidance.paused));
  pauseGuidanceButton.textContent = guidance.paused ? "繼續提示" : "暫停提示";
  skipHintButton.hidden = guidance.paused || !guidance.candidate;

  if (guidance.paused) {
    guideHint.hidden = true;
    return;
  }
  if (guidance.candidate) {
    guideHint.textContent = guidance.candidate.text;
    guideHint.hidden = false;
    return;
  }
  if (!candidates.length && latestAlignment?.valid) {
    guideHint.textContent = latestComposition?.valid ? "人物與構圖對上了" : "人物配置已對上";
    guideHint.hidden = false;
    return;
  }
  guideHint.hidden = true;
}

function renderAlignment({ measurement }) {
  meter.style.display = "block";
  latestAlignment = measurement?.valid ? measurement : null;
  if (!measurement?.valid) {
    setMeterMessage(REASON_TEXT[measurement?.reason] || "暫無姿勢資料");
    renderGuideHint();
    return;
  }
  poseState.textContent = componentText("姿勢", measurement.pose);
  frameState.textContent = componentText("人物位置", measurement.framing);
  refreshOverallMeter();
  renderGuideHint();
}

function positionTargetHorizon() {
  if (!targetComposition?.valid) {
    targetHorizon.hidden = true;
    return;
  }
  targetHorizon.hidden = false;
  targetHorizon.style.top = `${targetComposition.horizon_y * 100}%`;
  targetHorizon.style.transform = `translateY(-50%) rotate(${targetComposition.roll_degrees}deg)`;
}

function updateComposition() {
  if (!ghostReady || !targetComposition?.valid || !video.videoWidth) return;
  const current = analyzeCompositionSource(video, { mirrored: camera.mode === "user" });
  latestComposition = compareHorizons(targetComposition, current);
  compositionState.textContent = latestComposition.valid
    ? componentText("構圖", latestComposition.score)
    : "構圖 --";
  refreshOverallMeter();
  renderGuideHint();
}

function stopCompositionLoop() {
  clearInterval(compositionTimer);
  compositionTimer = null;
}

function startCompositionLoop() {
  stopCompositionLoop();
  if (!guideEnabled || !ghostReady) return;
  updateComposition();
  compositionTimer = setInterval(updateComposition, 700);
}

function clearGhost() {
  alignmentController?.stop();
  stopCompositionLoop();
  guidanceController.reset();
  ghostReady = false;
  ghostLookStats = null;
  targetComposition = null;
  latestComposition = null;
  latestAlignment = null;
  ghost.style.display = "none";
  ghost.removeAttribute("src");
  targetHorizon.hidden = true;
  meter.style.display = "none";
  guideHint.hidden = true;
  pauseGuidanceButton.hidden = true;
  skipHintButton.hidden = true;
}

const camera = new CameraController({
  video,
  mirrorTargets: [video, ghost],
  trigger: element("start"),
  buttons: document.querySelectorAll("[data-camera-facing]"),
  onStarted: mode => {
    const replacedGhost = ghostReady;
    if (replacedGhost) clearGhost();
    setStatus(`${mode === "user" ? "前" : "後"}鏡頭已啟動，${replacedGhost ? "請重新召喚幽靈" : "按「召喚幽靈」"}`);
  },
  onError: error => setStatus(`無法開啟相機：${error.message}`),
});

alignmentController = new PoseAlignmentController({
  video,
  targetImage: ghost,
  stage,
  isMirrored: () => camera.mode === "user",
  onUpdate: renderAlignment,
  onState: state => {
    if (state.state === "loading") setMeterMessage("分析幽靈姿勢");
    if (state.state === "unavailable") {
      setMeterMessage(REASON_TEXT[state.reason] || "姿勢分析暫不可用");
    }
  },
});

const orientationController = new DeviceOrientationController({
  onUpdate: measurement => {
    latestOrientation = measurement;
    renderGuideHint();
  },
});

guideToggle.onclick = async () => {
  guideEnabled = !guideEnabled;
  guideToggle.setAttribute("aria-pressed", String(guideEnabled));
  compositionGuides.hidden = !guideEnabled;
  if (guideEnabled) {
    guidanceController.reset();
    const sensorAvailable = await orientationController.requestAndStart();
    startCompositionLoop();
    renderGuideHint();
    setStatus(sensorAvailable ? "構圖線與水平感測已開啟" : "構圖線已開啟");
  } else {
    orientationController.stop();
    guidanceController.reset();
    latestOrientation = null;
    stopCompositionLoop();
    guideHint.hidden = true;
    pauseGuidanceButton.hidden = true;
    skipHintButton.hidden = true;
    setStatus("構圖線已關閉");
  }
};

pauseGuidanceButton.onclick = () => {
  const paused = !guidanceController.state().paused;
  guidanceController.setPaused(paused, performance.now());
  renderGuideHint();
  setStatus(paused ? "即時提示已暫停" : "即時提示已繼續");
};

skipHintButton.onclick = () => {
  const skipped = guidanceController.skip(performance.now());
  renderGuideHint();
  if (skipped) setStatus("已略過目前提示");
};

function frameB64(size = 768) {
  const width = size;
  const height = Math.round(size * video.videoHeight / video.videoWidth) || size;
  const canvas = Object.assign(document.createElement("canvas"), { width, height });
  canvas.getContext("2d").drawImage(video, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
}

function userStylePreference() {
  return stylePromptEl.value.trim().replace(/\s+/g, " ").slice(0, 280);
}

function updatePriorityControls() {
  const controls = Array.from(document.querySelectorAll("[data-intent-priority]"));
  const selected = controls.filter(control => control.checked);
  const selectedIds = new Set(selected.map(control => control.value));
  for (const control of controls) {
    control.disabled = selected.length >= 3 && !control.checked;
    control.setCustomValidity("");
  }
  for (const input of document.querySelectorAll("[data-intent-field]")) {
    input.required = selectedIds.has(input.dataset.intentField);
  }
}

function populateIntentForm(profile) {
  for (const input of document.querySelectorAll("[data-intent-field]")) {
    input.value = profile.fields[input.dataset.intentField] || "";
  }
  for (const control of document.querySelectorAll("[data-intent-priority]")) {
    control.checked = profile.important_dimensions.includes(control.value);
  }
  intentSourcePrompt.textContent = profile.original_prompt
    ? `原始 Prompt：${profile.original_prompt}`
    : "原始 Prompt：使用預設自然旅拍";
  updatePriorityControls();
}

function collectIntentProfile() {
  const fields = Object.fromEntries(
    Array.from(document.querySelectorAll("[data-intent-field]"), input => [
      input.dataset.intentField,
      input.value,
    ]),
  );
  const importantDimensions = Array.from(
    document.querySelectorAll("[data-intent-priority]:checked"),
    input => input.value,
  );
  return normalizeIntentProfile({
    original_prompt: userStylePreference(),
    fields,
    important_dimensions: importantDimensions,
  });
}

function refreshIntentProfileStatus() {
  const confirmed = intentProfileMatchesPrompt(confirmedIntentProfile, userStylePreference());
  intentProfileStatus.dataset.state = confirmed ? "confirmed" : "unconfirmed";
  intentProfileStatus.textContent = confirmed
    ? buildIntentProfileSummary(confirmedIntentProfile)
    : "拍攝意圖尚未確認";
  reviewIntentButton.textContent = confirmed ? "編輯意圖" : "確認意圖";
}

function openIntentDialog({ generateAfterConfirm = false } = {}) {
  generateAfterIntentConfirmation = generateAfterConfirm;
  const prompt = userStylePreference();
  const draft = intentProfileMatchesPrompt(confirmedIntentProfile, prompt)
    ? confirmedIntentProfile
    : inferIntentProfile(prompt);
  populateIntentForm(draft);
  confirmIntentButton.textContent = generateAfterConfirm ? "套用並生成" : "套用意圖";
  intentDialog.showModal();
}

for (const control of document.querySelectorAll("[data-intent-priority]")) {
  control.onchange = updatePriorityControls;
}

stylePromptEl.oninput = refreshIntentProfileStatus;
reviewIntentButton.onclick = () => openIntentDialog();
element("cancelIntent").onclick = () => intentDialog.close();
intentDialog.addEventListener("close", () => {
  generateAfterIntentConfirmation = false;
});

intentForm.onsubmit = event => {
  event.preventDefault();
  const selectedPriorities = document.querySelectorAll("[data-intent-priority]:checked");
  if (!selectedPriorities.length) {
    const firstControl = document.querySelector("[data-intent-priority]");
    firstControl.setCustomValidity("請至少選擇一個重要面向");
    firstControl.reportValidity();
    return;
  }

  const shouldGenerate = generateAfterIntentConfirmation;
  const profile = collectIntentProfile();
  const changed = JSON.stringify(profile) !== JSON.stringify(confirmedIntentProfile);
  const replacedGhost = changed && ghostReady && !shouldGenerate;
  confirmedIntentProfile = profile;
  intentDialog.close();
  refreshIntentProfileStatus();
  log.push({
    ts: new Date().toISOString(),
    event: "intent_profile_confirmed",
    intent_profile: profile,
  });
  saveLog();

  if (replacedGhost) clearGhost();
  if (shouldGenerate) {
    void generateGhost(profile);
  } else {
    setStatus(replacedGhost ? "拍攝意圖已更新，請重新召喚幽靈" : "拍攝意圖已確認");
  }
};

refreshIntentProfileStatus();

function prepareGhostTargets() {
  const mirrored = camera.mode === "user";
  ghostLookStats = analyzeLookSource(ghost, { mirrored });
  targetComposition = analyzeCompositionSource(ghost, { mirrored });
  positionTargetHorizon();
  startCompositionLoop();
}

async function generateGhost(intentProfile) {
  const summonButton = element("summon");
  const key = keyEl.value.trim();
  const normalizedProfile = normalizeIntentProfile(intentProfile);
  const stylePreference = normalizedProfile.original_prompt;
  clearGhost();
  activeIntentProfile = normalizedProfile;
  activeIntentSummary = buildIntentProfileSummary(normalizedProfile) || DEFAULT_INTENT_LABEL;
  const endpoint = key
    ? `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`
    : "/api/ghost";
  element("spin").style.display = "block";
  summonButton.disabled = true;
  setStatus(stylePreference ? `生成中：${stylePreference.slice(0, 24)}${stylePreference.length > 24 ? "…" : ""}` : "生成中…");
  const startedAt = performance.now();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/jpeg", data: frameB64() } },
            { text: buildPhotographyGhostPrompt(normalizedProfile) },
          ],
        }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`HTTP ${response.status}: ${error.error?.message || "request failed"}`);
    }
    const data = await response.json();
    const imagePart = data.candidates?.[0]?.content?.parts?.find(part => part.inlineData);
    if (!imagePart) throw new Error(`回應沒有影像：${JSON.stringify(data).slice(0, 200)}`);
    ghost.src = `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
    await ghost.decode();
    ghost.style.display = "block";
    ghost.style.opacity = element("op").value / 100;
    ghostReady = true;
    prepareGhostTargets();
    const latencySeconds = ((performance.now() - startedAt) / 1000).toFixed(1);
    let alignmentAvailable = false;
    try {
      await alignmentController.setTarget();
      alignmentAvailable = true;
    } catch (error) {
      setMeterMessage(error.message || "幽靈姿勢無法辨識");
    }
    setStatus(`幽靈已附身（${latencySeconds}s），${alignmentAvailable ? "把自己對進去" : "可使用疊影與構圖線"}`);
    log.push({
      ts: new Date().toISOString(),
      event: "ghost_generated",
      latency_s: Number(latencySeconds),
      original_intent: stylePreference || DEFAULT_INTENT_LABEL,
      intent_summary: activeIntentSummary,
      intent_profile: activeIntentProfile,
      photography_prompt_version: PHOTOGRAPHY_PROMPT_VERSION,
      style_mode: stylePreference ? "custom" : "default",
      style_prompt_len: stylePreference.length,
      alignment_mode: alignmentAvailable ? MATCH_METRIC_VERSION : "unavailable",
      look_analysis: ghostLookStats.valid ? ghostLookStats.metric_version : "unavailable",
      composition_analysis: targetComposition.valid ? targetComposition.metric_version : "unavailable",
    });
    saveLog();
  } catch (error) {
    setStatus(`生成失敗：${error.message}`);
  } finally {
    element("spin").style.display = "none";
    summonButton.disabled = false;
  }
}

element("summon").onclick = () => {
  if (!video.videoWidth) return setStatus("先開相機");
  if (!intentProfileMatchesPrompt(confirmedIntentProfile, userStylePreference())) {
    openIntentDialog({ generateAfterConfirm: true });
    return;
  }
  void generateGhost(confirmedIntentProfile);
};

element("op").oninput = event => {
  ghost.style.opacity = event.target.value / 100;
};

function dimensionInput(score, confidence, reason) {
  return Number.isFinite(score) ? { score, confidence } : { reason };
}

function renderIntentReceipt(receipt) {
  intentReceipt.hidden = false;
  receiptBand.dataset.band = receipt.band;
  receiptBand.textContent = `可觀察偏差：${receipt.band_label}`;
  receiptCoverage.textContent = `量測 ${receipt.coverage.measured}/${receipt.coverage.total}`;
  receiptPrompt.textContent = `原始意圖：${receipt.original_intent}`;
  receiptDimensions.replaceChildren();
  for (const dimension of receipt.dimensions) {
    const item = document.createElement("div");
    item.className = "receipt-dimension";
    item.dataset.band = dimension.band;
    const label = document.createElement("strong");
    label.textContent = dimension.label;
    const value = document.createElement("span");
    value.textContent = formatIntentDimensionEvidence(dimension);
    item.append(label, value);
    receiptDimensions.append(item);
  }
  for (const button of document.querySelectorAll("[data-intent-judgment]")) {
    button.setAttribute("aria-pressed", "false");
  }
}

for (const button of document.querySelectorAll("[data-intent-judgment]")) {
  button.onclick = () => {
    const judgment = normalizeIntentJudgment(button.dataset.intentJudgment);
    if (!judgment || !activeShotEntry?.intent) return;
    activeShotEntry.intent.user_judgment = judgment;
    activeShotEntry.intent.user_judgment_at = new Date().toISOString();
    for (const peer of document.querySelectorAll("[data-intent-judgment]")) {
      peer.setAttribute("aria-pressed", String(peer === button));
    }
    saveLog();
    setStatus("已記錄你對原始意圖的判斷");
  };
}

function canvasBlob(canvas, type = "image/jpeg", quality = 0.9) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error("無法建立原始照片"));
    }, type, quality);
  });
}

element("shoot").onclick = async () => {
  if (!video.videoWidth) return;
  const shootButton = element("shoot");
  shootButton.disabled = true;
  editPhotoButton.disabled = true;
  const canvas = Object.assign(document.createElement("canvas"), {
    width: video.videoWidth,
    height: video.videoHeight,
  });
  try {
    renderCameraFrame(
      canvas.getContext("2d"),
      video,
      canvas.width,
      canvas.height,
      NEUTRAL_CAPTURE_LOOK,
      { mirrored: camera.mode === "user" },
    );
    const originalBlob = await canvasBlob(canvas);
    const alignment = ghostReady ? alignmentController.summary() : null;
    const actualLook = analyzeLookSource(canvas);
    const lookMatch = ghostReady ? measureLookSimilarity(ghostLookStats, actualLook) : null;
    const currentComposition = ghostReady
      ? analyzeCompositionSource(video, { mirrored: camera.mode === "user" })
      : null;
    const compositionMatch = ghostReady
      ? compareHorizons(targetComposition, currentComposition)
      : null;
    latestComposition = compositionMatch?.valid ? compositionMatch : latestComposition;

    const shotIntentProfile = ghostReady ? activeIntentProfile : confirmedIntentProfile;
    const originalPrompt = shotIntentProfile?.original_prompt || DEFAULT_INTENT_LABEL;
    const receipt = ghostReady ? buildIntentReceipt({
      prompt: originalPrompt,
      pose: dimensionInput(
        alignment?.final?.pose / 100,
        alignment?.final?.confidence,
        "pose_unavailable",
      ),
      placement: dimensionInput(
        alignment?.final?.framing / 100,
        alignment?.final?.confidence,
        "placement_unavailable",
      ),
      composition: dimensionInput(
        compositionMatch?.score,
        compositionMatch?.confidence,
        compositionMatch?.reason || "composition_unavailable",
      ),
      look: dimensionInput(
        lookMatch?.score,
        lookMatch?.confidence,
        lookMatch?.reason || "look_unavailable",
      ),
    }) : null;
    const shotSummary = {
      alignment,
      composition: compositionMatch,
      orientation: orientationController.summary(),
      look_match: lookMatch,
      camera: {
        facing: camera.mode,
        mirrored_capture: camera.mode === "user",
      },
    };
    const storedSession = await saveCaptureSession({
      created_at: new Date().toISOString(),
      original_blob: originalBlob,
      ghost_blob: ghostReady ? dataUrlToBlob(ghost.src) : null,
      ghost_mirrored: camera.mode === "user",
      intent_profile: shotIntentProfile,
      original_intent: originalPrompt,
      target_look: ghostLookStats,
      receipt,
      shot_summary: shotSummary,
    });

    activeShotEntry = {
      ts: storedSession.created_at,
      event: "shot",
      ...shotSummary,
      capture_render: "original_unfiltered",
      capture_session: captureSessionMetadata(storedSession),
      intent_profile: storedSession.intent_profile,
      intent: receipt ? { receipt, user_judgment: null } : null,
    };
    log.push(activeShotEntry);
    saveLog();

    if (resultOriginalUrl) URL.revokeObjectURL(resultOriginalUrl);
    resultOriginalUrl = URL.createObjectURL(originalBlob);
    element("resReal").src = resultOriginalUrl;
    result.dataset.mode = ghostReady ? "comparison" : "solo";
    ghostResult.hidden = !ghostReady;
    intentReceipt.hidden = !receipt;
    result.style.display = "grid";
    editPhotoButton.disabled = false;
    if (ghostReady) {
      resultGhostImage.src = ghost.src;
      resultGhostImage.classList.toggle("is-front-camera", camera.mode === "user");
      renderIntentReceipt(receipt);
      setStatus(`原圖已保存。${receipt.band_label}，量測 ${receipt.coverage.measured}/${receipt.coverage.total}。`);
    } else {
      setStatus("原圖已保存（無 AI 幽靈參考）。");
    }
  } catch (error) {
    setStatus(`拍攝保存失敗：${error.message}`);
  } finally {
    shootButton.disabled = false;
  }
};

element("close").onclick = () => {
  result.style.display = "none";
};

editPhotoButton.onclick = () => {
  if (!editPhotoButton.disabled) window.location.assign("/ghost-edit");
};

window.addEventListener("pagehide", () => {
  if (resultOriginalUrl) URL.revokeObjectURL(resultOriginalUrl);
  stopCompositionLoop();
  orientationController.stop();
  alignmentController.dispose();
  camera.stop();
});
