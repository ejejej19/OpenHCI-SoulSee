export const ORIENTATION_METRIC_VERSION = "screen-roll-v1";

const toRadians = degrees => degrees * Math.PI / 180;
const toDegrees = radians => radians * 180 / Math.PI;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function normalizeDegrees(value) {
  let normalized = value % 360;
  if (normalized > 180) normalized -= 360;
  if (normalized <= -180) normalized += 360;
  return normalized;
}

export function screenRollFromOrientation(event, screenAngle = 0) {
  if (!Number.isFinite(event?.beta) || !Number.isFinite(event?.gamma)) {
    return { valid: false, reason: "orientation_missing", metric_version: ORIENTATION_METRIC_VERSION };
  }

  const beta = toRadians(event.beta);
  const gamma = toRadians(event.gamma);
  const angle = toRadians(Number.isFinite(screenAngle) ? screenAngle : 0);

  // Project gravity onto the physical screen, then rotate device axes into screen axes.
  const deviceX = -Math.cos(beta) * Math.sin(gamma);
  const deviceY = Math.sin(beta);
  const screenX = Math.cos(angle) * deviceX + Math.sin(angle) * deviceY;
  const screenY = -Math.sin(angle) * deviceX + Math.cos(angle) * deviceY;
  const projectedGravity = Math.hypot(screenX, screenY);

  if (projectedGravity < 0.15) {
    return { valid: false, reason: "device_too_flat", metric_version: ORIENTATION_METRIC_VERSION };
  }

  return {
    valid: true,
    metric_version: ORIENTATION_METRIC_VERSION,
    roll_degrees: normalizeDegrees(toDegrees(Math.atan2(screenX, screenY))),
    confidence: clamp((projectedGravity - 0.15) / 0.6, 0, 1),
  };
}

export class DeviceOrientationController {
  constructor({
    windowObject = globalThis.window,
    orientationEventClass = globalThis.DeviceOrientationEvent,
    screenAngle = () => windowObject?.screen?.orientation?.angle ?? windowObject?.orientation ?? 0,
    onUpdate = () => {},
    onState = () => {},
  } = {}) {
    this.windowObject = windowObject;
    this.orientationEventClass = orientationEventClass;
    this.screenAngle = screenAngle;
    this.onUpdate = onUpdate;
    this.onState = onState;
    this.boundOrientation = event => this.handleOrientation(event);
    this.measurement = null;
    this.started = false;
  }

  async requestAndStart() {
    if (!this.windowObject || !this.orientationEventClass) {
      this.onState({ state: "unavailable", reason: "unsupported" });
      return false;
    }

    if (typeof this.orientationEventClass.requestPermission === "function") {
      try {
        const permission = await this.orientationEventClass.requestPermission();
        if (permission !== "granted") {
          this.onState({ state: "unavailable", reason: "permission_denied" });
          return false;
        }
      } catch {
        this.onState({ state: "unavailable", reason: "permission_failed" });
        return false;
      }
    }

    if (!this.started) {
      this.windowObject.addEventListener("deviceorientation", this.boundOrientation, true);
      this.started = true;
    }
    this.onState({ state: "listening" });
    return true;
  }

  handleOrientation(event) {
    const next = screenRollFromOrientation(event, Number(this.screenAngle()) || 0);
    if (!next.valid) return;
    if (this.measurement?.valid) {
      next.roll_degrees = this.measurement.roll_degrees * 0.75 + next.roll_degrees * 0.25;
      next.confidence = Math.max(this.measurement.confidence * 0.9, next.confidence);
    }
    this.measurement = next;
    this.onUpdate(next);
  }

  summary() {
    if (!this.measurement?.valid) return null;
    return {
      metric_version: ORIENTATION_METRIC_VERSION,
      roll_degrees: Math.round(this.measurement.roll_degrees * 10) / 10,
      confidence: Math.round(this.measurement.confidence * 100) / 100,
    };
  }

  stop() {
    if (this.started) {
      this.windowObject.removeEventListener("deviceorientation", this.boundOrientation, true);
      this.started = false;
    }
  }
}
