import { normalizeIntentProfile } from "./intent-profile.js";

export const CAPTURE_SESSION_VERSION = "capture-session-v1";
export const CAPTURE_DB_NAME = "openhci-ghost";
export const CAPTURE_STORE_NAME = "capture-sessions";
export const CAPTURE_SESSION_KEY = "latest";

function isBlobLike(value) {
  return Boolean(
    value &&
    Number.isFinite(value.size) &&
    value.size > 0 &&
    typeof value.type === "string" &&
    typeof value.arrayBuffer === "function"
  );
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function normalizeTargetLook(value) {
  if (!value?.valid) return null;
  const normalized = {
    valid: true,
    metric_version: String(value.metric_version || "unknown"),
    mean_luma: finiteNumber(value.mean_luma),
    contrast: finiteNumber(value.contrast),
    saturation: finiteNumber(value.saturation),
    temperature: finiteNumber(value.temperature),
    sample_count: finiteNumber(value.sample_count),
    confidence: finiteNumber(value.confidence),
  };
  return ["mean_luma", "contrast", "saturation", "temperature", "confidence"]
    .every(key => normalized[key] !== null)
    ? normalized
    : null;
}

function cloneMetadata(value, depth = 0) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (depth >= 8 || isBlobLike(value)) return null;
  if (Array.isArray(value)) return value.map(item => cloneMetadata(item, depth + 1));
  if (typeof value !== "object") return null;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneMetadata(item, depth + 1)]),
  );
}

export function normalizeCaptureSession(input = {}) {
  if (!isBlobLike(input.original_blob)) {
    throw new TypeError("capture session requires a non-empty original image Blob");
  }
  const ghostBlob = isBlobLike(input.ghost_blob) ? input.ghost_blob : null;
  const createdAt = Number.isFinite(Date.parse(input.created_at))
    ? new Date(input.created_at).toISOString()
    : new Date().toISOString();

  return {
    id: CAPTURE_SESSION_KEY,
    version: CAPTURE_SESSION_VERSION,
    created_at: createdAt,
    original_blob: input.original_blob,
    ghost_blob: ghostBlob,
    ghost_mirrored: Boolean(ghostBlob && input.ghost_mirrored),
    intent_profile: input.intent_profile ? normalizeIntentProfile(input.intent_profile) : null,
    original_intent: String(input.original_intent || "").trim().slice(0, 280),
    target_look: normalizeTargetLook(input.target_look),
    receipt: cloneMetadata(input.receipt),
    shot_summary: cloneMetadata(input.shot_summary),
  };
}

export function captureSessionMetadata(input) {
  const session = normalizeCaptureSession(input);
  return {
    version: session.version,
    created_at: session.created_at,
    original: {
      type: session.original_blob.type,
      size: session.original_blob.size,
    },
    ghost: session.ghost_blob ? {
      type: session.ghost_blob.type,
      size: session.ghost_blob.size,
      mirrored: session.ghost_mirrored,
    } : null,
    has_intent_profile: Boolean(session.intent_profile),
    has_target_look: Boolean(session.target_look),
    has_receipt: Boolean(session.receipt),
  };
}

export function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataUrl || ""));
  if (!match) throw new TypeError("valid data URL required");
  const mimeType = match[1] || "application/octet-stream";
  const binary = match[2]
    ? atob(match[3])
    : decodeURIComponent(match[3]);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return new Blob([bytes], { type: mimeType });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("indexeddb_request_failed"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("indexeddb_transaction_failed"));
    transaction.onabort = () => reject(transaction.error || new Error("indexeddb_transaction_aborted"));
  });
}

async function openCaptureDatabase(indexedDBFactory = globalThis.indexedDB) {
  if (!indexedDBFactory?.open) throw new Error("indexeddb_unavailable");
  const request = indexedDBFactory.open(CAPTURE_DB_NAME, 1);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(CAPTURE_STORE_NAME)) {
      database.createObjectStore(CAPTURE_STORE_NAME, { keyPath: "id" });
    }
  };
  return requestResult(request);
}

export async function saveCaptureSession(input, options = {}) {
  const session = normalizeCaptureSession(input);
  const database = await openCaptureDatabase(options.indexedDB);
  try {
    const transaction = database.transaction(CAPTURE_STORE_NAME, "readwrite");
    const request = transaction.objectStore(CAPTURE_STORE_NAME).put(session);
    await Promise.all([requestResult(request), transactionDone(transaction)]);
    return session;
  } finally {
    database.close();
  }
}

export async function loadCaptureSession(options = {}) {
  const database = await openCaptureDatabase(options.indexedDB);
  try {
    const transaction = database.transaction(CAPTURE_STORE_NAME, "readonly");
    const request = transaction.objectStore(CAPTURE_STORE_NAME).get(CAPTURE_SESSION_KEY);
    const [stored] = await Promise.all([requestResult(request), transactionDone(transaction)]);
    if (!stored) return null;
    try {
      return normalizeCaptureSession(stored);
    } catch {
      return null;
    }
  } finally {
    database.close();
  }
}

export async function clearCaptureSession(options = {}) {
  const database = await openCaptureDatabase(options.indexedDB);
  try {
    const transaction = database.transaction(CAPTURE_STORE_NAME, "readwrite");
    const request = transaction.objectStore(CAPTURE_STORE_NAME).delete(CAPTURE_SESSION_KEY);
    await Promise.all([requestResult(request), transactionDone(transaction)]);
  } finally {
    database.close();
  }
}
