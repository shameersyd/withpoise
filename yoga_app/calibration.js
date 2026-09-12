/**
 * Measuring the user, once, so that later frames have something to be
 * constrained by.
 *
 * The app has always guessed the user's proportions from whatever frame it was
 * looking at. That guess is contaminated by exactly the thing it is trying to
 * see through: a limb pointing at the lens projects short, so its measured
 * length is short, so the target outline built from it is wrong in the same
 * direction as the error.
 *
 * Bone lengths do not change during a session. Measuring them properly once,
 * from two views, gives every later frame a fixed quantity to work against —
 * which is what the rest of this work is built on.
 *
 * Two views rather than one because the error is directional. A bone lying
 * across the image is measured well; a bone pointing down the lens is measured
 * badly. Turn the user 90° and the two swap over. Fusing the views by how well
 * each resolved each bone gets a better answer than either alone, and it is the
 * same `depthShare` the joint measurability gate already uses.
 */

import { LM, v3, bodyFrame, depthShare } from "./pose-core.js";

/**
 * The lengths worth measuring, and which segments provide evidence for each.
 *
 * Bilateral: one upper-arm length from both arms, not one per arm. That is not
 * a simplification, it is what the consumer already assumes — buildReference
 * has always built its figure from a single SEG.upper, SEG.thigh and so on, so
 * measuring the two sides separately did twice the work and then discarded
 * half of it. Pooling them doubles the evidence behind each number for free,
 * and real bodies are near enough symmetric that the assumption is sound.
 */
export const BONES = {
  torso:        [["shoulder_centre", "hip_centre"]],
  shoulderSpan: [["left_shoulder", "right_shoulder"]],
  hipSpan:      [["left_hip", "right_hip"]],
  neck:         [["shoulder_centre", "nose"]],
  upperArm:     [["left_shoulder", "left_elbow"], ["right_shoulder", "right_elbow"]],
  forearm:      [["left_elbow", "left_wrist"], ["right_elbow", "right_wrist"]],
  thigh:        [["left_hip", "left_knee"], ["right_hip", "right_knee"]],
  shin:         [["left_knee", "left_ankle"], ["right_knee", "right_ankle"]],
};

const centres = {
  shoulder_centre: (w) => v3.mid(w[LM.left_shoulder], w[LM.right_shoulder]),
  hip_centre: (w) => v3.mid(w[LM.left_hip], w[LM.right_hip]),
};
const point = (world, name) =>
  centres[name] ? centres[name](world) : world[LM[name]];

const endpointsOf = (name) =>
  name in centres ? (name === "shoulder_centre"
    ? ["left_shoulder", "right_shoulder"] : ["left_hip", "right_hip"]) : [name];

/**
 * One frame's worth of evidence about one bone: how long it looked across the
 * image, and how much of it was pointing away from the camera.
 *
 * The length reported is the bone's extent **in the image plane only** — x and
 * y, never z. That is deliberate and it is the whole idea:
 *
 *   · A projection can only ever shorten. A bone of length L at share s from
 *     the camera axis projects to L·√(1−s²) ≤ L, always.
 *   · x and y are the coordinates a camera actually measures.
 *
 * So every observation is a *lower bound* on the true length, made of
 * trustworthy numbers, and the best of them is the answer. Which is precisely
 * what the second view is for: a bone hidden down the lens in one view lies
 * across the image in the other.
 *
 * The tempting alternative — take |v| in 3D and correct it by √(1−s²) — was
 * tried and does not work, for a reason worth recording. Under depth
 * compression the observed s is itself compressed: a forearm genuinely 42%
 * along the camera axis reports 18%, so the correction applied is a fifth of
 * the one needed and the estimate lands 7% short. You cannot correct for a
 * distortion using a number the distortion has already eaten.
 */
export function observeBone(world, frame, [from, to]) {
  const a = point(world, from), b = point(world, to);
  const vector = v3.sub(b, a);
  const acrossImage = Math.hypot(vector.x, vector.y);
  if (!(acrossImage > 0)) return null;
  return {
    length: acrossImage,
    share: depthShare(vector, frame),
    weight: 1,
  };
}

/** Every landmark a bone depends on, for the reliability check. */
export function bonePrerequisites(bone) {
  return [...endpointsOf(bone[0]), ...endpointsOf(bone[1])];
}

/**
 * The weighted median of a set of observations.
 *
 * Kept because it is the right tool for a single hostile frame — a limb
 * momentarily confused with the background produces a length wrong by a factor,
 * not by a percent, and a mean carries that forever.
 */
export function weightedMedian(samples) {
  const usable = samples.filter(s => s && s.length > 0);
  if (!usable.length) return null;
  const sorted = [...usable].sort((a, b) => a.length - b.length);
  const total = sorted.reduce((sum, s) => sum + s.weight, 0);
  if (total <= 0) return sorted[Math.floor(sorted.length / 2)].length;

  let running = 0;
  for (const sample of sorted) {
    running += sample.weight;
    if (running >= total / 2) return sample.length;
  }
  return sorted[sorted.length - 1].length;
}

// How much of each tail to discard before averaging. 10% either end is enough
// to clear a tracking failure — those land far outside the distribution, not
// just inside the tail — and keeping four fifths of the evidence rather than
// three fifths is worth about 0.3% of reproducibility on the shortest bone.
const TRIM = 0.1;

/**
 * A trimmed weighted mean: robust like a median, precise like a mean.
 *
 * A median is the obvious choice and it costs more than it looks. It returns
 * one observation's value, so its precision is that of a single frame reduced
 * only by √n — and on a short bone like a forearm, where depth noise is a large
 * fraction of the length, that left repeat calibrations 2.2% apart, outside the
 * ±2% this has to hold to.
 *
 * Trimming the tails first removes the outliers a median exists to survive;
 * averaging what remains then actually uses the other hundred frames.
 */
export function robustLength(samples) {
  const usable = samples.filter(s => s && s.length > 0 && s.weight > 0);
  if (usable.length < 5) return weightedMedian(samples);

  const sorted = [...usable].sort((a, b) => a.length - b.length);
  const total = sorted.reduce((sum, s) => sum + s.weight, 0);

  let running = 0, weighted = 0, kept = 0;
  for (const sample of sorted) {
    const from = running / total, to = (running + sample.weight) / total;
    running += sample.weight;
    if (to < TRIM || from > 1 - TRIM) continue;      // in a tail
    weighted += sample.length * sample.weight;
    kept += sample.weight;
  }
  return kept > 0 ? weighted / kept : weightedMedian(samples);
}

/**
 * Fuse the views into one length per bone.
 *
 * Within a view, average: the frames differ only by noise and there are a
 * hundred of them. Across views, take the largest: they differ by how much of
 * the bone each one could see, and since a projection only ever shortens, the
 * longest sighting is the closest to the truth.
 *
 * Averaging across views instead would split the difference between a good
 * measurement and a foreshortened one, which is the wrong answer every time.
 */
export function fuseBoneLengths(byBoneByView) {
  const out = {};
  for (const [name, views] of Object.entries(byBoneByView)) {
    let best = null;
    for (const samples of Object.values(views)) {
      const length = robustLength(samples);
      if (length !== null && (best === null || length > best)) best = length;
    }
    if (best !== null) out[name] = Number(best.toFixed(5));
  }
  return out;
}

/**
 * How far the hips stand above the ground, along gravity.
 *
 * World landmarks are re-centred on the hips every frame, so there is no fixed
 * ground plane to store — but the distance from the hips to the lowest foot,
 * measured along the true vertical rather than along the image's, is a real
 * per-user constant and is what a ground plane is for here.
 */
export function hipHeightAboveGround(world, gravity) {
  const down = v3.unit(gravity);
  if (v3.len(down) < 0.5) return null;
  const drop = (name) => v3.dot(world[LM[name]], down);
  return Math.max(drop("left_ankle"), drop("right_ankle"));
}

// ─────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────
export const STORAGE_KEY = "yoga.calibration";
export const CALIBRATION_VERSION = 1;

export function loadCalibration(storage) {
  try {
    const raw = (storage || localStorage).getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== CALIBRATION_VERSION) return null;
    if (!parsed.bones || !Object.keys(parsed.bones).length) return null;
    return parsed;
  } catch {
    return null;     // unavailable, or written by a version that is not this one
  }
}

export function saveCalibration(value, storage) {
  try {
    (storage || localStorage).setItem(STORAGE_KEY, JSON.stringify({
      ...value, version: CALIBRATION_VERSION, at: Date.now(),
    }));
    return true;
  } catch {
    return false;    // a session's worth of calibration, rather than none
  }
}

export function clearCalibration(storage) {
  try { (storage || localStorage).removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────
// The routine
// ─────────────────────────────────────────────────────────────

// Stillness required per view.
//
// Chosen from the reproducibility requirement rather than from feel. Repeat
// calibrations of the same body have to agree within 2% for anything
// downstream to lean on them, and the forearm — the shortest bone, so the worst
// signal against a fixed landmark noise — is what sets the bar: across ten
// noise seeds it spreads 2.2% at two seconds and 2.0% at two and a half. Any
// longer and people start skipping it.
export const HOLD_MS = 2500;

// Drift above this, measured from where the hold began rather than from the
// previous frame, means the user is still getting into position.
//
// Frame to frame is the obvious measure and it does not work. The landmarks
// arriving here are already One Euro smoothed, and that filter is at its
// heaviest exactly when the body is moving slowly — so a body held still moves
// 0.005 m per frame and a body turning at 45°/s moves 0.006 m, which is not a
// signal.
//
// Measured against the start of the hold it is. Across twenty noise seeds, a
// body held still drifts at most 0.027 m over two seconds and a body turning at
// 45°/s drifts at least 0.180 m. 0.06 sits between them with room on both
// sides.
export const STILL_LIMIT = 0.06;      // metres of mean drift from the anchor

// Nothing is judged until the smoothing has settled.
//
// This is not defensive padding — without it the threshold above does not work.
// A One Euro filter starts from its first sample and converges over roughly
// half a second, and that convergence looks exactly like drift: anchored on
// frame zero, a still body's drift ranges 0.036–0.070 m across seeds, which
// straddles any threshold you could pick. Anchored half a second in, the same
// body ranges 0.017–0.027 m. The separation is entirely in the warm-up.
export const WARMUP_MS = 500;

// The second view has to be genuinely side-on for the fusion to be worth
// anything — that is the entire reason for asking. 50° matches the threshold
// the app already uses to decide a body is side-on rather than square.
export const TURN_REQUIRED_DEGREES = 50;

export const STEPS = ["front", "turn", "side", "done"];

/**
 * Walks the user through the two views and accumulates the evidence.
 *
 * Time and observations are passed in, so the whole routine runs in a test
 * without a camera.
 */
export class CalibrationRun {
  constructor({ holdMs = HOLD_MS, warmupMs = WARMUP_MS } = {}) {
    this.holdMs = holdMs;
    this.warmupMs = warmupMs;
    this.reset();
  }

  reset() {
    this.step = "front";
    this.heldSince = null;
    this.samples = {};             // bone → view → observations
    this.anchor = null;            // where the body was when this hold began
    this.progress = 0;
    this.hipHeight = null;
    this.startedAt = null;
  }

  get done() { return this.step === "done"; }

  /** Mean per-landmark drift from where this hold started, in metres. */
  driftFromAnchor(world) {
    if (!this.anchor) return 0;
    let total = 0, n = 0;
    for (const name of Object.keys(LM)) {
      total += v3.len(v3.sub(world[LM[name]], this.anchor[LM[name]]));
      n++;
    }
    return n ? total / n : 0;
  }

  collect(world, frame, reliable, view) {
    for (const [name, segments] of Object.entries(BONES)) {
      for (const segment of segments) {
        if (reliable && !bonePrerequisites(segment).every(p => reliable.has(p))) continue;
        const seen = observeBone(world, frame, segment);
        if (!seen) continue;
        const views = this.samples[name] || (this.samples[name] = {});
        (views[view] || (views[view] = [])).push(seen);
      }
    }
  }

  /**
   * One frame. Returns { step, progress, done, result, still }.
   *
   * `result` appears exactly once, on the frame the routine completes.
   */
  update({ world, reliable, frame, gravity, now }) {
    if (this.step === "done") {
      return { step: "done", progress: 1, done: true, result: null, still: true };
    }
    if (!world) {
      this.heldSince = null;
      return { step: this.step, progress: 0, done: false, result: null, still: false };
    }

    if (this.startedAt === null) this.startedAt = now;
    if (now - this.startedAt < this.warmupMs) {
      // Still settling. Watching during this would be watching the filter, not
      // the body.
      return { step: this.step, progress: 0, done: false, result: null, still: false };
    }

    const bodyFrameNow = frame || bodyFrame(world);
    const still = this.driftFromAnchor(world) < STILL_LIMIT;

    // The turn step is a prompt, not a measurement: it ends when the body has
    // actually turned, and only then does the second view start collecting.
    if (this.step === "turn") {
      if (bodyFrameNow.turnDegrees >= TURN_REQUIRED_DEGREES) {
        this.step = "side";
        this.heldSince = null;
        this.anchor = null;
      }
      this.progress = Math.min(1, bodyFrameNow.turnDegrees / TURN_REQUIRED_DEGREES);
      return { step: "turn", progress: this.progress, done: false, result: null, still };
    }

    if (!still) {
      // Drifted out of position: start the hold again from here.
      this.heldSince = null;
      this.anchor = null;
      this.progress = 0;
      return { step: this.step, progress: 0, done: false, result: null, still: false };
    }

    if (this.heldSince === null) { this.heldSince = now; this.anchor = world; }
    this.collect(world, bodyFrameNow, reliable, this.step);
    if (gravity && this.step === "front") {
      const height = hipHeightAboveGround(world, gravity);
      if (height !== null) this.hipHeight = height;
    }

    this.progress = Math.min(1, (now - this.heldSince) / this.holdMs);
    if (this.progress < 1) {
      return { step: this.step, progress: this.progress, done: false, result: null, still };
    }

    if (this.step === "front") {
      this.step = "turn";
      this.heldSince = null;
      this.anchor = null;
      this.progress = 0;
      return { step: "turn", progress: 0, done: false, result: null, still };
    }

    this.step = "done";
    return {
      step: "done", progress: 1, done: true, still,
      result: {
        bones: fuseBoneLengths(this.samples),
        hipHeight: this.hipHeight,
      },
    };
  }
}

/**
 * Bone lengths as proportions of the torso.
 *
 * The app draws its target outline in pixels and has no idea how far away the
 * user is standing, so the absolute metres are not directly usable — but the
 * ratios are, and they are the part that a single foreshortened view gets
 * wrong. Scaling these by an observed torso length gives a figure whose
 * proportions stop breathing as limbs turn toward the camera.
 */
export function proportionsOf(bones) {
  if (!bones || !(bones.torso > 0)) return null;
  const out = {};
  for (const [name, length] of Object.entries(bones)) out[name] = length / bones.torso;
  return out;
}
