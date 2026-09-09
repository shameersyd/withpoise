/**
 * Pose detection worker.
 *
 * Owns the MediaPipe landmarker and the whole detect loop so WASM inference
 * never runs on the main thread. Knows nothing about yoga: it takes video
 * frames in and posts smoothed landmarks out.
 *
 * Protocol
 *   in   { type: "init",  model: "full" | "heavy" }
 *        { type: "frame", bitmap: ImageBitmap, timestamp: number }   (bitmap transferred)
 *   out  { type: "status", state: "loading" | "ready" | "error", message, model }
 *        { type: "result", timestamp, detected, landmarks[], world[], inference }
 *
 * Each landmark posted back carries `held: true` when its measurement was too
 * low-confidence to trust and the smoothed history was substituted instead.
 */

import {
  PoseLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm";

const MODELS = {
  full: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
  heavy: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task",
};

// Below this visibility a landmark is a guess, not a measurement.
const VIS_THRESHOLD = 0.5;

// One Euro tuning. minCutoff sets the floor of smoothing when still (lower =
// steadier but laggier); beta relaxes it as the joint speeds up (higher = less
// lag when moving). Image landmarks are in 0..1, world landmarks in metres, so
// they get separate constants.
const TUNING = {
  image: { minCutoff: 1.1, beta: 0.35, dCutoff: 1.0 },
  world: { minCutoff: 1.1, beta: 0.30, dCutoff: 1.0 },
};

const NUM_LANDMARKS = 33;

// ─────────────────────────────────────────────────────────────
// One Euro Filter
// ─────────────────────────────────────────────────────────────
class LowPass {
  constructor() { this.y = null; }
  filter(x, alpha) {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }
  get value() { return this.y; }
}

class OneEuroFilter {
  constructor({ minCutoff, beta, dCutoff }) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = new LowPass();
    this.dx = new LowPass();
    this.tPrev = null;
    this.xPrev = null;
  }

  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  /** Feed a trusted measurement. Returns the smoothed value. */
  filter(value, tSeconds) {
    if (this.tPrev === null) {
      this.tPrev = tSeconds;
      this.xPrev = value;
      return this.x.filter(value, 1);
    }
    const dt = Math.min(0.5, Math.max(1 / 240, tSeconds - this.tPrev));
    this.tPrev = tSeconds;

    const dValue = (value - this.xPrev) / dt;
    this.xPrev = value;
    const dHat = this.dx.filter(dValue, OneEuroFilter.alpha(this.dCutoff, dt));

    const cutoff = this.minCutoff + this.beta * Math.abs(dHat);
    return this.x.filter(value, OneEuroFilter.alpha(cutoff, dt));
  }

  /**
   * No trustworthy measurement this frame: hold the smoothed history rather
   * than tracking a guessed landmark. Returns null if nothing has been seen yet.
   */
  hold(tSeconds) {
    if (this.x.value === null) return null;
    this.tPrev = tSeconds;   // so the next real sample sees a sane dt
    return this.x.value;
  }
}

/** A filter triple per landmark, for one coordinate space. */
function makeFilters(tuning) {
  return Array.from({ length: NUM_LANDMARKS }, () => ({
    x: new OneEuroFilter(tuning),
    y: new OneEuroFilter(tuning),
    z: new OneEuroFilter(tuning),
  }));
}

let imageFilters = makeFilters(TUNING.image);
let worldFilters = makeFilters(TUNING.world);

function resetFilters() {
  imageFilters = makeFilters(TUNING.image);
  worldFilters = makeFilters(TUNING.world);
}

/**
 * Smooth one landmark array. Landmarks below the visibility threshold keep
 * their last smoothed position and come back flagged `held`.
 */
function smooth(points, filters, tSeconds, visibilities) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const f = filters[i];
    const visibility = visibilities ? visibilities[i] : (p.visibility ?? 1);
    const trusted = visibility >= VIS_THRESHOLD;

    if (trusted) {
      out.push({
        x: f.x.filter(p.x, tSeconds),
        y: f.y.filter(p.y, tSeconds),
        z: f.z.filter(p.z ?? 0, tSeconds),
        visibility,
        held: false,
      });
    } else {
      const hx = f.x.hold(tSeconds), hy = f.y.hold(tSeconds), hz = f.z.hold(tSeconds);
      const seen = hx !== null;
      out.push({
        x: seen ? hx : p.x,
        y: seen ? hy : p.y,
        z: seen ? hz : (p.z ?? 0),
        visibility,
        held: true,
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Landmarker lifecycle
// ─────────────────────────────────────────────────────────────
let landmarker = null;
let currentModel = null;
let lastTimestamp = 0;

async function createLandmarker(vision, model, delegate) {
  return PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODELS[model], delegate },
    runningMode: "VIDEO",
    numPoses: 1,
  });
}

async function init(model) {
  const which = MODELS[model] ? model : "full";
  try {
    postMessage({ type: "status", state: "loading", model: which,
                  message: which === "heavy" ? "Loading heavy model (~30 MB)…"
                                             : "Loading pose model (~13 MB)…" });

    const vision = await FilesetResolver.forVisionTasks(WASM_URL);

    try {
      landmarker = await createLandmarker(vision, which, "GPU");
    } catch (gpuError) {
      // Some devices have no usable WebGL inside a worker.
      postMessage({ type: "status", state: "loading", model: which,
                    message: "GPU unavailable — falling back to CPU…" });
      landmarker = await createLandmarker(vision, which, "CPU");
    }

    currentModel = which;
    lastTimestamp = 0;
    resetFilters();
    postMessage({ type: "status", state: "ready", model: which });
  } catch (err) {
    postMessage({ type: "status", state: "error", model: which,
                  message: err && err.message ? err.message : String(err) });
  }
}

function handleFrame({ bitmap, timestamp }) {
  if (!landmarker) {
    bitmap.close();
    return;
  }

  // detectForVideo demands strictly increasing timestamps.
  const ts = timestamp > lastTimestamp ? timestamp : lastTimestamp + 1;
  lastTimestamp = ts;

  const startedAt = performance.now();
  let result = null;
  try {
    result = landmarker.detectForVideo(bitmap, ts);
  } catch (err) {
    postMessage({ type: "status", state: "error", model: currentModel,
                  message: err && err.message ? err.message : String(err) });
    return;
  } finally {
    bitmap.close();
  }

  const inference = performance.now() - startedAt;
  const tSeconds = ts / 1000;
  const hasPose = !!(result && result.landmarks && result.landmarks.length);

  if (!hasPose) {
    postMessage({ type: "result", timestamp: ts, detected: false, inference });
    return;
  }

  const image = result.landmarks[0];
  const visibilities = image.map(p => p.visibility ?? 1);
  const world = (result.worldLandmarks && result.worldLandmarks[0]) || null;

  postMessage({
    type: "result",
    timestamp: ts,
    detected: true,
    inference,
    landmarks: smooth(image, imageFilters, tSeconds, visibilities),
    // World landmarks are metric and origin-centred on the hips — the right
    // input for view-independent joint angles.
    world: world ? smooth(world, worldFilters, tSeconds, visibilities) : null,
  });
}

self.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case "init":
      init(msg.model);
      break;
    case "frame":
      handleFrame(msg);
      break;
    case "reset":
      resetFilters();
      break;
  }
};

// Exported for tests running outside a worker context.
export { OneEuroFilter, smooth, resetFilters, VIS_THRESHOLD, TUNING };
