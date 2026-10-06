import test from "node:test";
import assert from "node:assert/strict";

import {
  CAPTURE_INTENT_DIMENSIONS,
  PHOTOGRAPHY_PROMPT_VERSION,
  POST_PRODUCTION_INTENT_DIMENSIONS,
  buildPhotographyGhostPrompt,
} from "../public/ghost-prompt.js";
import { normalizeIntentProfile } from "../public/intent-profile.js";

function customProfile() {
  return normalizeIntentProfile({
    original_prompt: "冷靜、低飽和的正面全身照",
    fields: {
      subject: "同一位人物與服裝",
      pose: "自然站立、看向鏡頭",
      composition: "中央對稱、保留上方留白",
      camera_angle: "正面平視",
      subject_scale: "全身",
      background: "保留目前真實場景",
      color: "冷色調、低飽和",
      mood: "安靜",
    },
    important_dimensions: ["composition", "camera_angle", "color"],
  });
}

test("photography prompt separates capture-time concepts from post-production", () => {
  const prompt = buildPhotographyGhostPrompt(customProfile());

  assert.equal(PHOTOGRAPHY_PROMPT_VERSION, "photography-direction-v2-visible-pose");
  assert.deepEqual(CAPTURE_INTENT_DIMENSIONS, [
    "relationship", "pose", "composition", "camera_angle", "subject_scale", "background",
  ]);
  assert.deepEqual(POST_PRODUCTION_INTENT_DIMENSIONS, ["color", "mood"]);
  assert.match(prompt, /professional photographer and on-set art director/);
  assert.match(prompt, /Capture-time direction \(must be solved before the shutter\)/);
  assert.match(prompt, /Composition and negative space/);
  assert.match(prompt, /Shot size and subject scale/);
  assert.match(prompt, /camera height, camera angle, distance, perspective, and a plausible focal-length look/);
  assert.match(prompt, /confirmed pose, gaze, relationship, and placement/);
  assert.match(prompt, /Visible pose\/action delta \(required\)/);
  assert.match(prompt, /Change at least two observable cues/);
  assert.match(prompt, /arm or hand configuration, torso orientation, weight distribution or leg stance/);
  assert.match(prompt, /not a retouched near-copy/);
  assert.match(prompt, /subject-background separation/);
  assert.match(prompt, /focus, base exposure, and depth of field/);
  assert.match(prompt, /Post-production look \(reversible after capture\)/);
  assert.match(prompt, /white balance and color temperature, palette, contrast, and saturation/);
  assert.match(prompt, /highlights, shadows, and overall brightness/);
  assert.match(prompt, /Filters, effects, and retouching/);
});

test("confirmed intent and priority order remain explicit", () => {
  const prompt = buildPhotographyGhostPrompt(customProfile());

  assert.match(prompt, /Original prompt: 冷靜、低飽和的正面全身照/);
  assert.match(prompt, /構圖: 中央對稱、保留上方留白/);
  assert.match(prompt, /鏡位: 正面平視/);
  assert.match(prompt, /色調: 冷色調、低飽和/);
  assert.match(prompt, /Important dimensions: 構圖, 鏡位, 色調/);
  assert.match(prompt, /Priority order: composition, camera_angle, color/);
});

test("capture geometry cannot be delegated to post-production", () => {
  const prompt = buildPhotographyGhostPrompt(customProfile());

  assert.match(prompt, /Never describe pose, subject placement or scale, camera angle, perspective, framing, focus, or depth of field as something post-production can repair/);
  assert.match(prompt, /original captured pixels available for the separate post-production page/);
  assert.match(prompt, /Ghost image may preview this post-production look/);
  assert.match(prompt, /look must not alter capture-time geometry/);
  assert.match(prompt, /SAME person and identity, facial structure, body shape, clothing, location/);
  assert.match(prompt, /Do not replace the background, invent or remove major objects/);
  assert.match(prompt, /Do not reshape the face or body/);
  assert.match(prompt, /choose another clearly visible pose or camera solution/);
  assert.match(prompt, /do not fall back to a near-copy/);
  assert.match(prompt, /Output the image only/);
});

test("custom choices are not overwritten by hardcoded travel-photo defaults", () => {
  const prompt = buildPhotographyGhostPrompt(customProfile());

  assert.doesNotMatch(prompt, /三分法/);
  assert.doesNotMatch(prompt, /暖色光線/);
  assert.doesNotMatch(prompt, /自然旅拍/);
  assert.match(prompt, /do not silently substitute generic cinematic styling, warm color, shallow depth of field, or rule-of-thirds composition/i);
  assert.doesNotMatch(prompt, /keep them conservative/);
});

test("unspecified pose still receives visible professional direction", () => {
  const profile = normalizeIntentProfile({
    original_prompt: "安靜的電影感",
    fields: { mood: "安靜、電影感", color: "低飽和" },
    important_dimensions: ["pose", "composition", "camera_angle"],
  });
  const prompt = buildPhotographyGhostPrompt(profile);

  assert.match(prompt, /When pose is unspecified, actively choose a professional pose/);
  assert.match(prompt, /clean silhouette, intentional hands, clear body line/);
  assert.match(prompt, /A facial-expression, finger, or shoulder micro-adjustment alone is not enough/);
});

test("an explicit no-pose-change request disables the visible-delta contract", () => {
  const profile = normalizeIntentProfile({
    original_prompt: "保持目前姿勢",
    fields: { pose: "保持目前姿勢，不改變動作", composition: "三分法" },
    important_dimensions: ["pose", "composition", "camera_angle"],
  });
  const prompt = buildPhotographyGhostPrompt(profile);

  assert.match(prompt, /Pose\/action exception: the user explicitly confirmed no pose change/);
  assert.doesNotMatch(prompt, /Visible pose\/action delta \(required\)/);
});

test("abstract style names are subordinate to confirmed observable attributes", () => {
  const profile = normalizeIntentProfile({
    original_prompt: "Wes Anderson 風格",
    fields: {
      composition: "中央對稱",
      camera_angle: "正面平視",
      color: "有限粉彩色盤",
    },
    important_dimensions: ["composition", "camera_angle", "color"],
  });
  const prompt = buildPhotographyGhostPrompt(profile);

  assert.match(prompt, /Original prompt: Wes Anderson 風格/);
  assert.match(prompt, /use only the concrete observable attributes in the confirmed profile/);
  assert.match(prompt, /do not add stereotypes or unconfirmed signature elements/);
});
