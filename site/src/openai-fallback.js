// OpenAI 備援翻譯層 — Vertex/Gemini 不穩時的 fallback。
// 職責:把前端送來的 Gemini generateContent 請求翻譯成 OpenAI 呼叫,
// 再把 OpenAI 回應翻譯回 Gemini 的 candidates 格式,讓前端零改動。
// 純函式放這裡以便測試;實際 fetch 在 index.js。

// gpt-image-1.5:比 gpt-image-1 快約 4 倍、便宜 20%(2026-04 發布)
export const OPENAI_IMAGE_MODEL_DEFAULT = "gpt-image-1.5";
export const OPENAI_TEXT_MODEL_DEFAULT = "gpt-5-mini";

// 解析 Gemini 請求:抽出文字 prompt、輸入影像、是否要求生圖
export function parseGeminiRequest(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const parts = parsed?.contents?.[0]?.parts;
  if (!Array.isArray(parts)) return null;

  const prompt = parts
    .filter(part => typeof part.text === "string")
    .map(part => part.text)
    .join("\n\n")
    .trim();
  const imagePart = parts.find(part => part.inlineData?.data);
  const modalities = parsed?.generationConfig?.responseModalities || [];

  return {
    prompt,
    image: imagePart
      ? {
          mimeType: imagePart.inlineData.mimeType || "image/jpeg",
          data: imagePart.inlineData.data,
        }
      : null,
    wantsImage: modalities.includes("IMAGE"),
  };
}

export function toGeminiImageResponse(base64Data, mimeType = "image/png") {
  return {
    candidates: [{
      content: { role: "model", parts: [{ inlineData: { mimeType, data: base64Data } }] },
      finishReason: "STOP",
    }],
  };
}

export function toGeminiTextResponse(text) {
  return {
    candidates: [{
      content: { role: "model", parts: [{ text }] },
      finishReason: "STOP",
    }],
  };
}

export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
