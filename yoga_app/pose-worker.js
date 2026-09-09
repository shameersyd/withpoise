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

// ─────────────────────────────────────────────────────────────
// importScripts, for a worker that does not have one
//
// This is a module worker, and module workers have no importScripts(). But
// MediaPipe's wasm loader calls it — the ES bundle is a module, the WebAssembly
// glue it pulls in at runtime is a classic script — so createFromOptions() died
// with "Module scripts don't support importScripts()" and the landmarker never
// came up at all.
//
// Synchronous XHR is the one way to fetch a script synchronously, and unlike on
// the main thread it is entirely legitimate in a worker. Indirect eval puts the
// result in global scope, which is where importScripts would have put it.
// ─────────────────────────────────────────────────────────────
// It is not missing — it is present and throws, so the feature test has to
// call it. With no arguments a working importScripts does nothing at all.
let importScriptsWorks = true;
try { self.importScripts(); } catch { importScriptsWorks = false; }

if (!importScriptsWorks) {
  self.importScripts = (...urls) => {
    for (const url of urls) {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, false);
      xhr.send(null);
      if (xhr.status && xhr.status >= 400) {
        throw new Error(`Could not load ${url} (${xhr.status})`);
      }
      (0, eval)(xhr.responseText);
    }
  };
}

import {
  PoseLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs";

// The frame logic, the filter math and the visibility threshold all live in
// pose-core.js: shared with the main thread so `held` here and `reliable` there
// can never mean two different things, and testable, which a worker is not.
import { FrameProcessor } from "./pose-core.js";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm";

const MODELS = {
  full: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
  heavy: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task",
};

const frames = new FrameProcessor();

// ─────────────────────────────────────────────────────────────
// Landmarker lifecycle
// ─────────────────────────────────────────────────────────────
let landmarker = null;
let currentModel = null;
let currentDelegate = null;

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

    // GPU first, CPU if the device has no usable WebGL inside a worker. Which
    // one we ended up on is reported, because it is the single biggest factor
    // in how fast this runs and it was previously invisible.
    try {
      landmarker = await createLandmarker(vision, which, "GPU");
      currentDelegate = "GPU";
    } catch (gpuError) {
      postMessage({ type: "status", state: "loading", model: which,
                    message: "GPU unavailable — falling back to CPU…" });
      landmarker = await createLandmarker(vision, which, "CPU");
      currentDelegate = "CPU";
    }

    currentModel = which;
    frames.reset();
    postMessage({ type: "status", state: "ready", model: which, delegate: currentDelegate });
  } catch (err) {
    postMessage({ type: "status", state: "error", model: which,
                  message: err && err.message ? err.message : String(err) });
  }
}

// Exactly one `result` goes back for every frame that comes in, on every path
// including failure — the main thread waits for it before sending another.
// FrameProcessor is where that promise is kept, and tested.
function handleFrame(msg) {
  frames.process(msg, {
    landmarker,
    post: (out) => postMessage(out.type === "status" ? { ...out, model: currentModel } : out),
    now: () => performance.now(),
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
      frames.reset();
      break;
  }
};
