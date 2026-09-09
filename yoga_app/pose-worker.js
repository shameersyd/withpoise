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

// The filter math and the visibility threshold are shared with the main thread,
// so `held` here and `reliable` there can never mean two different things.
import { TUNING, makeFilters, smooth } from "./pose-core.js";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm";

const MODELS = {
  full: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
  heavy: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task",
};


let imageFilters = makeFilters(TUNING.image);
let worldFilters = makeFilters(TUNING.world);

function resetFilters() {
  imageFilters = makeFilters(TUNING.image);
  worldFilters = makeFilters(TUNING.world);
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
