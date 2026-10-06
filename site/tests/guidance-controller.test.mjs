import test from "node:test";
import assert from "node:assert/strict";

import { GuidanceController } from "../public/guidance-controller.js";

const hint = (id, severity = 0.6, confidence = 0.9) => ({
  id,
  dimension: id,
  severity,
  confidence,
  text: `${id} action, because reason`,
  reason: `${id} reason`,
});

test("a hint must remain the largest candidate for 400 ms before appearing", () => {
  const controller = new GuidanceController();

  assert.equal(controller.update([hint("x")], 0).candidate, null);
  assert.equal(controller.update([hint("x")], 399).candidate, null);
  assert.equal(controller.update([hint("x")], 400).candidate.id, "x");
});

test("single-frame noise never becomes active", () => {
  const controller = new GuidanceController();

  controller.update([hint("x")], 0);
  controller.update([hint("y")], 100);
  controller.update([], 200);

  assert.equal(controller.state().candidate, null);
});

test("an active hint resists small severity changes but switches after a stable larger gap", () => {
  const controller = new GuidanceController();
  controller.update([hint("x", 0.6)], 0);
  controller.update([hint("x", 0.6)], 400);

  assert.equal(controller.update([hint("x", 0.6), hint("y", 0.65)], 500).candidate.id, "x");
  assert.equal(controller.update([hint("x", 0.6), hint("y", 0.8)], 600).candidate.id, "x");
  assert.equal(controller.update([hint("x", 0.6), hint("y", 0.8)], 999).candidate.id, "x");
  assert.equal(controller.update([hint("x", 0.6), hint("y", 0.8)], 1000).candidate.id, "y");
});

test("resolved hints emit an event and the next correction must stabilize", () => {
  const events = [];
  const controller = new GuidanceController({ onEvent: event => events.push(event) });
  controller.update([hint("x")], 0);
  controller.update([hint("x")], 400);

  assert.equal(controller.update([hint("y")], 500).candidate, null);
  assert.equal(events.some(event => event.event === "guidance_resolved" && event.candidate.id === "x"), true);
  assert.equal(controller.update([hint("y")], 900).candidate.id, "y");
});

test("skip suppresses only the current hint for a bounded interval", () => {
  const controller = new GuidanceController({ suppressionMs: 1000 });
  controller.update([hint("x")], 0);
  controller.update([hint("x")], 400);
  controller.skip(500);

  assert.equal(controller.update([hint("x"), hint("y", 0.5)], 600).candidate, null);
  assert.equal(controller.update([hint("x"), hint("y", 0.5)], 1000).candidate.id, "y");
  assert.equal(controller.update([hint("x")], 1500).candidate, null);
  assert.equal(controller.update([hint("x")], 1900).candidate.id, "x");
});

test("pause clears active guidance and resume requires restabilization", () => {
  const controller = new GuidanceController();
  controller.update([hint("x")], 0);
  controller.update([hint("x")], 400);
  controller.setPaused(true, 500);

  assert.equal(controller.update([hint("x")], 1000).candidate, null);
  assert.equal(controller.state().paused, true);
  controller.setPaused(false, 1100);
  assert.equal(controller.update([hint("x")], 1100).candidate, null);
  assert.equal(controller.update([hint("x")], 1500).candidate.id, "x");
});

test("low-confidence and tiny candidates are filtered out", () => {
  const controller = new GuidanceController();

  controller.update([hint("weak", 0.09, 0.9), hint("uncertain", 0.8, 0.2)], 0);
  assert.equal(controller.update([hint("weak", 0.09, 0.9), hint("uncertain", 0.8, 0.2)], 500).candidate, null);
});
