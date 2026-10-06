import { renderSVG } from "uqr";

export const CUTS_BACKUP_BINDING = "CUTS_BACKUPS";
export const CUTS_BACKUP_SCHEMA_VERSION = 1;
export const MAX_BACKUP_FILE_BYTES = 12 * 1024 * 1024;
export const MAX_BACKUP_TOTAL_BYTES = 50 * 1024 * 1024;

const BACKUP_PREFIX = "cuts-backups";
const BACKUP_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const FRAME_IDS = new Set(["white", "gray", "black", "openhci"]);
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const FINAL_TYPES = new Set(["image/png"]);
const GIF_TYPES = new Set(["image/gif"]);

class BackupError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "BackupError";
    this.code = code;
    this.status = status;
  }
}

const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      ...headers,
    },
  });

function errorResponse(error) {
  if (error instanceof BackupError) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
  console.error(JSON.stringify({
    event: "cuts_backup_error",
    message: error instanceof Error ? error.message : String(error),
  }));
  return json(
    { error: { code: "cuts_backup_unavailable", message: "雲端備份暫時無法使用，請稍後再試。" } },
    503,
  );
}

function getBucket(env) {
  const bucket = env?.[CUTS_BACKUP_BINDING];
  if (!bucket) {
    throw new BackupError(
      "cuts_backup_not_configured",
      "雲端備份尚未完成設定。",
      503,
    );
  }
  return bucket;
}

function requireSameOrigin(request) {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (!origin || origin !== requestOrigin) {
    throw new BackupError("cuts_backup_origin_denied", "只接受本站發出的備份請求。", 403);
  }
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function createBackupSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

function parseBackupSecret(request) {
  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
  if (!match) {
    throw new BackupError("cuts_backup_not_found", "找不到這份雲端備份。", 404);
  }
  return match[1];
}

export async function backupIdForSecret(secret) {
  if (!BACKUP_SECRET_PATTERN.test(secret)) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function backupUrlForRequest(request, secret) {
  return `${new URL(request.url).origin}/cuts-backup#${secret}`;
}

function backupPrefix(backupId) {
  return `${BACKUP_PREFIX}/${backupId}`;
}

function manifestKey(backupId) {
  return `${backupPrefix(backupId)}/manifest.json`;
}

function asBoundedString(value, field, maxLength, { optional = false } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new BackupError("cuts_backup_invalid_metadata", `${field} 格式不正確。`);
  }
  return value;
}

function asOptionalBoolean(value, field) {
  if (value == null) return null;
  if (typeof value !== "boolean") {
    throw new BackupError("cuts_backup_invalid_metadata", `${field} 格式不正確。`);
  }
  return value;
}

function validateProposal(value, shotIndex) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BackupError("cuts_backup_invalid_metadata", `第 ${shotIndex} 張 AI 提案格式不正確。`);
  }
  return {
    promptInputRaw: asBoundedString(value.promptInputRaw, `第 ${shotIndex} 張原始 prompt`, 280),
    stylePreference: asBoundedString(value.stylePreference, `第 ${shotIndex} 張使用 prompt`, 280),
    imagePrompt: asBoundedString(value.imagePrompt, `第 ${shotIndex} 張完整生圖 prompt`, 8_000),
    reason: asBoundedString(value.reason, `第 ${shotIndex} 張提案文字`, 2_000, { optional: true }),
    strategy: asBoundedString(value.strategy, `第 ${shotIndex} 張生成策略`, 80),
    model: asBoundedString(value.model, `第 ${shotIndex} 張模型`, 120),
    modelLabel: asBoundedString(value.modelLabel, `第 ${shotIndex} 張模型名稱`, 160, { optional: true }),
    requestedModel: asBoundedString(value.requestedModel, `第 ${shotIndex} 張請求模型`, 120, { optional: true }),
    upstream: asBoundedString(value.upstream, `第 ${shotIndex} 張生成來源`, 120, { optional: true }),
  };
}

function validateMetadata(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BackupError("cuts_backup_invalid_metadata", "備份資料格式不正確。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BackupError("cuts_backup_invalid_metadata", "備份資料格式不正確。");
  }
  if (value.schemaVersion !== CUTS_BACKUP_SCHEMA_VERSION) {
    throw new BackupError("cuts_backup_invalid_metadata", "不支援這個備份版本。");
  }
  if (value.cutsTotal !== 1 && value.cutsTotal !== 2) {
    throw new BackupError("cuts_backup_invalid_metadata", "拍貼格式不正確。");
  }
  if (!FRAME_IDS.has(value.frameId)) {
    throw new BackupError("cuts_backup_invalid_metadata", "拍貼框格式不正確。");
  }
  if (!Array.isArray(value.shots) || value.shots.length !== value.cutsTotal) {
    throw new BackupError("cuts_backup_invalid_metadata", "照片數量與拍貼格式不一致。");
  }
  const shots = value.shots.map((shot, index) => {
    const shotIndex = index + 1;
    if (!shot || typeof shot !== "object" || Array.isArray(shot) || shot.index !== shotIndex) {
      throw new BackupError("cuts_backup_invalid_metadata", `第 ${shotIndex} 張資料格式不正確。`);
    }
    const generated = Boolean(shot.generated);
    const proposal = validateProposal(shot.proposal, shotIndex);
    if (generated !== Boolean(proposal)) {
      throw new BackupError("cuts_backup_invalid_metadata", `第 ${shotIndex} 張 AI 提案狀態不一致。`);
    }
    return {
      index: shotIndex,
      generated,
      promptInputRaw: asBoundedString(shot.promptInputRaw, `第 ${shotIndex} 張 prompt`, 280),
      cameraFacing: shot.cameraFacing === "user" || shot.cameraFacing === "environment"
        ? shot.cameraFacing
        : null,
      capturedMirrored: asOptionalBoolean(shot.capturedMirrored, `第 ${shotIndex} 張鏡像狀態`),
      ghostMirrored: asOptionalBoolean(shot.ghostMirrored, `第 ${shotIndex} 張提案鏡像狀態`),
      proposal,
    };
  });
  return {
    schemaVersion: CUTS_BACKUP_SCHEMA_VERSION,
    cutsTotal: value.cutsTotal,
    format: value.cutsTotal === 1 ? "3:4" : "4:3 x 2",
    frameId: value.frameId,
    shots,
  };
}

function isBlobLike(value) {
  return value && typeof value === "object" &&
    typeof value.arrayBuffer === "function" &&
    typeof value.slice === "function" &&
    typeof value.size === "number" &&
    typeof value.type === "string";
}

function extensionForType(type) {
  if (type === "image/jpeg") return "jpg";
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "image/gif") return "gif";
  return "bin";
}

function bytesEqual(bytes, expected, offset = 0) {
  return expected.every((value, index) => bytes[offset + index] === value);
}

async function hasExpectedMagic(file) {
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (file.type === "image/jpeg") return bytesEqual(bytes, [0xff, 0xd8, 0xff]);
  if (file.type === "image/png") return bytesEqual(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (file.type === "image/webp") {
    return bytesEqual(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      bytesEqual(bytes, [0x57, 0x45, 0x42, 0x50], 8);
  }
  if (file.type === "image/gif") {
    const header = new TextDecoder().decode(bytes.slice(0, 6));
    return header === "GIF87a" || header === "GIF89a";
  }
  return false;
}

async function validateFile(file, fieldName, allowedTypes) {
  if (!isBlobLike(file) || !allowedTypes.has(file.type)) {
    throw new BackupError("cuts_backup_invalid_file", `${fieldName} 不是支援的圖片格式。`);
  }
  if (file.size <= 0 || file.size > MAX_BACKUP_FILE_BYTES) {
    throw new BackupError("cuts_backup_invalid_file", `${fieldName} 的檔案大小不正確。`);
  }
  if (!(await hasExpectedMagic(file))) {
    throw new BackupError("cuts_backup_invalid_file", `${fieldName} 的檔案內容與格式不一致。`);
  }
  return file;
}

function publicFileRecord({ id, kind, shotIndex = null, filename, file }) {
  return {
    id,
    kind,
    shotIndex,
    filename,
    contentType: file.type,
    size: file.size,
  };
}

function objectKeyForFile(backupId, record) {
  return `${backupPrefix(backupId)}/${record.id}.${extensionForType(record.contentType)}`;
}

async function readManifest(bucket, backupId) {
  const object = await bucket.get(manifestKey(backupId));
  if (!object) return null;
  try {
    return JSON.parse(await object.text());
  } catch {
    return null;
  }
}

function readyResponse(request, secret, manifest) {
  const backupUrl = backupUrlForRequest(request, secret);
  return json({
    backupUrl,
    manifest,
    qrSvg: renderSVG(backupUrl, { ecc: "M", border: 4, pixelSize: 8 }),
  }, 200);
}

async function issueToken(request) {
  requireSameOrigin(request);
  const secret = createBackupSecret();
  return json({ secret, backupUrl: backupUrlForRequest(request, secret) }, 201);
}

async function createBackup(request, env) {
  requireSameOrigin(request);
  const bucket = getBucket(env);
  const secret = parseBackupSecret(request);
  const backupId = await backupIdForSecret(secret);
  const existing = await readManifest(bucket, backupId);
  if (existing) return readyResponse(request, secret, existing);

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BACKUP_TOTAL_BYTES) {
    throw new BackupError("cuts_backup_too_large", "這次備份的總檔案大小超過限制。", 413);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    throw new BackupError("cuts_backup_invalid_form", "無法讀取備份檔案。");
  }
  const rawMetadata = form.get("metadata");
  if (typeof rawMetadata !== "string" || rawMetadata.length > 24_000) {
    throw new BackupError("cuts_backup_invalid_metadata", "備份資料格式不正確。");
  }
  const metadata = validateMetadata(rawMetadata);
  const acceptedFields = new Set(["metadata", "final", "liveGif"]);
  for (let index = 1; index <= metadata.cutsTotal; index += 1) {
    acceptedFields.add(`photo-${index}`);
    if (metadata.shots[index - 1].generated) acceptedFields.add(`ghost-${index}`);
  }
  for (const field of form.keys()) {
    if (!acceptedFields.has(field)) {
      throw new BackupError("cuts_backup_unexpected_file", "備份包含未預期的檔案。");
    }
  }

  const uploads = [];
  for (const shot of metadata.shots) {
    const photo = await validateFile(form.get(`photo-${shot.index}`), `第 ${shot.index} 張照片`, IMAGE_TYPES);
    const photoRecord = publicFileRecord({
      id: `photo-${shot.index}`,
      kind: "photo",
      shotIndex: shot.index,
      filename: `aidentity_cut${shot.index}_photo.${extensionForType(photo.type)}`,
      file: photo,
    });
    uploads.push({ file: photo, record: photoRecord });
    if (shot.generated) {
      const ghost = await validateFile(form.get(`ghost-${shot.index}`), `第 ${shot.index} 張 AI 提案`, IMAGE_TYPES);
      const ghostRecord = publicFileRecord({
        id: `ghost-${shot.index}`,
        kind: "ghost",
        shotIndex: shot.index,
        filename: `aidentity_cut${shot.index}_ghost.${extensionForType(ghost.type)}`,
        file: ghost,
      });
      uploads.push({ file: ghost, record: ghostRecord });
    }
  }
  const finalImage = await validateFile(form.get("final"), "完整拍貼", FINAL_TYPES);
  uploads.push({
    file: finalImage,
    record: publicFileRecord({
      id: "final",
      kind: "final",
      filename: `aidentity_${metadata.cutsTotal}cuts_${metadata.frameId}.png`,
      file: finalImage,
    }),
  });
  const liveGif = await validateFile(form.get("liveGif"), "原況拍貼 GIF", GIF_TYPES);
  uploads.push({
    file: liveGif,
    record: publicFileRecord({
      id: "live-gif",
      kind: "live-gif",
      filename: `aidentity_${metadata.cutsTotal}cuts_${metadata.frameId}_live.gif`,
      file: liveGif,
    }),
  });

  const totalBytes = uploads.reduce((sum, upload) => sum + upload.file.size, 0);
  if (totalBytes > MAX_BACKUP_TOTAL_BYTES) {
    throw new BackupError("cuts_backup_too_large", "這次備份的總檔案大小超過限制。", 413);
  }

  await Promise.all(uploads.map(({ file, record }) => bucket.put(
    objectKeyForFile(backupId, record),
    file,
    {
      httpMetadata: { contentType: record.contentType },
      customMetadata: { kind: record.kind, shotIndex: String(record.shotIndex || "") },
    },
  )));

  const manifest = {
    ...metadata,
    createdAt: new Date().toISOString(),
    files: uploads.map(upload => upload.record),
  };
  await bucket.put(manifestKey(backupId), JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  return readyResponse(request, secret, manifest);
}

async function getBackupManifest(request, env, secret, backupId) {
  const manifest = await readManifest(getBucket(env), backupId);
  if (!manifest) {
    throw new BackupError("cuts_backup_not_found", "找不到這份雲端備份。", 404);
  }
  return json({ manifest, backupUrl: backupUrlForRequest(request, secret) });
}

async function getBackupFile(request, env, backupId) {
  const bucket = getBucket(env);
  const manifest = await readManifest(bucket, backupId);
  if (!manifest) {
    throw new BackupError("cuts_backup_not_found", "找不到這份雲端備份。", 404);
  }
  const fileId = new URL(request.url).searchParams.get("id") || "";
  const record = Array.isArray(manifest.files)
    ? manifest.files.find(file => file.id === fileId)
    : null;
  if (!record) {
    throw new BackupError("cuts_backup_file_not_found", "找不到這個備份檔案。", 404);
  }
  const object = await bucket.get(objectKeyForFile(backupId, record));
  if (!object) {
    throw new BackupError("cuts_backup_file_not_found", "找不到這個備份檔案。", 404);
  }
  const headers = new Headers({
    "content-type": record.contentType,
    "content-length": String(record.size),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-disposition": `inline; filename="${record.filename.replace(/["\\]/g, "_")}"`,
  });
  if (object.httpEtag) headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
}

async function getBackupQr(request, env, secret, backupId) {
  const manifest = await readManifest(getBucket(env), backupId);
  if (!manifest) {
    throw new BackupError("cuts_backup_not_found", "找不到這份雲端備份。", 404);
  }
  const backupUrl = backupUrlForRequest(request, secret);
  return new Response(renderSVG(backupUrl, { ecc: "M", border: 4, pixelSize: 8 }), {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function handleCutsBackupRequest(request, env) {
  const { pathname } = new URL(request.url);
  const isBackupPath = pathname === "/api/cuts-backups" ||
    pathname === "/api/cuts-backups/token" ||
    pathname === "/api/cuts-backups/file" ||
    pathname === "/api/cuts-backups/qr";
  if (!isBackupPath) return null;

  try {
    if (pathname === "/api/cuts-backups/token" && request.method === "POST") {
      return await issueToken(request);
    }
    if (pathname === "/api/cuts-backups" && request.method === "POST") {
      return await createBackup(request, env);
    }
    if (request.method === "GET") {
      const secret = parseBackupSecret(request);
      const backupId = await backupIdForSecret(secret);
      if (pathname === "/api/cuts-backups") {
        return await getBackupManifest(request, env, secret, backupId);
      }
      if (pathname === "/api/cuts-backups/file") {
        return await getBackupFile(request, env, backupId);
      }
      if (pathname === "/api/cuts-backups/qr") {
        return await getBackupQr(request, env, secret, backupId);
      }
    }
    return json({ error: { code: "method_not_allowed", message: "不支援這個請求方式。" } }, 405, {
      allow: pathname === "/api/cuts-backups/token" ? "POST" : "GET, POST",
    });
  } catch (error) {
    return errorResponse(error);
  }
}
