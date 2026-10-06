import {
  EFFECT_PRESETS,
  FILTER_PRESETS,
  cameraLookLabel,
  renderCameraFrame,
  resetLookAdjustments,
  resolveCameraLook,
} from "./camera-effects.js";
import {
  captureSessionMetadata,
  loadCaptureSession,
} from "./capture-session.js";
import {
  analyzeImageData,
  estimateLookRecipe,
  normalizeLookAdjustments,
} from "./look-matching.js";

const PREVIEW_MAX_DIMENSION = 1280;
const EDIT_STATE_KEY = "ghost_edit_state";
const NEUTRAL_LOOK = Object.freeze({ filter: "original", effect: "none" });
const element = id => document.getElementById(id);

const canvas = element("editCanvas");
const filterSelect = element("filterSelect");
const effectSelect = element("effectSelect");
const syncLookButton = element("syncLook");
const savePhotoButton = element("savePhoto");
const viewModes = element("viewModes");
const editorControls = element("editorControls");
const emptyState = element("emptyState");

let session = null;
let originalImage = null;
let ghostImage = null;
let targetLook = null;
let currentLook = resolveCameraLook();
let viewMode = "edited";
const objectUrls = [];

function readStoredJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || "") ?? fallback;
  } catch {
    return fallback;
  }
}

function appendLog(entry) {
  const existing = readStoredJson("ghost_log", []);
  const log = Array.isArray(existing) ? existing : [];
  log.push({ ts: new Date().toISOString(), ...entry });
  localStorage.setItem("ghost_log", JSON.stringify(log.slice(-200)));
}

function setStatus(message) {
  element("editorStatus").textContent = message;
}

function fillPresetSelect(select, presets) {
  const groups = new Map();
  for (const preset of presets) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.label;
    if (!preset.group) {
      select.append(option);
      continue;
    }
    if (!groups.has(preset.group)) {
      const group = document.createElement("optgroup");
      group.label = preset.group;
      groups.set(preset.group, group);
      select.append(group);
    }
    groups.get(preset.group).append(option);
  }
}

function imageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("照片解碼失敗"));
    image.src = url;
  });
}

function sourceSize(source) {
  return {
    width: source.naturalWidth || source.width || 0,
    height: source.naturalHeight || source.height || 0,
  };
}

function fittedSize(source, maxDimension = PREVIEW_MAX_DIMENSION) {
  const size = sourceSize(source);
  const scale = Math.min(1, maxDimension / Math.max(size.width, size.height));
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

function drawCover(context, source, width, height, mirrored = false) {
  const size = sourceSize(source);
  const scale = Math.max(width / size.width, height / size.height);
  const sourceWidth = width / scale;
  const sourceHeight = height / scale;
  const sourceX = (size.width - sourceWidth) / 2;
  const sourceY = (size.height - sourceHeight) / 2;
  context.save();
  if (mirrored) {
    context.translate(width, 0);
    context.scale(-1, 1);
  }
  context.drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
  context.restore();
}

function renderPreview() {
  if (!originalImage) return;
  const size = fittedSize(originalImage);
  if (canvas.width !== size.width || canvas.height !== size.height) {
    canvas.width = size.width;
    canvas.height = size.height;
  }
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (viewMode === "ghost" && ghostImage) {
    drawCover(context, ghostImage, canvas.width, canvas.height, session.ghost_mirrored);
  } else {
    renderCameraFrame(
      context,
      originalImage,
      canvas.width,
      canvas.height,
      viewMode === "original" ? NEUTRAL_LOOK : currentLook,
    );
  }
  canvas.dataset.view = viewMode;
  for (const button of document.querySelectorAll("[data-view-mode]")) {
    button.setAttribute("aria-pressed", String(button.dataset.viewMode === viewMode));
  }
}

function analyzeImage(source) {
  const size = fittedSize(source, 192);
  const sample = Object.assign(document.createElement("canvas"), size);
  const context = sample.getContext("2d", { willReadFrequently: true });
  context.drawImage(source, 0, 0, size.width, size.height);
  return analyzeImageData(context.getImageData(0, 0, size.width, size.height));
}

function writeLookControls(adjustments) {
  const normalized = normalizeLookAdjustments(adjustments);
  for (const input of document.querySelectorAll("[data-look-control]")) {
    const key = input.dataset.lookControl;
    const scaled = Math.round(normalized[key] * 100);
    input.value = String(scaled);
    const output = document.querySelector(`[data-look-output="${key}"]`);
    output.value = key === "temperature" && scaled > 0 ? `+${scaled}` : String(scaled);
  }
}

function readLookControls() {
  return normalizeLookAdjustments(Object.fromEntries(
    Array.from(document.querySelectorAll("[data-look-control]"), input => [
      input.dataset.lookControl,
      Number(input.value) / 100,
    ]),
  ));
}

function persistLook() {
  if (!session) return;
  localStorage.setItem(EDIT_STATE_KEY, JSON.stringify({
    session_created_at: session.created_at,
    look: currentLook,
  }));
}

function setLook(nextLook, { announce = true, persist = true } = {}) {
  currentLook = resolveCameraLook(nextLook);
  filterSelect.value = currentLook.filter;
  effectSelect.value = currentLook.effect;
  writeLookControls(currentLook.adjustments);
  viewMode = "edited";
  renderPreview();
  if (persist) persistLook();
  if (announce) setStatus(cameraLookLabel(currentLook));
}

function restoredLook() {
  const stored = readStoredJson(EDIT_STATE_KEY, null);
  return stored?.session_created_at === session?.created_at
    ? resolveCameraLook(stored.look)
    : resolveCameraLook();
}

function canvasBlob(sourceCanvas, type = "image/jpeg", quality = 0.92) {
  return new Promise((resolve, reject) => {
    sourceCanvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error("無法建立後製照片"));
    }, type, quality);
  });
}

function setViewMode(mode) {
  if (!new Set(["edited", "original", "ghost"]).has(mode)) return;
  if (mode === "ghost" && !ghostImage) return;
  viewMode = mode;
  renderPreview();
}

fillPresetSelect(filterSelect, FILTER_PRESETS);
fillPresetSelect(effectSelect, EFFECT_PRESETS);

filterSelect.onchange = () => setLook({ ...currentLook, filter: filterSelect.value });
effectSelect.onchange = () => setLook({ ...currentLook, effect: effectSelect.value });
for (const input of document.querySelectorAll("[data-look-control]")) {
  input.oninput = () => setLook({ ...currentLook, adjustments: readLookControls() }, { announce: false });
}
for (const button of document.querySelectorAll("[data-view-mode]")) {
  button.onclick = () => setViewMode(button.dataset.viewMode);
}

element("resetLook").onclick = () => {
  setLook(resetLookAdjustments(currentLook));
  appendLog({ event: "post_look_reset", capture_created_at: session?.created_at });
};

syncLookButton.onclick = () => {
  if (!targetLook || !originalImage) return;
  const recipe = estimateLookRecipe(targetLook, analyzeImage(originalImage));
  if (!recipe.valid) {
    setStatus("AI 色調暫不可用");
    return;
  }
  setLook({ ...NEUTRAL_LOOK, adjustments: recipe.adjustments }, { announce: false });
  setStatus("已套用 AI 色調");
  appendLog({
    event: "post_ai_look_synced",
    capture_created_at: session.created_at,
    metric_version: recipe.metric_version,
    confidence: recipe.confidence,
    adjustments: recipe.adjustments,
  });
};

savePhotoButton.onclick = async () => {
  if (!originalImage) return;
  savePhotoButton.disabled = true;
  try {
    const size = sourceSize(originalImage);
    const output = Object.assign(document.createElement("canvas"), size);
    renderCameraFrame(output.getContext("2d"), originalImage, size.width, size.height, currentLook);
    const blob = await canvasBlob(output);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `openhci-ghost-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    setStatus("照片已儲存");
    appendLog({
      event: "post_photo_saved",
      capture_created_at: session.created_at,
      output: { type: blob.type, size: blob.size, width: size.width, height: size.height },
      look: currentLook,
    });
  } catch (error) {
    setStatus(`儲存失敗：${error.message}`);
  } finally {
    savePhotoButton.disabled = false;
  }
};

function showEmptyState() {
  emptyState.hidden = false;
  editorControls.hidden = true;
  viewModes.hidden = true;
  savePhotoButton.disabled = true;
}

async function initialize() {
  try {
    session = await loadCaptureSession();
    if (!session) return showEmptyState();
    originalImage = await imageFromBlob(session.original_blob);
    if (session.ghost_blob) {
      try {
        ghostImage = await imageFromBlob(session.ghost_blob);
      } catch {
        ghostImage = null;
      }
    }
    targetLook = ghostImage ? analyzeImage(ghostImage) : null;
    emptyState.hidden = true;
    editorControls.hidden = false;
    viewModes.hidden = false;
    document.querySelector('[data-view-mode="ghost"]').hidden = !ghostImage;
    syncLookButton.disabled = !targetLook?.valid;
    savePhotoButton.disabled = false;

    const fields = session.intent_profile?.fields || {};
    element("lookIntent").textContent = [fields.color, fields.mood].filter(Boolean).join("；") || "原始外觀";
    element("captureBand").textContent = session.receipt
      ? `拍攝符合度：${session.receipt.band_label} · ${session.receipt.coverage.measured}/${session.receipt.coverage.total}`
      : "";
    currentLook = restoredLook();
    setLook(currentLook, { announce: false, persist: false });
    setStatus("原圖已載入");
    appendLog({
      event: "post_editor_opened",
      capture_session: captureSessionMetadata(session),
    });
  } catch {
    showEmptyState();
  }
}

window.addEventListener("pagehide", () => {
  for (const url of objectUrls) URL.revokeObjectURL(url);
});

void initialize();
