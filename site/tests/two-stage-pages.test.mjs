import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const publicUrl = new URL("../public/", import.meta.url);

async function source(name) {
  return readFile(new URL(name, publicUrl), "utf8");
}

test("capture page contains capture guidance but no post-production controls", async () => {
  const [html, app] = await Promise.all([source("ghost.html"), source("ghost-app.js")]);

  assert.match(html, />拍攝</);
  assert.match(html, />1 \/ 2</);
  assert.match(html, /id="editPhoto"/);
  assert.doesNotMatch(html, /id="lookBar"|id="filterSelect"|id="effectSelect"|data-look-control/);
  assert.match(app, /NEUTRAL_CAPTURE_LOOK/);
  assert.match(app, /saveCaptureSession/);
  assert.match(app, /capture_render: "original_unfiltered"/);
  assert.match(app, /const originalPrompt = shotIntentProfile\?\.original_prompt \|\| DEFAULT_INTENT_LABEL/);
  assert.match(app, /prompt: originalPrompt/);
  assert.match(app, /formatIntentDimensionEvidence\(dimension\)/);
  assert.doesNotMatch(app, /localStorage\.setItem\("camera_look"/);
});

test("post-production page owns every look control and a separate module entry", async () => {
  const [html, app] = await Promise.all([
    source("ghost-edit.html"),
    source("ghost-edit-app.js"),
  ]);

  assert.match(html, />後製</);
  assert.match(html, />2 \/ 2</);
  assert.match(html, /id="filterSelect"/);
  assert.match(html, /id="effectSelect"/);
  assert.equal((html.match(/data-look-control=/g) || []).length, 4);
  assert.match(html, /src="\/ghost-edit-app\.js"/);
  assert.match(app, /loadCaptureSession/);
  assert.match(app, /renderCameraFrame/);
  assert.match(app, /estimateLookRecipe/);
  assert.match(app, /resetLookAdjustments\(currentLook\)/);
  assert.match(app, /targetLook = ghostImage \? analyzeImage\(ghostImage\) : null/);
  assert.match(app, /session\.ghost_mirrored/);
  assert.doesNotMatch(app, /\/api\/ghost|generateContent/);
});

test("editor exposes edited, original, and optional AI-reference views", async () => {
  const html = await source("ghost-edit.html");

  assert.match(html, /data-view-mode="edited"/);
  assert.match(html, /data-view-mode="original"/);
  assert.match(html, /data-view-mode="ghost"/);
  assert.match(html, /id="resetLook"/);
  assert.match(html, /id="savePhoto"/);
});
