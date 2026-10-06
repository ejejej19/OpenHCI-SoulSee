export class CameraController {
  constructor({
    video,
    mirrorTargets = [video],
    buttons = [],
    trigger = null,
    mediaDevices = globalThis.navigator?.mediaDevices,
    defaultMode = "environment",
    onStarted = () => {},
    onError = () => {},
  }) {
    this.video = video;
    this.mirrorTargets = mirrorTargets;
    this.buttons = Array.from(buttons);
    this.trigger = trigger;
    this.mediaDevices = mediaDevices;
    this.mode = defaultMode;
    this.stream = null;
    this.requestId = 0;
    this.onStarted = onStarted;
    this.onError = onError;

    this.buttons.forEach((button) => {
      button.addEventListener("click", () => this.start(button.dataset.cameraFacing));
    });
    this.trigger?.addEventListener("click", () => this.start());
    this.updateControls();
  }

  setBusy(busy) {
    this.buttons.forEach((button) => { button.disabled = busy; });
    if (this.trigger) this.trigger.disabled = busy;
  }

  updateControls() {
    this.buttons.forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.cameraFacing === this.mode));
    });
    this.mirrorTargets.forEach((target) => {
      target.classList.toggle("is-front-camera", this.mode === "user");
    });
  }

  stop() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  async start(mode = this.mode) {
    if (this.stream && mode === this.mode) return;

    if (!this.mediaDevices?.getUserMedia) {
      this.onError(new Error("此瀏覽器不支援相機"));
      return;
    }

    const requestId = ++this.requestId;
    this.setBusy(true);
    this.stop();

    try {
      const stream = await this.mediaDevices.getUserMedia({
        video: { facingMode: mode },
        audio: false,
      });

      if (requestId !== this.requestId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      this.stream = stream;
      this.video.srcObject = stream;
      await this.video.play().catch(() => {});

      const actualMode = stream.getVideoTracks()[0]?.getSettings().facingMode;
      this.mode = actualMode === "user" || actualMode === "environment" ? actualMode : mode;
      this.updateControls();
      this.onStarted(this.mode);
    } catch (error) {
      if (requestId === this.requestId) this.onError(error);
    } finally {
      if (requestId === this.requestId) this.setBusy(false);
    }
  }
}
