import test from "node:test";
import assert from "node:assert/strict";

import {
  base64ToBytes,
  parseGeminiRequest,
  toGeminiImageResponse,
  toGeminiTextResponse,
} from "../src/openai-fallback.js";

const imageRequest = JSON.stringify({
  contents: [{
    role: "user",
    parts: [
      { inlineData: { mimeType: "image/jpeg", data: "QUJD" } },
      { text: "Redraw this exact scene." },
    ],
  }],
  generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
});

test("parses a Gemini image-generation request", () => {
  const parsed = parseGeminiRequest(imageRequest);
  assert.equal(parsed.wantsImage, true);
  assert.equal(parsed.prompt, "Redraw this exact scene.");
  assert.deepEqual(parsed.image, { mimeType: "image/jpeg", data: "QUJD" });
});

test("parses a text-only request and joins multiple text parts", () => {
  const parsed = parseGeminiRequest(JSON.stringify({
    contents: [{ parts: [{ text: "第一段" }, { text: "第二段" }] }],
    generationConfig: { responseModalities: ["TEXT"] },
  }));
  assert.equal(parsed.wantsImage, false);
  assert.equal(parsed.image, null);
  assert.equal(parsed.prompt, "第一段\n\n第二段");
});

test("rejects malformed bodies instead of throwing", () => {
  assert.equal(parseGeminiRequest("not json"), null);
  assert.equal(parseGeminiRequest(JSON.stringify({ contents: [{}] })), null);
});

test("image response converts back into Gemini candidates shape", () => {
  const converted = toGeminiImageResponse("ZZZZ", "image/png");
  const part = converted.candidates[0].content.parts[0];
  assert.deepEqual(part.inlineData, { mimeType: "image/png", data: "ZZZZ" });
  assert.equal(converted.candidates[0].finishReason, "STOP");
});

test("text response converts back into Gemini candidates shape", () => {
  const converted = toGeminiTextResponse("如果你想要 chill——想像晚風那一刻");
  assert.equal(converted.candidates[0].content.parts[0].text, "如果你想要 chill——想像晚風那一刻");
});

test("base64ToBytes round-trips binary data", () => {
  const bytes = base64ToBytes("QUJD");
  assert.deepEqual([...bytes], [65, 66, 67]);
});
