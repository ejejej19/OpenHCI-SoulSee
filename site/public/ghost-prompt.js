import {
  PROFILE_FIELDS,
  buildIntentProfilePrompt,
  normalizeIntentProfile,
} from "./intent-profile.js";

export const PHOTOGRAPHY_PROMPT_VERSION = "photography-direction-v2-visible-pose";
export const CAPTURE_INTENT_DIMENSIONS = Object.freeze([
  "relationship",
  "pose",
  "composition",
  "camera_angle",
  "subject_scale",
  "background",
]);
export const POST_PRODUCTION_INTENT_DIMENSIONS = Object.freeze([
  "color",
  "mood",
]);

const FIELD_LABELS = Object.fromEntries(PROFILE_FIELDS.map(field => [field.id, field.label]));
const POSE_PRESERVATION_PATTERN = /保持.*(?:姿勢|動作)|不改變.*(?:姿勢|動作)|same pose|no pose change/i;

function confirmedStageLines(profile, dimensionIds) {
  const lines = dimensionIds
    .filter(id => profile.fields[id])
    .map(id => `  - ${FIELD_LABELS[id]}: ${profile.fields[id]}`);
  return lines.length ? lines.join("\n") : "  - No additional direction confirmed; preserve the source image.";
}

function poseDirectionContract(profile) {
  if (POSE_PRESERVATION_PATTERN.test(profile.fields.pose)) {
    return `- Pose/action exception: the user explicitly confirmed no pose change. Preserve the current pose and improve only the other confirmed capture-time dimensions.`;
  }
  return `- Visible pose/action delta (required): the Ghost must demonstrate a clearly different, photographically purposeful pose or action, not a retouched near-copy of the source pose.
- Change at least two observable cues: arm or hand configuration, torso orientation, weight distribution or leg stance, gaze or head angle, or interpersonal spacing. A facial-expression, finger, or shoulder micro-adjustment alone is not enough.
- Make the confirmed pose unmistakably readable. If pose is unspecified, choose a professional direction with a clean silhouette, intentional hands, clear body line, and plausible balance for the framing.`;
}

export function buildPhotographyGhostPrompt(intentProfile) {
  const normalized = normalizeIntentProfile(intentProfile);
  const priorityOrder = normalized.important_dimensions.join(", ");

  return `Create a polished, photorealistic AI Ghost of this exact scene.
Act as a professional photographer and on-set art director. Silently translate the confirmed intent into one coherent, physically plausible capture plan before editing the image; do not output the plan.

${buildIntentProfilePrompt(normalized)}

Capture-time direction (must be solved before the shutter):
${confirmedStageLines(normalized, CAPTURE_INTENT_DIMENSIONS)}
- Composition and negative space: use subject placement, visual balance, leading lines, horizon or dominant scene boundaries, and intentional negative space to express the confirmed composition.
- Shot size and subject scale: choose full-body, medium, close-up, or wide framing that matches the confirmed subject scale without arbitrary cropping.
- Camera position and perspective: use camera height, camera angle, distance, perspective, and a plausible focal-length look together. Avoid optical geometry that a real camera at this location could not produce.
- Subject direction: preserve identity and body proportions while staging the confirmed pose, gaze, relationship, and placement. When pose is unspecified, actively choose a professional pose rather than preserving the source pose by default. Keep subject-background separation legible without changing who the person is.
${poseDirectionContract(normalized)}
- Pose readability: keep limbs and hands visually legible, avoid merging both arms into the torso, and use an intentional torso-to-camera relationship and weight shift unless the user explicitly requests a static pose.
- Capture optics: choose focus, base exposure, and depth of field that are physically plausible for the framing, camera distance, and scene. Preserve scene-faithful light direction and quality.

Post-production look (reversible after capture):
${confirmedStageLines(normalized, POST_PRODUCTION_INTENT_DIMENSIONS)}
- Color rendering: translate only the confirmed color and mood into white balance and color temperature, palette, contrast, and saturation.
- Tonal rendering: adjust highlights, shadows, and overall brightness without inventing a different light source or hiding capture errors.
- Filters, effects, and retouching: keep them non-geometric and reversible-looking. Do not reshape the face or body, replace the background, move the subject, or change perspective.
- The Ghost image may preview this post-production look so the separate editor can measure it, but the look must not alter capture-time geometry.

Decision policy:
- Priority order: ${priorityOrder || "use the confirmed profile order"}. Preserve these important dimensions first unless they conflict with identity, clothing, location, safety, or physical plausibility.
- Treat the original prompt as provenance, not permission to invent visual attributes. If it names a style, artist, or director, use only the concrete observable attributes in the confirmed profile; do not add stereotypes or unconfirmed signature elements.
- Use professional photography judgment for unspecified capture-time dimensions, especially pose and camera viewpoint. Keep unspecified post-production choices neutral; do not silently substitute generic cinematic styling, warm color, shallow depth of field, or rule-of-thirds composition.
- Never describe pose, subject placement or scale, camera angle, perspective, framing, focus, or depth of field as something post-production can repair. Those decisions belong to capture-time guidance.
- Keep the original captured pixels available for the separate post-production page; represent its appearance changes as a non-destructive look rather than a replacement scene.
- Keep the SAME person and identity, facial structure, body shape, clothing, location, background structure, and recognizable real scene. Do not replace the background, invent or remove major objects, perform generic beautification, or use impossible relighting.
- If a pose or camera instruction conflicts with identity, clothing, background structure, safety, or physical plausibility, preserve those facts and choose another clearly visible pose or camera solution; do not fall back to a near-copy.

Output the image only. Do not output analysis, a capture plan, labels, borders, or text.`;
}
