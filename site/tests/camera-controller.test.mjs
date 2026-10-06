import test from "node:test";
import assert from "node:assert/strict";
import { CameraController } from "../public/camera-controller.js";

function fakeButton(mode) {
  return {
    dataset: { cameraFacing: mode },
    disabled: false,
    attributes: {},
    addEventListener(_type, handler) { this.click = handler; },
    setAttribute(name, value) { this.attributes[name] = value; },
  };
}

function fakeVideo() {
  const classes = new Set();
  return {
    srcObject: null,
    play: async () => {},
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
  };
}

function fakeStream(mode, stopped) {
  const track = {
    stop: () => stopped.push(mode),
    getSettings: () => ({ facingMode: mode }),
  };
  return {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  };
}

test("switches from rear to front and stops the previous track", async () => {
  const requested = [];
  const stopped = [];
  const video = fakeVideo();
  const front = fakeButton("user");
  const rear = fakeButton("environment");
  const controller = new CameraController({
    video,
    buttons: [front, rear],
    mediaDevices: {
      async getUserMedia(constraints) {
        const mode = constraints.video.facingMode;
        requested.push(constraints);
        return fakeStream(mode, stopped);
      },
    },
  });

  await controller.start();
  await controller.start("user");

  assert.deepEqual(requested.map(({ video: { facingMode } }) => facingMode), ["environment", "user"]);
  assert.deepEqual(stopped, ["environment"]);
  assert.equal(front.attributes["aria-pressed"], "true");
  assert.equal(rear.attributes["aria-pressed"], "false");
  assert.equal(video.classList.contains("is-front-camera"), true);
});

test("mirrors every configured preview target without touching stream pixels", async () => {
  const stopped = [];
  const video = fakeVideo();
  const overlay = fakeVideo();
  const controller = new CameraController({
    video,
    mirrorTargets: [video, overlay],
    mediaDevices: { getUserMedia: async () => fakeStream("user", stopped) },
  });

  await controller.start("user");

  assert.equal(video.classList.contains("is-front-camera"), true);
  assert.equal(overlay.classList.contains("is-front-camera"), true);
});

test("reports camera permission failures and re-enables controls", async () => {
  const errors = [];
  const button = fakeButton("environment");
  const controller = new CameraController({
    video: fakeVideo(),
    buttons: [button],
    mediaDevices: { getUserMedia: async () => { throw new Error("permission denied"); } },
    onError: (error) => errors.push(error.message),
  });

  await controller.start();

  assert.deepEqual(errors, ["permission denied"]);
  assert.equal(button.disabled, false);
});
