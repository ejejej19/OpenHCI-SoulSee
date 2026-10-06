export const GUIDANCE_CONTROLLER_VERSION = "single-guidance-v1";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const defaultNow = () => globalThis.performance?.now?.() ?? Date.now();

function normalizeCandidate(input, order) {
  if (
    !input ||
    typeof input.id !== "string" ||
    !input.id ||
    typeof input.text !== "string" ||
    !input.text ||
    !Number.isFinite(input.severity) ||
    !Number.isFinite(input.confidence)
  ) return null;
  return {
    ...input,
    severity: clamp(input.severity, 0, 1),
    confidence: clamp(input.confidence, 0, 1),
    order,
  };
}

export class GuidanceController {
  constructor({
    stabilityMs = 400,
    suppressionMs = 5000,
    minimumSeverity = 0.1,
    minimumConfidence = 0.45,
    switchMargin = 0.08,
    now = defaultNow,
    onEvent = () => {},
  } = {}) {
    this.stabilityMs = stabilityMs;
    this.suppressionMs = suppressionMs;
    this.minimumSeverity = minimumSeverity;
    this.minimumConfidence = minimumConfidence;
    this.switchMargin = switchMargin;
    this.now = now;
    this.onEvent = onEvent;
    this.reset();
  }

  reset() {
    this.active = null;
    this.pending = null;
    this.paused = false;
    this.suppressedUntil = new Map();
  }

  emit(type, candidate, timestamp, details = {}) {
    this.onEvent({
      event: `guidance_${type}`,
      controller_version: GUIDANCE_CONTROLLER_VERSION,
      at_ms: timestamp,
      candidate: candidate ? {
        id: candidate.id,
        dimension: candidate.dimension,
        severity: candidate.severity,
        confidence: candidate.confidence,
        reason: candidate.reason,
      } : null,
      ...details,
    });
  }

  eligibleCandidates(candidates, timestamp) {
    for (const [id, until] of this.suppressedUntil) {
      if (until <= timestamp) this.suppressedUntil.delete(id);
    }
    return (Array.isArray(candidates) ? candidates : [])
      .map(normalizeCandidate)
      .filter(Boolean)
      .filter(candidate => (
        candidate.severity >= this.minimumSeverity &&
        candidate.confidence >= this.minimumConfidence &&
        (this.suppressedUntil.get(candidate.id) ?? 0) <= timestamp
      ))
      .sort((left, right) => right.severity - left.severity || left.order - right.order);
  }

  startOrContinuePending(candidate, timestamp) {
    if (this.pending?.id !== candidate.id) {
      this.pending = { ...candidate, since: timestamp };
      return false;
    }
    this.pending = { ...candidate, since: this.pending.since };
    return timestamp - this.pending.since >= this.stabilityMs;
  }

  activate(candidate, timestamp) {
    const previous = this.active;
    this.active = { ...candidate, shown_at: timestamp };
    this.pending = null;
    if (previous && previous.id !== candidate.id) {
      this.emit("replaced", previous, timestamp, { replacement_id: candidate.id });
    }
    this.emit("shown", this.active, timestamp);
  }

  update(candidates, timestamp = this.now()) {
    if (this.paused) return this.state();
    const eligible = this.eligibleCandidates(candidates, timestamp);
    const best = eligible[0] ?? null;
    const activeCandidate = this.active
      ? eligible.find(candidate => candidate.id === this.active.id) ?? null
      : null;

    if (this.active && !activeCandidate) {
      this.emit("resolved", this.active, timestamp);
      this.active = null;
      this.pending = null;
    }

    if (!best) {
      this.pending = null;
      return this.state();
    }

    if (activeCandidate && best.id === activeCandidate.id) {
      this.active = { ...activeCandidate, shown_at: this.active.shown_at };
      this.pending = null;
      return this.state();
    }

    if (
      activeCandidate &&
      best.id !== activeCandidate.id &&
      best.severity < activeCandidate.severity + this.switchMargin
    ) {
      this.active = { ...activeCandidate, shown_at: this.active.shown_at };
      this.pending = null;
      return this.state();
    }

    if (this.startOrContinuePending(best, timestamp)) this.activate(best, timestamp);
    return this.state();
  }

  skip(timestamp = this.now()) {
    if (!this.active) return null;
    const skipped = this.active;
    const suppressedUntil = timestamp + this.suppressionMs;
    this.suppressedUntil.set(skipped.id, suppressedUntil);
    this.emit("skipped", skipped, timestamp, { suppressed_until_ms: suppressedUntil });
    this.active = null;
    this.pending = null;
    return skipped;
  }

  setPaused(paused, timestamp = this.now()) {
    const next = Boolean(paused);
    if (next === this.paused) return this.state();
    this.paused = next;
    this.active = null;
    this.pending = null;
    this.emit(next ? "paused" : "resumed", null, timestamp);
    return this.state();
  }

  state() {
    return {
      controller_version: GUIDANCE_CONTROLLER_VERSION,
      paused: this.paused,
      candidate: this.active ? { ...this.active } : null,
      pending_id: this.pending?.id ?? null,
    };
  }
}
