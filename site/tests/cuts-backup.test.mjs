import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  backupIdForSecret,
  handleCutsBackupRequest,
} from "../src/cuts-backup.js";

const ORIGIN = "https://staging.openhci.cechung.com";
const siteUrl = new URL("../", import.meta.url);

class FakeR2Bucket {
  constructor() {
    this.objects = new Map();
    this.puts = [];
    this.failOnceFor = null;
  }

  async put(key, value, options = {}) {
    if (this.failOnceFor && key.includes(this.failOnceFor)) {
      this.failOnceFor = null;
      throw new Error("injected R2 failure");
    }
    let bytes;
    if (typeof value === "string") bytes = new TextEncoder().encode(value);
    else if (typeof value.arrayBuffer === "function") bytes = new Uint8Array(await value.arrayBuffer());
    else bytes = new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, { bytes, options });
    this.puts.push(key);
    return { key, size: bytes.byteLength, httpEtag: '"fake-etag"' };
  }

  async get(key) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      body: stored.bytes,
      size: stored.bytes.byteLength,
      httpEtag: '"fake-etag"',
      async text() {
        return new TextDecoder().decode(stored.bytes);
      },
    };
  }
}

function blob(type) {
  const headers = {
    "image/jpeg": [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3],
    "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2],
    "image/webp": [0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1],
    "image/gif": [...new TextEncoder().encode("GIF89a"), 1, 2, 3],
  };
  return new Blob([new Uint8Array(headers[type])], { type });
}

function proposal(index) {
  return {
    promptInputRaw: index === 1 ? "  神秘 👻\n但自在  " : "chill \"第二張\"",
    stylePreference: index === 1 ? "神秘 👻 但自在" : "chill \"第二張\"",
    imagePrompt: `full image prompt ${index}\n<not-html>`,
    reason: `如果你想要第 ${index} 種感覺——想像一個時刻`,
    strategy: "image-then-text",
    model: "gemini-3.1-flash-image",
    modelLabel: "Gemini 3.1 Flash Image",
    requestedModel: "gemini-3.1-flash-image",
    upstream: "vertex",
  };
}

function metadata({ cutsTotal = 2, generated = [true, true] } = {}) {
  return {
    schemaVersion: 1,
    cutsTotal,
    frameId: "openhci",
    shots: Array.from({ length: cutsTotal }, (_, offset) => {
      const index = offset + 1;
      return {
        index,
        generated: Boolean(generated[offset]),
        promptInputRaw: generated[offset] ? proposal(index).promptInputRaw : "略過生成但保留的 prompt",
        cameraFacing: index === 1 ? "user" : "environment",
        capturedMirrored: index === 1,
        ghostMirrored: generated[offset] && index === 1,
        proposal: generated[offset] ? proposal(index) : null,
      };
    }),
  };
}

function uploadForm(options = {}) {
  const value = metadata(options);
  const form = new FormData();
  form.set("metadata", JSON.stringify(value));
  for (const shot of value.shots) {
    form.set(`photo-${shot.index}`, blob("image/jpeg"), `photo-${shot.index}.jpg`);
    if (shot.generated) form.set(`ghost-${shot.index}`, blob("image/png"), `ghost-${shot.index}.png`);
  }
  form.set("final", blob("image/png"), "final.png");
  form.set("liveGif", blob("image/gif"), "live.gif");
  return form;
}

async function issueSecret() {
  const response = await handleCutsBackupRequest(new Request(`${ORIGIN}/api/cuts-backups/token`, {
    method: "POST",
    headers: { origin: ORIGIN },
  }), {});
  assert.equal(response.status, 201);
  return response.json();
}

function uploadRequest(secret, form = uploadForm()) {
  return new Request(`${ORIGIN}/api/cuts-backups`, {
    method: "POST",
    headers: { origin: ORIGIN, authorization: `Bearer ${secret}` },
    body: form,
  });
}

test("issues a high-entropy fragment capability and rejects cross-origin token requests", async () => {
  const { secret, backupUrl } = await issueSecret();
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(backupUrl, `${ORIGIN}/cuts-backup#${secret}`);

  const denied = await handleCutsBackupRequest(new Request(`${ORIGIN}/api/cuts-backups/token`, {
    method: "POST",
    headers: { origin: "https://attacker.example" },
  }), {});
  assert.equal(denied.status, 403);
});

test("stores two captured photos, AI proposals, exact prompts, final PNG, and Live Photo GIF", async () => {
  const bucket = new FakeR2Bucket();
  const { secret, backupUrl } = await issueSecret();
  const response = await handleCutsBackupRequest(uploadRequest(secret), { CUTS_BACKUPS: bucket });
  assert.equal(response.status, 200);
  const result = await response.json();

  assert.equal(result.backupUrl, backupUrl);
  assert.match(result.qrSvg, /^<svg/);
  assert.equal(result.manifest.files.length, 6);
  assert.equal(result.manifest.shots[0].promptInputRaw, "  神秘 👻\n但自在  ");
  assert.equal(result.manifest.shots[1].proposal.imagePrompt, "full image prompt 2\n<not-html>");
  assert.equal(result.manifest.shots[0].ghostMirrored, true);
  assert.equal(result.manifest.shots[1].ghostMirrored, false);
  assert.match(bucket.puts.at(-1), /manifest\.json$/);
  assert.ok(bucket.puts.every(key => !key.includes(secret)), "raw capability must not appear in R2 keys");

  const backupId = await backupIdForSecret(secret);
  assert.ok(bucket.puts.every(key => key.includes(backupId)));

  const read = await handleCutsBackupRequest(new Request(`${ORIGIN}/api/cuts-backups`, {
    headers: { authorization: `Bearer ${secret}` },
  }), { CUTS_BACKUPS: bucket });
  assert.equal(read.status, 200);
  const readBody = await read.json();
  assert.equal(readBody.manifest.shots[0].proposal.reason, proposal(1).reason);

  const file = await handleCutsBackupRequest(new Request(`${ORIGIN}/api/cuts-backups/file?id=photo-1`, {
    headers: { authorization: `Bearer ${secret}` },
  }), { CUTS_BACKUPS: bucket });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("cache-control"), "private, no-store");
  assert.equal(file.headers.get("x-content-type-options"), "nosniff");
  assert.equal(file.headers.get("content-type"), "image/jpeg");
});

test("supports one cut without an AI proposal while retaining the typed prompt", async () => {
  const bucket = new FakeR2Bucket();
  const { secret } = await issueSecret();
  const response = await handleCutsBackupRequest(
    uploadRequest(secret, uploadForm({ cutsTotal: 1, generated: [false] })),
    { CUTS_BACKUPS: bucket },
  );
  assert.equal(response.status, 200);
  const { manifest } = await response.json();
  assert.equal(manifest.files.length, 3);
  assert.equal(manifest.shots[0].generated, false);
  assert.equal(manifest.shots[0].proposal, null);
  assert.equal(manifest.shots[0].promptInputRaw, "略過生成但保留的 prompt");
});

test("wrong capabilities and unknown file ids are indistinguishable 404s", async () => {
  const bucket = new FakeR2Bucket();
  const { secret } = await issueSecret();
  await handleCutsBackupRequest(uploadRequest(secret), { CUTS_BACKUPS: bucket });

  const other = (await issueSecret()).secret;
  const missingBackup = await handleCutsBackupRequest(new Request(`${ORIGIN}/api/cuts-backups`, {
    headers: { authorization: `Bearer ${other}` },
  }), { CUTS_BACKUPS: bucket });
  assert.equal(missingBackup.status, 404);

  const missingQr = await handleCutsBackupRequest(new Request(`${ORIGIN}/api/cuts-backups/qr`, {
    headers: { authorization: `Bearer ${other}` },
  }), { CUTS_BACKUPS: bucket });
  assert.equal(missingQr.status, 404);

  const missingFile = await handleCutsBackupRequest(new Request(`${ORIGIN}/api/cuts-backups/file?id=../../manifest`, {
    headers: { authorization: `Bearer ${secret}` },
  }), { CUTS_BACKUPS: bucket });
  assert.equal(missingFile.status, 404);
});

test("rejects mismatched MIME content, extra fields, and DELETE", async () => {
  const bucket = new FakeR2Bucket();
  const { secret } = await issueSecret();
  const badMagic = uploadForm();
  badMagic.set("photo-1", new Blob(["<html>"], { type: "image/jpeg" }), "photo.jpg");
  const badMagicResponse = await handleCutsBackupRequest(uploadRequest(secret, badMagic), { CUTS_BACKUPS: bucket });
  assert.equal(badMagicResponse.status, 400);
  assert.equal(bucket.puts.length, 0);

  const extra = uploadForm();
  extra.set("unexpected", blob("image/png"), "unexpected.png");
  const extraResponse = await handleCutsBackupRequest(uploadRequest(secret, extra), { CUTS_BACKUPS: bucket });
  assert.equal(extraResponse.status, 400);

  const deletion = await handleCutsBackupRequest(new Request(`${ORIGIN}/api/cuts-backups`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${secret}` },
  }), { CUTS_BACKUPS: bucket });
  assert.equal(deletion.status, 405);
});

test("keeps partial R2 writes unreadable and retries idempotently with the same capability", async () => {
  const bucket = new FakeR2Bucket();
  const { secret } = await issueSecret();
  bucket.failOnceFor = "ghost-2";

  const failed = await handleCutsBackupRequest(uploadRequest(secret), { CUTS_BACKUPS: bucket });
  assert.equal(failed.status, 503);
  assert.ok(!bucket.puts.some(key => key.endsWith("manifest.json")));

  const hidden = await handleCutsBackupRequest(new Request(`${ORIGIN}/api/cuts-backups`, {
    headers: { authorization: `Bearer ${secret}` },
  }), { CUTS_BACKUPS: bucket });
  assert.equal(hidden.status, 404);

  const retried = await handleCutsBackupRequest(uploadRequest(secret), { CUTS_BACKUPS: bucket });
  assert.equal(retried.status, 200);
  const putsAfterRetry = bucket.puts.length;

  const duplicate = await handleCutsBackupRequest(uploadRequest(secret), { CUTS_BACKUPS: bucket });
  assert.equal(duplicate.status, 200);
  assert.equal(bucket.puts.length, putsAfterRetry, "completed retry must not rewrite assets");
});

test("cuts snapshots the generated prompt per shot and uploads the framed Live Photo GIF", async () => {
  const [cuts, engine, backupPage, officialLogo, soulSeePage8] = await Promise.all([
    readFile(new URL("public/cuts.html", siteUrl), "utf8"),
    readFile(new URL("public/photobooth-engine.js", siteUrl), "utf8"),
    readFile(new URL("public/cuts-backup.html", siteUrl), "utf8"),
    readFile(new URL("public/aidentity-logo-dark.png", siteUrl)),
    readFile(new URL("public/soulsee-page8.png", siteUrl)),
  ]);

  assert.match(engine, /promptInputRaw,\s*stylePreference,\s*imagePrompt/);
  assert.match(engine, /cameraFacing: camera\.mode/);
  assert.match(cuts, /proposal: ghostSrc && currentProposal \? \{ \.\.\.currentProposal \} : null/);
  assert.match(cuts, /form\.append\('liveGif', liveGif, 'live\.gif'\)/);
  assert.match(cuts, /shot\.promptInputRaw \|\| ''/);
  assert.match(backupPage, /text\.textContent = value \|\| '（未輸入）'/);
  assert.doesNotMatch(backupPage, /prompt-text[^\n]*innerHTML/);
  assert.match(backupPage, /id="manifestDownload" href="#" hidden/);
  assert.equal((cuts.match(/src="\/aidentity-logo-dark\.png"/g) || []).length, 4);
  assert.match(backupPage, /<h1><img src="\/aidentity-logo-dark\.png" alt="\(AI\)dentity"/);
  assert.deepEqual([...officialLogo.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual([...soulSeePage8.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.doesNotMatch(cuts, /class="app-logo">\(/);
  assert.match(cuts, /<section class="fs" id="gate">[\s\S]*?<div class="logo"><img src="\/soulsee-page8\.png" alt="SoulSee" width="2245" height="3179"><\/div>/);
  assert.doesNotMatch(cuts, /<div class="logo">\(<b>AI<\/b>\)dentity<\/div>/);
});

test("cuts prepares the cloud backup in the background before the QR button is clicked", async () => {
  const cuts = await readFile(new URL("public/cuts.html", siteUrl), "utf8");
  const compose = cuts.slice(
    cuts.indexOf("async function composeStrip()"),
    cuts.indexOf("/* ---- ⑤ 下載選單"),
  );
  const startBackup = cuts.slice(
    cuts.indexOf("async function startCloudBackup()"),
    cuts.indexOf("$('cloudBackup').addEventListener"),
  );
  const clickBackup = cuts.slice(
    cuts.indexOf("$('cloudBackup').addEventListener"),
    cuts.indexOf("$('backupCopy').addEventListener"),
  );
  const completedBackup = cuts.slice(
    cuts.indexOf("function renderCompletedBackup"),
    cuts.indexOf("async function startCloudBackup()"),
  );
  const invalidateBackup = cuts.slice(
    cuts.indexOf("function invalidateCloudBackupForComposition"),
    cuts.indexOf("function closeDownloadMenu"),
  );

  assert.ok(compose.indexOf("stripDataUrl = nextDataUrl") < compose.indexOf("void startCloudBackup()"));
  assert.match(compose, /void startCloudBackup\(\)/);
  assert.match(startBackup, /await Promise\.all\(\[/);
  assert.match(startBackup, /ensureBackupSecret/);
  assert.match(startBackup, /getFramedLiveGif/);
  assert.match(completedBackup, /\$\('backupPanel'\)\.hidden = true/);
  assert.match(completedBackup, /☁ 顯示 QR code 與連結/);
  assert.doesNotMatch(completedBackup, /scrollIntoView/);
  assert.doesNotMatch(clickBackup, /fetch\(/);
  assert.match(clickBackup, /completedBackupRenderToken === stripRenderToken && completedBackupUrl/);
  assert.match(clickBackup, /\$\('backupPanel'\)\.hidden = false/);
  assert.match(clickBackup, /button\.dataset\.retry === 'true'/);
  assert.match(invalidateBackup, /completedBackupUrl = ''/);
  assert.match(invalidateBackup, /clearBackupPresentation\(\)/);
});
