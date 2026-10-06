// openhci.cechung.com — 靜態頁 + API proxy
// /api/ghost   → Cloud Run Vertex AI proxy, with direct Vertex/API-key fallbacks
// /api/suggest → Anthropic Messages(key: ANTHROPIC_API_KEY secret,可之後再設)
// 其他路徑     → public/ 靜態資產

import { DurableObject } from "cloudflare:workers";
import { handleCutsBackupRequest } from "./cuts-backup.js";
import { GHOST_DAILY_LIMIT, reserveGhostGeneration } from "./quota.js";
import {
  OPENAI_IMAGE_MODEL_DEFAULT,
  OPENAI_TEXT_MODEL_DEFAULT,
  base64ToBytes,
  parseGeminiRequest,
  toGeminiImageResponse,
  toGeminiTextResponse,
} from "./openai-fallback.js";

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

let cachedGoogleToken = null;

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

function base64UrlEncode(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pemToArrayBuffer(pem) {
  const body = pem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function signServiceAccountJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY_ID,
  };
  const payload = {
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: GOOGLE_CLOUD_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const unsignedJwt = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(unsignedJwt)
  );
  return `${unsignedJwt}.${base64UrlEncode(signature)}`;
}

async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedGoogleToken && cachedGoogleToken.expiresAt > now + 60) {
    return cachedGoogleToken.value;
  }

  const assertion = await signServiceAccountJwt(env);
  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const token = await tokenResponse.json();
  if (!tokenResponse.ok) {
    throw new Error(token.error_description || token.error || "Google OAuth token exchange failed");
  }

  cachedGoogleToken = {
    value: token.access_token,
    expiresAt: now + Math.max(60, token.expires_in || 3600),
  };
  return cachedGoogleToken.value;
}

function hasVertexConfig(env) {
  return Boolean(
    env.VERTEX_PROJECT_ID &&
      env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
      env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY &&
      env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY_ID
  );
}

async function callVertexProxy(bodyText, env, model) {
  return fetch(env.VERTEX_PROXY_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openhci-proxy-secret": env.VERTEX_PROXY_SHARED_SECRET,
      "x-openhci-model": model,
    },
    body: bodyText,
  });
}

function vertexServiceEndpoint(location) {
  return location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
}

const GHOST_MODEL_ALLOWLIST = new Set([
  "gemini-3.1-flash-image",
  "gemini-3.1-flash-lite-image",
  "gemini-2.5-flash-image",
]);

function resolveGhostModel(request, env) {
  const requested = request.headers.get("x-openhci-model");
  if (GHOST_MODEL_ALLOWLIST.has(requested)) return requested;
  return env.VERTEX_GEMINI_IMAGE_MODEL || env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";
}

async function callVertexGemini(bodyText, env, model) {
  const location = env.VERTEX_LOCATION || "global";
  const modelPath = `projects/${env.VERTEX_PROJECT_ID}/locations/${location}/publishers/google/models/${model}`;
  const accessToken = await getGoogleAccessToken(env);

  return fetch(`https://${vertexServiceEndpoint(location)}/v1/${modelPath}:generateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: bodyText,
  });
}

function callGeminiApiKey(bodyText, env, model) {
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: bodyText,
  });
}

// OpenAI 備援:Vertex 端 429/5xx/斷線時,翻譯請求打 OpenAI,回應翻譯回 Gemini 格式
async function callOpenAiFallback(bodyText, env) {
  const parsed = parseGeminiRequest(bodyText);
  if (!parsed) return json({ error: { message: "OpenAI fallback: unrecognized request shape" } }, 400);

  try {
    if (parsed.wantsImage && parsed.image) {
      const form = new FormData();
      form.append("model", env.OPENAI_IMAGE_MODEL || OPENAI_IMAGE_MODEL_DEFAULT);
      // 備援求快不求極致:medium 大幅縮短延遲,環境變數可覆寫
      form.append("quality", env.OPENAI_IMAGE_QUALITY || "medium");
      form.append("prompt", parsed.prompt.slice(0, 30_000));
      form.append(
        "image",
        new Blob([base64ToBytes(parsed.image.data)], { type: parsed.image.mimeType }),
        "frame.jpg",
      );
      const res = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: form,
      });
      const data = await res.json();
      if (!res.ok) return json({ error: { message: `OpenAI fallback: ${data.error?.message || `HTTP ${res.status}`}` } }, res.status);
      const b64 = data.data?.[0]?.b64_json;
      if (!b64) return json({ error: { message: "OpenAI fallback: no image in response" } }, 502);
      return json(toGeminiImageResponse(b64), 200, {
        "x-openhci-model": env.OPENAI_IMAGE_MODEL || OPENAI_IMAGE_MODEL_DEFAULT,
      });
    }

    const content = [{ type: "text", text: parsed.prompt }];
    if (parsed.image) {
      content.push({ type: "image_url", image_url: { url: `data:${parsed.image.mimeType};base64,${parsed.image.data}` } });
    }
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.OPENAI_TEXT_MODEL || OPENAI_TEXT_MODEL_DEFAULT,
        messages: [{ role: "user", content }],
        // gpt-5 系列是推理模型:不壓推理力道的話,內部推理會吃光 token 上限,
        // 正文變空字串。情境句不需要推理,minimal 也最快最省。
        reasoning_effort: "minimal",
        max_completion_tokens: 2000,
      }),
    });
    const data = await res.json();
    if (!res.ok) return json({ error: { message: `OpenAI fallback: ${data.error?.message || `HTTP ${res.status}`}` } }, res.status);
    return json(toGeminiTextResponse(data.choices?.[0]?.message?.content || ""), 200, {
      "x-openhci-model": env.OPENAI_TEXT_MODEL || OPENAI_TEXT_MODEL_DEFAULT,
    });
  } catch (error) {
    return json({ error: { message: `OpenAI fallback failed: ${error instanceof Error ? error.message : String(error)}` } }, 502);
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    const cutsBackupResponse = await handleCutsBackupRequest(request, env);
    if (cutsBackupResponse) return cutsBackupResponse;

    if (pathname === "/api/ghost" && request.method === "POST") {
      if (!(env.VERTEX_PROXY_URL && env.VERTEX_PROXY_SHARED_SECRET) && !hasVertexConfig(env) && !env.GEMINI_API_KEY) {
        return json({ error: { message: "Vertex AI 或 GEMINI_API_KEY 未設定" } }, 500);
      }

      let quota;
      try {
        quota = await reserveGhostGeneration(env);
      } catch (error) {
        console.error(JSON.stringify({
          event: "ghost_quota_error",
          message: error instanceof Error ? error.message : String(error),
        }));
        return json({ error: { message: "Generation quota is temporarily unavailable" } }, 503);
      }

      const quotaHeaders = {
        "x-ratelimit-limit": String(GHOST_DAILY_LIMIT),
        "x-ratelimit-remaining": String(quota.remaining),
        "x-ratelimit-reset": String(Math.ceil(quota.resetAt / 1_000)),
      };

      if (!quota.allowed) {
        return json(
          { error: { message: "Daily image generation limit reached" } },
          429,
          {
            ...quotaHeaders,
            "retry-after": String(Math.max(1, Math.ceil((quota.resetAt - Date.now()) / 1_000))),
          },
        );
      }

      const model = resolveGhostModel(request, env);
      // 先緩衝請求內容:主線失敗時 fallback 需要重讀同一份 body
      const bodyText = await request.text();
      // 僅 staging 允許用 header 強制走備援,方便驗證翻譯層
      const forceFallback = env.ENVIRONMENT === "staging" &&
        request.headers.get("x-openhci-force-fallback") === "1";

      // 三層備援鏈:選定模型 → gemini-3.1-flash-lite-image(同 Vertex,不同容量池)
      // → OpenAI。429/5xx/斷線視為失敗,4xx 用戶端錯誤直接回傳不換線。
      const LITE_MODEL = "gemini-3.1-flash-lite-image";
      const failed = response => !response || response.status === 429 || response.status >= 500;
      const callVertexChain = tierModel =>
        env.VERTEX_PROXY_URL && env.VERTEX_PROXY_SHARED_SECRET
          ? callVertexProxy(bodyText, env, tierModel)
          : hasVertexConfig(env)
            ? callVertexGemini(bodyText, env, tierModel)
            : callGeminiApiKey(bodyText, env, tierModel);

      let upstream = null;
      let upstreamFailure = null;
      let servedModel = model;
      let servedBy = "vertex";

      if (!forceFallback) {
        try {
          upstream = await callVertexChain(model);
        } catch (error) {
          upstreamFailure = error instanceof Error ? error.message : String(error);
        }

        if (failed(upstream) && model !== LITE_MODEL) {
          console.log(JSON.stringify({
            event: "ghost_lite_fallback",
            reason: upstreamFailure || `vertex_http_${upstream?.status}`,
          }));
          try {
            const lite = await callVertexChain(LITE_MODEL);
            if (!failed(lite)) {
              upstream = lite;
              upstreamFailure = null;
              servedModel = LITE_MODEL;
              servedBy = "vertex-lite-fallback";
            }
          } catch {
            // Lite 也斷線:維持原失敗狀態,交給下一層
          }
        }
      }

      if (env.OPENAI_API_KEY && (forceFallback || failed(upstream))) {
        console.log(JSON.stringify({
          event: "ghost_openai_fallback",
          reason: forceFallback ? "forced" : upstreamFailure || `vertex_http_${upstream?.status}`,
        }));
        const fallback = await callOpenAiFallback(bodyText, env);
        return new Response(fallback.body, {
          status: fallback.status,
          headers: {
            "content-type": "application/json",
            "x-openhci-model": fallback.headers.get("x-openhci-model") || model,
            "x-openhci-upstream": "openai-fallback",
            ...quotaHeaders,
          },
        });
      }

      if (!upstream) {
        return json({ error: { message: `Upstream failed: ${upstreamFailure}` } }, 502, quotaHeaders);
      }
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "content-type": "application/json",
          "x-openhci-model": servedModel,
          "x-openhci-upstream": servedBy,
          ...quotaHeaders,
        },
      });
    }

    if (pathname === "/api/suggest" && request.method === "POST") {
      if (!env.ANTHROPIC_API_KEY) return json({ error: { message: "ANTHROPIC_API_KEY 未設定" } }, 500);
      const upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: request.body,
        duplex: "half",
      });
      return new Response(upstream.body, { status: upstream.status, headers: { "content-type": "application/json" } });
    }

    return env.ASSETS.fetch(request);
  },
};

export class DailyGenerationLimit extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS quota (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          used INTEGER NOT NULL DEFAULT 0
        )
      `);
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO quota (id, used) VALUES (1, 0)",
      );
    });
  }

  consume(limit) {
    const rows = this.ctx.storage.sql.exec(
      "UPDATE quota SET used = used + 1 WHERE id = 1 AND used < ? RETURNING used",
      limit,
    ).toArray();

    if (rows.length === 0) {
      const current = this.ctx.storage.sql.exec(
        "SELECT used FROM quota WHERE id = 1",
      ).one();
      return { allowed: false, used: current.used, remaining: 0 };
    }

    const used = rows[0].used;
    return { allowed: true, used, remaining: limit - used };
  }
}
