import {
  MatchTracker,
  mapLandmarksToCover,
  measurePoseMatch,
} from "./pose-similarity.js";

const MEDIAPIPE_VERSION = "0.10.35";
const MEDIAPIPE_ROOT = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const DEFAULT_INTERVAL_MS = 250;

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

export class PoseAlignmentController {
  constructor({
    video,
    targetImage,
    stage,
    isMirrored = () => false,
    onUpdate = () => {},
    onState = () => {},
    moduleLoader = () => import(`${MEDIAPIPE_ROOT}/vision_bundle.mjs`),
    intervalMs = DEFAULT_INTERVAL_MS,
  }) {
    this.video = video;
    this.targetImage = targetImage;
    this.stage = stage;
    this.isMirrored = isMirrored;
    this.onUpdate = onUpdate;
    this.onState = onState;
    this.moduleLoader = moduleLoader;
    this.intervalMs = intervalMs;
    this.tracker = new MatchTracker();
    this.poseLandmarker = null;
    this.landmarkerPromise = null;
    this.runningMode = "IMAGE";
    this.targetLandmarks = null;
    this.targetSize = null;
    this.timer = null;
    this.idleHandle = null;
    this.requestId = 0;
    this.activeRequestId = 0;
    this.inferenceDurations = [];
  }

  ensureLandmarker() {
    if (this.landmarkerPromise) return this.landmarkerPromise;
    if (!globalThis.WebAssembly) {
      return Promise.reject(new Error("此瀏覽器不支援裝置端姿勢分析"));
    }

    this.landmarkerPromise = (async () => {
      const { FilesetResolver, PoseLandmarker } = await this.moduleLoader();
      const vision = await FilesetResolver.forVisionTasks(`${MEDIAPIPE_ROOT}/wasm`);
      this.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL },
        runningMode: this.runningMode,
        numPoses: 2,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputSegmentationMasks: false,
      });
      return this.poseLandmarker;
    })().catch(error => {
      this.landmarkerPromise = null;
      throw error;
    });
    return this.landmarkerPromise;
  }

  async setRunningMode(mode) {
    await this.ensureLandmarker();
    if (this.runningMode === mode) return;
    await this.poseLandmarker.setOptions({ runningMode: mode });
    this.runningMode = mode;
  }

  processFrameLandmarks(poses) {
    if (!this.targetLandmarks) return;
    if (poses.length !== 1) {
      const measurement = this.tracker.update({
        valid: false,
        reason: poses.length > 1 ? "live_multiple" : "live_missing",
      }, performance.now());
      this.onUpdate({ measurement, summary: this.summary() });
      return;
    }

    const stageSize = {
      width: this.stage.clientWidth,
      height: this.stage.clientHeight,
    };
    const liveSize = {
      width: this.video.videoWidth,
      height: this.video.videoHeight,
    };
    if (!stageSize.width || !stageSize.height || !liveSize.width || !liveSize.height) return;

    const transformOptions = { mirrored: this.isMirrored() };
    const target = mapLandmarksToCover(
      this.targetLandmarks,
      this.targetSize,
      stageSize,
      transformOptions,
    );
    const live = mapLandmarksToCover(poses[0], liveSize, stageSize, transformOptions);
    const measurement = this.tracker.update(
      measurePoseMatch(target, live),
      performance.now(),
    );
    this.onUpdate({ measurement, summary: this.summary() });
  }

  async setTarget() {
    this.stop();
    this.tracker.reset();
    this.inferenceDurations = [];
    this.onState({ state: "loading", message: "分析幽靈姿勢" });
    const requestId = ++this.requestId;
    this.activeRequestId = requestId;
    await this.ensureLandmarker();
    await this.targetImage.decode?.();
    if (requestId !== this.activeRequestId) throw new Error("姿勢分析已重設");
    if (!this.targetImage.naturalWidth || !this.targetImage.naturalHeight) {
      throw new Error("幽靈影像尚未載入");
    }

    await this.setRunningMode("IMAGE");
    const result = this.poseLandmarker.detect(this.targetImage);
    const poses = result.landmarks.map(pose =>
      pose.map(landmark => ({ ...landmark })),
    );
    result.close();
    if (requestId !== this.activeRequestId) throw new Error("姿勢分析已重設");
    if (poses.length !== 1) {
      throw new Error(poses.length > 1 ? "幽靈影像中偵測到多人" : "幽靈姿勢無法辨識");
    }

    this.targetLandmarks = poses[0];
    this.targetSize = {
      width: this.targetImage.naturalWidth,
      height: this.targetImage.naturalHeight,
    };
    await this.setRunningMode("VIDEO");
    if (requestId !== this.activeRequestId) throw new Error("姿勢分析已重設");
    this.onState({ state: "ready" });
    this.scheduleFrame(0);
  }

  scheduleFrame(delay = this.intervalMs) {
    clearTimeout(this.timer);
    if (!this.targetLandmarks) return;
    this.timer = setTimeout(() => {
      if (globalThis.requestIdleCallback) {
        this.idleHandle = globalThis.requestIdleCallback(() => {
          this.idleHandle = null;
          this.captureFrame();
        }, { timeout: this.intervalMs });
      } else {
        this.captureFrame();
      }
    }, delay);
  }

  captureFrame() {
    if (!this.targetLandmarks || this.video.readyState < 2) {
      this.scheduleFrame();
      return;
    }

    const startedAt = performance.now();
    try {
      const result = this.poseLandmarker.detectForVideo(this.video, startedAt);
      this.processFrameLandmarks(result.landmarks);
      result.close();
      const elapsed = performance.now() - startedAt;
      this.inferenceDurations.push(elapsed);
      if (this.inferenceDurations.length > 120) this.inferenceDurations.shift();
      this.scheduleFrame(Math.max(0, this.intervalMs - elapsed));
    } catch (error) {
      this.onState({
        state: "unavailable",
        reason: "runtime_error",
        message: error instanceof Error ? error.message : String(error),
      });
      this.scheduleFrame();
    }
  }

  target() {
    if (!this.targetLandmarks || !this.targetSize) return null;
    return { landmarks: this.targetLandmarks, size: this.targetSize };
  }

  summary() {
    const summary = this.tracker.summary();
    if (!summary) return null;
    return {
      ...summary,
      inference_ms: {
        p50: Math.round((percentile(this.inferenceDurations, 0.5) ?? 0) * 10) / 10,
        p95: Math.round((percentile(this.inferenceDurations, 0.95) ?? 0) * 10) / 10,
        samples: this.inferenceDurations.length,
      },
    };
  }

  stop() {
    clearTimeout(this.timer);
    if (this.idleHandle !== null && globalThis.cancelIdleCallback) {
      globalThis.cancelIdleCallback(this.idleHandle);
    }
    this.timer = null;
    this.idleHandle = null;
    this.activeRequestId = ++this.requestId;
    this.targetLandmarks = null;
    this.targetSize = null;
  }

  dispose() {
    this.stop();
    this.poseLandmarker?.close();
    this.poseLandmarker = null;
    this.landmarkerPromise = null;
  }
}
