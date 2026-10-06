import test from "node:test";
import assert from "node:assert/strict";

import {
  CAPTURE_SESSION_VERSION,
  captureSessionMetadata,
  dataUrlToBlob,
  loadCaptureSession,
  normalizeCaptureSession,
} from "../public/capture-session.js";

function sourceSession(overrides = {}) {
  return {
    created_at: "2026-07-15T12:00:00.000Z",
    original_blob: new Blob(["original pixels"], { type: "image/jpeg" }),
    ghost_blob: new Blob(["ghost pixels"], { type: "image/png" }),
    ghost_mirrored: true,
    intent_profile: {
      original_prompt: "冷色全身照",
      fields: { subject_scale: "全身", color: "冷色調" },
      important_dimensions: ["subject_scale", "color"],
    },
    original_intent: " 冷色全身照 ",
    target_look: {
      valid: true,
      metric_version: "ghost-look-v1-heuristic",
      mean_luma: 0.5,
      contrast: 0.2,
      saturation: 0.4,
      temperature: -0.1,
      sample_count: 512,
      confidence: 0.9,
    },
    receipt: { band: "partial", image: new Blob(["must be removed"]) },
    shot_summary: { camera: "user" },
    ...overrides,
  };
}

test("capture session keeps image Blobs in IndexedDB records and normalizes metadata", () => {
  const session = normalizeCaptureSession(sourceSession());

  assert.equal(session.version, CAPTURE_SESSION_VERSION);
  assert.equal(session.id, "latest");
  assert.equal(session.original_blob.type, "image/jpeg");
  assert.equal(session.ghost_blob.type, "image/png");
  assert.equal(session.ghost_mirrored, true);
  assert.equal(session.intent_profile.fields.color, "冷色調");
  assert.equal(session.original_intent, "冷色全身照");
  assert.equal(session.receipt.image, null);
});

test("capture session requires original pixels and ignores invalid optional evidence", () => {
  assert.throws(
    () => normalizeCaptureSession({ original_blob: null }),
    /original image Blob/,
  );

  const session = normalizeCaptureSession(sourceSession({
    ghost_blob: new Blob([]),
    target_look: { valid: true, mean_luma: null },
  }));
  assert.equal(session.ghost_blob, null);
  assert.equal(session.ghost_mirrored, false);
  assert.equal(session.target_look, null);
});

test("research-log metadata never contains image Blob fields", () => {
  const metadata = captureSessionMetadata(sourceSession());

  assert.deepEqual(metadata.original, { type: "image/jpeg", size: 15 });
  assert.deepEqual(metadata.ghost, { type: "image/png", size: 12, mirrored: true });
  assert.equal("original_blob" in metadata, false);
  assert.equal("ghost_blob" in metadata, false);
});

test("data URLs become typed Blobs without network access", async () => {
  const blob = dataUrlToBlob("data:image/jpeg;base64,aGVsbG8=");

  assert.equal(blob.type, "image/jpeg");
  assert.equal(await blob.text(), "hello");
  assert.throws(() => dataUrlToBlob("not a data URL"), /valid data URL/);
});

test("loading reports IndexedDB absence instead of falling back to localStorage", async () => {
  await assert.rejects(
    loadCaptureSession({ indexedDB: null }),
    /indexeddb_unavailable/,
  );
});
