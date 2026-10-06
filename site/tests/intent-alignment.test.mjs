import test from "node:test";
import assert from "node:assert/strict";
import {
  buildIntentReceipt,
  formatIntentDimensionEvidence,
  normalizeIntentJudgment,
} from "../public/intent-alignment.js";

test("observable intent receipt separates dimensions and reports coverage", () => {
  const receipt = buildIntentReceipt({
    prompt: "冷色調，人物放在右側",
    pose: { score: 0.9, confidence: 0.9 },
    placement: { score: 0.84, confidence: 0.85 },
    composition: { score: 0.65, confidence: 0.75 },
    look: { score: 0.42, confidence: 0.8 },
  });

  assert.equal(receipt.valid, true);
  assert.equal(receipt.band, "partial");
  assert.equal(receipt.band_label, "部分偏離");
  assert.equal(receipt.original_intent, "冷色調，人物放在右側");
  assert.deepEqual(receipt.coverage, { measured: 4, total: 4 });
  assert.deepEqual(receipt.dimensions.map(item => item.label), ["姿勢", "人物位置", "構圖", "色調"]);
  assert.equal(receipt.requires_user_judgment, true);
});

test("dimension evidence displays confidence only for measured dimensions", () => {
  const receipt = buildIntentReceipt({
    pose: { score: 0.9, confidence: 0.876 },
    placement: { score: 0.8, confidence: 0.2 },
  });

  assert.equal(formatIntentDimensionEvidence(receipt.dimensions[0]), "接近原始意圖 · 信心 88%");
  assert.equal(formatIntentDimensionEvidence(receipt.dimensions[1]), "未量測");
});

test("receipt refuses an overall drift claim when fewer than two dimensions are measured", () => {
  const receipt = buildIntentReceipt({
    pose: { score: 0.9, confidence: 0.9 },
    placement: { score: 0.9, confidence: 0.2 },
  });

  assert.equal(receipt.valid, false);
  assert.equal(receipt.band, "unavailable");
  assert.equal(receipt.observable_score, null);
  assert.deepEqual(receipt.coverage, { measured: 1, total: 4 });
});

test("null scores stay unavailable instead of becoming a zero match", () => {
  const receipt = buildIntentReceipt({
    pose: { score: null, confidence: 0.9 },
    placement: { score: 0.8, confidence: 0.9 },
  });

  assert.equal(receipt.dimensions[0].available, false);
  assert.equal(receipt.dimensions[0].score, null);
  assert.deepEqual(receipt.coverage, { measured: 1, total: 4 });
});

test("intent judgment accepts only the three explicit user answers", () => {
  assert.equal(normalizeIntentJudgment("aligned"), "aligned");
  assert.equal(normalizeIntentJudgment("partial"), "partial");
  assert.equal(normalizeIntentJudgment("not_aligned"), "not_aligned");
  assert.equal(normalizeIntentJudgment("maybe"), null);
});
