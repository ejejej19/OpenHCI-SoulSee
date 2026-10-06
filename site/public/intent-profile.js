export const INTENT_PROFILE_VERSION = "intent-profile-v1";

export const PROFILE_FIELDS = Object.freeze([
  Object.freeze({ id: "subject", label: "主體" }),
  Object.freeze({ id: "relationship", label: "人物關係" }),
  Object.freeze({ id: "pose", label: "姿勢" }),
  Object.freeze({ id: "composition", label: "構圖" }),
  Object.freeze({ id: "camera_angle", label: "鏡位" }),
  Object.freeze({ id: "subject_scale", label: "人物尺度" }),
  Object.freeze({ id: "background", label: "背景" }),
  Object.freeze({ id: "color", label: "色調" }),
  Object.freeze({ id: "mood", label: "氛圍" }),
]);

export const PROFILE_PRIORITY_DIMENSIONS = Object.freeze(
  PROFILE_FIELDS.filter(field => field.id !== "subject"),
);

const PRIORITY_IDS = new Set(PROFILE_PRIORITY_DIMENSIONS.map(field => field.id));
const FIELD_LABELS = Object.fromEntries(PROFILE_FIELDS.map(field => [field.id, field.label]));
const CAPTURE_PRIORITY_IDS = new Set([
  "relationship",
  "pose",
  "composition",
  "camera_angle",
  "subject_scale",
]);
const DEFAULT_CAPTURE_PRIORITIES = Object.freeze(["pose", "composition", "camera_angle"]);
const DEFAULT_FIELDS = Object.freeze({
  subject: "保留目前畫面中的人物與服裝",
  relationship: "",
  pose: "明顯、自然且有攝影目的的動作，改變手臂、身體朝向或重心",
  composition: "三分法",
  camera_angle: "由攝影師依現場選擇明確的機位高度與拍攝角度",
  subject_scale: "",
  background: "保留目前真實場景",
  color: "暖色光線",
  mood: "自然旅拍",
});

const CUES = Object.freeze({
  relationship: Object.freeze([
    [/戀人|情侶|couple|romantic/i, "戀人感"],
    [/曖昧|intimate tension/i, "曖昧感"],
    [/親密|intimate|close together/i, "自然親密"],
    [/朋友|friend/i, "朋友感"],
    [/搞怪|playful|silly/i, "搞怪互動"],
  ]),
  pose: Object.freeze([
    [/保持(?:目前|原本|原始|相同)(?:的)?(?:動作|姿勢)|不要改(?:變)?(?:人物)?(?:動作|姿勢)|no pose change|keep (?:the )?(?:same|current|original) pose/i, "保持目前姿勢，不改變動作"],
    [/Wes Anderson|魏斯安德森/i, "刻意擺拍"],
    [/不(?:要|需).*肢體接觸|no (?:physical )?contact/i, "不接觸"],
    [/肩膀.*靠|shoulders?.*(?:close|touch)/i, "肩膀靠近"],
    [/牽手|hold(?:ing)? hands/i, "牽手"],
    [/擁抱|hug/i, "擁抱"],
    [/並肩|side by side/i, "並肩"],
    [/看(?:向)?鏡頭|look(?:ing)? (?:at|toward) the camera/i, "看向鏡頭"],
  ]),
  composition: Object.freeze([
    [/Wes Anderson|魏斯安德森/i, "中央對稱"],
    [/中央對稱|置中對稱|central symmetry|symmetrical/i, "中央對稱"],
    [/三分法|rule of thirds/i, "三分法"],
    [/留白|negative space/i, "刻意留白"],
    [/置中|centered|centred/i, "主體置中"],
  ]),
  camera_angle: Object.freeze([
    [/Wes Anderson|魏斯安德森/i, "正面平視"],
    [/正面平視|平視|eye[- ]level|straight[- ]on/i, "正面平視"],
    [/低角度|仰拍|low[- ]angle/i, "低角度仰拍"],
    [/高角度|俯拍|high[- ]angle|top[- ]down/i, "高角度俯拍"],
    [/側拍|side view|profile view/i, "側面鏡位"],
  ]),
  subject_scale: Object.freeze([
    [/全身|full[- ]body|full length/i, "全身"],
    [/半身|waist[- ]up|medium shot/i, "半身"],
    [/特寫|close[- ]up/i, "特寫"],
    [/遠景|wide shot|long shot/i, "遠景"],
  ]),
  background: Object.freeze([
    [/Wes Anderson|魏斯安德森/i, "幾何背景"],
    [/幾何(?:建築|背景)|geometric (?:building|background)/i, "幾何建築"],
    [/保留(?:真實|現場|原本).*背景|keep (?:the )?(?:real|current|original) background/i, "保留目前真實場景"],
  ]),
  color: Object.freeze([
    [/Wes Anderson|魏斯安德森/i, "有限粉彩色盤"],
    [/低飽和|desaturated|low saturation/i, "低飽和"],
    [/高飽和|vivid|high saturation/i, "高飽和"],
    [/粉彩|pastel/i, "粉彩色"],
    [/暖色|golden|warm tone/i, "暖色調"],
    [/冷色|cool tone/i, "冷色調"],
    [/高對比|high contrast/i, "高對比"],
    [/底片|film look|analog/i, "底片色調"],
  ]),
  mood: Object.freeze([
    [/Wes Anderson|魏斯安德森/i, "復古、安靜、幽默"],
    [/電影感|cinematic/i, "電影感"],
    [/復古|retro|vintage/i, "復古"],
    [/安靜|quiet|calm/i, "安靜"],
    [/自然|candid|natural/i, "自然"],
    [/幽默|humorous|deadpan/i, "幽默"],
    [/青春|youthful/i, "青春"],
    [/戲劇性|dramatic/i, "戲劇性"],
  ]),
});

function cleanText(value, maxLength = 120) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function inferredValues(prompt, rules) {
  return [...new Set(rules.filter(([pattern]) => pattern.test(prompt)).map(([, value]) => value))];
}

function normalizePriorities(values, fallback = ["composition"]) {
  const unique = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (!PRIORITY_IDS.has(value) || unique.includes(value)) continue;
    unique.push(value);
    if (unique.length === 3) break;
  }
  return unique.length ? unique : fallback;
}

export function normalizeIntentProfile(input = {}) {
  const sourceFields = input.fields && typeof input.fields === "object" ? input.fields : {};
  const fields = {};
  for (const field of PROFILE_FIELDS) {
    fields[field.id] = cleanText(sourceFields[field.id]);
  }

  return {
    version: INTENT_PROFILE_VERSION,
    original_prompt: cleanText(input.original_prompt, 280),
    fields,
    important_dimensions: normalizePriorities(input.important_dimensions),
  };
}

export function inferIntentProfile(prompt = "") {
  const originalPrompt = cleanText(prompt, 280);
  const fields = { ...DEFAULT_FIELDS };
  const detectedDimensions = [];

  for (const [fieldId, rules] of Object.entries(CUES)) {
    const values = inferredValues(originalPrompt, rules);
    if (!values.length) continue;
    fields[fieldId] = values.join("、");
    detectedDimensions.push(fieldId);
  }

  if (originalPrompt && !detectedDimensions.includes("mood")) {
    fields.mood = originalPrompt;
    detectedDimensions.push("mood");
  }

  const detectedCaptureDimensions = detectedDimensions.filter(id => CAPTURE_PRIORITY_IDS.has(id));

  return normalizeIntentProfile({
    original_prompt: originalPrompt,
    fields,
    important_dimensions: [
      ...detectedCaptureDimensions,
      ...DEFAULT_CAPTURE_PRIORITIES,
      ...detectedDimensions,
    ],
  });
}

export function intentProfileMatchesPrompt(profile, prompt = "") {
  if (!profile || profile.version !== INTENT_PROFILE_VERSION) return false;
  return profile.original_prompt === cleanText(prompt, 280);
}

export function buildIntentProfileSummary(profile) {
  const normalized = normalizeIntentProfile(profile);
  const prioritySummary = normalized.important_dimensions
    .map(id => normalized.fields[id] ? `${FIELD_LABELS[id]}：${normalized.fields[id]}` : null)
    .filter(Boolean);
  if (prioritySummary.length) return prioritySummary.join("；");
  return normalized.original_prompt || "自然旅拍";
}

export function buildIntentProfilePrompt(profile) {
  const normalized = normalizeIntentProfile(profile);
  const lines = PROFILE_FIELDS
    .filter(field => normalized.fields[field.id])
    .map(field => `- ${field.label}: ${normalized.fields[field.id]}`);
  const priorityLabels = normalized.important_dimensions.map(id => FIELD_LABELS[id]);

  return `Confirmed user intent profile (${INTENT_PROFILE_VERSION}):
Original prompt: ${normalized.original_prompt || "No custom prompt; use the confirmed defaults below."}
${lines.join("\n")}
Important dimensions: ${priorityLabels.join(", ")}.
Preserve the important dimensions unless they conflict with identity, clothing, location, safety, or physical plausibility.
Treat empty or unspecified dimensions as flexible. Do not replace the confirmed profile with stereotypes inferred from a style name.`;
}
