import test from "node:test";
import assert from "node:assert/strict";

import {
  buildIntentProfilePrompt,
  buildIntentProfileSummary,
  inferIntentProfile,
  intentProfileMatchesPrompt,
  normalizeIntentProfile,
} from "../public/intent-profile.js";

test("blank input produces a complete editable default profile", () => {
  const profile = inferIntentProfile();

  assert.equal(profile.version, "intent-profile-v1");
  assert.equal(profile.original_prompt, "");
  assert.match(profile.fields.pose, /明顯/);
  assert.equal(profile.fields.composition, "三分法");
  assert.match(profile.fields.camera_angle, /機位高度與拍攝角度/);
  assert.equal(profile.fields.background, "保留目前真實場景");
  assert.deepEqual(profile.important_dimensions, ["pose", "composition", "camera_angle"]);
});

test("style-only input keeps capture direction ahead of post-production mood", () => {
  const profile = inferIntentProfile("安靜的電影感");

  assert.equal(profile.fields.mood, "電影感、安靜");
  assert.deepEqual(profile.important_dimensions, ["pose", "composition", "camera_angle"]);
});

test("common Chinese cues become separate observable intent fields", () => {
  const profile = inferIntentProfile("  兩位朋友肩膀靠近，中央對稱、正面平視的全身低飽和粉彩照  ");

  assert.equal(profile.original_prompt, "兩位朋友肩膀靠近，中央對稱、正面平視的全身低飽和粉彩照");
  assert.equal(profile.fields.relationship, "朋友感");
  assert.equal(profile.fields.pose, "肩膀靠近");
  assert.equal(profile.fields.composition, "中央對稱");
  assert.equal(profile.fields.camera_angle, "正面平視");
  assert.equal(profile.fields.subject_scale, "全身");
  assert.equal(profile.fields.color, "低飽和、粉彩色");
  assert.deepEqual(profile.important_dimensions, ["relationship", "pose", "composition"]);
});

test("an explicit no-pose-change request becomes a confirmable exception", () => {
  const profile = inferIntentProfile("保持原本姿勢，只調整構圖");

  assert.equal(profile.fields.pose, "保持目前姿勢，不改變動作");
  assert.equal(profile.important_dimensions[0], "pose");
});

test("normalization drops unknown and duplicate priorities and caps them at three", () => {
  const profile = normalizeIntentProfile({
    original_prompt: "  cinematic   portrait ",
    fields: { mood: "  quiet   and warm ", unknown: "ignored" },
    important_dimensions: ["mood", "unknown", "mood", "color", "pose", "composition"],
  });

  assert.equal(profile.original_prompt, "cinematic portrait");
  assert.equal(profile.fields.mood, "quiet and warm");
  assert.equal("unknown" in profile.fields, false);
  assert.deepEqual(profile.important_dimensions, ["mood", "color", "pose"]);
});

test("an abstract style name expands into confirmable visual attributes", () => {
  const profile = inferIntentProfile("Wes Anderson 風格，但保留現場背景");

  assert.equal(profile.fields.pose, "刻意擺拍");
  assert.equal(profile.fields.composition, "中央對稱");
  assert.equal(profile.fields.camera_angle, "正面平視");
  assert.equal(profile.fields.background, "幾何背景、保留目前真實場景");
  assert.equal(profile.fields.color, "有限粉彩色盤");
  assert.equal(profile.fields.mood, "復古、安靜、幽默");
});

test("generation instructions preserve raw intent and distinguish priorities", () => {
  const profile = normalizeIntentProfile({
    original_prompt: "安靜的電影感",
    fields: { composition: "中央對稱", mood: "安靜、電影感" },
    important_dimensions: ["composition", "mood"],
  });
  const prompt = buildIntentProfilePrompt(profile);

  assert.match(prompt, /Original prompt: 安靜的電影感/);
  assert.match(prompt, /構圖: 中央對稱/);
  assert.match(prompt, /Important dimensions: 構圖, 氛圍/);
  assert.match(prompt, /empty or unspecified dimensions as flexible/);
  assert.doesNotMatch(prompt, /undefined/);
  assert.equal(buildIntentProfileSummary(profile), "構圖：中央對稱；氛圍：安靜、電影感");
});

test("prompt matching uses the same whitespace normalization as confirmation", () => {
  const profile = inferIntentProfile("電影感  低飽和");

  assert.equal(intentProfileMatchesPrompt(profile, " 電影感 低飽和 "), true);
  assert.equal(intentProfileMatchesPrompt(profile, "電影感 高飽和"), false);
});
