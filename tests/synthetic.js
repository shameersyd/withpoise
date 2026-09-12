/**
 * Building synthetic bodies, and posing them into known faults.
 *
 * ── What these are, and what they are not ───────────────────────────────────
 *
 * Every body here is SYNTHETIC: built by posing the rig from poses.js and
 * reading the joints back out. That makes them exact, deterministic and
 * diffable, and it means they pin down the behaviour of *our* code precisely.
 *
 * It also means they contain none of MediaPipe's own error. A synthetic body is
 * a body the landmarker got perfectly right. These can prove the scoring math
 * does what we intend; they cannot prove the app works on a real person, and no
 * number of them ever will. Labelled real recordings remain the most valuable
 * outstanding work on this project — see docs/LIMITS.md §4.
 *
 * They are adequate for the specific job they are used for here, though, and
 * it is worth saying why: the faults below are *geometric*. A body rotated 30°
 * about a named axis is exactly labelled by construction. There is no
 * annotation uncertainty to worry about because there is no annotation.
 */

import { LM, buildReference, v3 } from "../yoga_app/pose-core.js";

// Rig units → metres. The rig's torso is 0.26 long; a real shoulder-to-hip span
// is around half a metre. Angles are scale-invariant, so this only makes the
// numbers look like the metric world landmarks they stand in for.
export const WORLD_SCALE = 1.9;

export const EDGE_ON_DEGREES = 80;
export const DEPTH_COMPRESSION = 0.4;

// Depth loss depends on the angle to the *camera*, since that is physics rather
// than choreography: a body square to the lens gives the landmarker plenty to
// work with, a body edge-on gives it almost nothing.
export const compressionAt = (turnFromCamera) =>
  1 - (1 - DEPTH_COMPRESSION) *
      Math.min(1, Math.sin(turnFromCamera * Math.PI / 180) /
                  Math.sin(EDGE_ON_DEGREES * Math.PI / 180));

// buildReference already stands a side-view pose side-on to the camera.
export const idealTurn = (view) => (view === "side" ? 90 : 0);

export const NAMES = Object.keys(LM);
export const NUM_LANDMARKS = 33;

const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: (a.z ?? 0) + (b.z ?? 0) });
export const hipCentre = (P) => v3.mid(P.left_hip, P.right_hip);

// ─────────────────────────────────────────────────────────────
// Rigid transforms
// ─────────────────────────────────────────────────────────────

/** Rotate a vector about an arbitrary axis through the origin. Rodrigues. */
export function rotateAbout(vec, axis, degrees) {
  const k = v3.unit(axis);
  const t = degrees * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  const kxv = v3.cross(k, vec);
  const kdv = v3.dot(k, vec) * (1 - c);
  return {
    x: vec.x * c + kxv.x * s + k.x * kdv,
    y: vec.y * c + kxv.y * s + k.y * kdv,
    z: (vec.z ?? 0) * c + kxv.z * s + k.z * kdv,
  };
}

/** Rotate a point about an axis through a pivot. */
const spinPoint = (p, pivot, axis, degrees) =>
  add(pivot, rotateAbout(v3.sub(p, pivot), axis, degrees));

const VERTICAL = { x: 0, y: 1, z: 0 };

/** Rotate a whole figure about the vertical axis through its hips. */
export function rotateAboutSpine(P, degrees) {
  const pivot = hipCentre(P);
  const out = {};
  for (const [name, p] of Object.entries(P)) {
    out[name] = spinPoint(p, pivot, VERTICAL, degrees);
  }
  return out;
}

/** Squash the depth axis toward the hip plane. Models monocular depth loss. */
export function compressDepth(P, factor) {
  const hip = hipCentre(P);
  const out = {};
  for (const [name, p] of Object.entries(P)) {
    out[name] = { x: p.x, y: p.y, z: hip.z + ((p.z || 0) - hip.z) * factor };
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Faults
//
// Each takes a figure and a severity in degrees, and each is chosen to be
// invisible to joint angles — that is the whole point of them. A joint angle is
// invariant to translation, rotation, scale and reflection, so any fault that
// moves a limb without changing the angles between its segments is a fault the
// current scoring cannot express.
// ─────────────────────────────────────────────────────────────

/**
 * Knee valgus: the knee falls inward while the foot stays planted.
 *
 * Rotating the knee about the hip→ankle axis preserves its distance to both
 * ends, because every point on that axis keeps its distance under a rotation
 * about it. So the thigh length, the shin length and the knee angle are all
 * exactly unchanged, and only the direction the knee points moves. It is the
 * single most common fault in a lunge and the one every teacher calls out.
 */
export function valgus(P, side, degrees) {
  const hip = P[`${side}_hip`], knee = P[`${side}_knee`], ankle = P[`${side}_ankle`];
  const axis = v3.sub(ankle, hip);
  if (v3.len(axis) < 1e-9) return { ...P };
  return { ...P, [`${side}_knee`]: spinPoint(knee, hip, axis, degrees) };
}

// The pelvis and everything it carries.
const ABOVE_THE_PELVIS = [
  "nose", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
  "left_wrist", "right_wrist", "left_hip", "right_hip",
];

/**
 * Pelvis yaw: hips and everything above turned away from square, feet planted.
 *
 * Warrior I's own step 5 is "square your hips toward the front of your mat",
 * and it is the instruction everybody breaks. The legs stay where they are,
 * which does stretch the thigh slightly — a real consequence of yawing a pelvis
 * over planted feet, and small next to the thigh at the severities used here.
 */
export function pelvisYaw(P, degrees) {
  const pivot = hipCentre(P);
  const out = { ...P };
  for (const name of ABOVE_THE_PELVIS) {
    out[name] = spinPoint(P[name], pivot, VERTICAL, degrees);
  }
  return out;
}

const LIMBS = {
  arm_left:  { root: "left_shoulder",  moves: ["left_elbow", "left_wrist"] },
  arm_right: { root: "right_shoulder", moves: ["right_elbow", "right_wrist"] },
  leg_left:  { root: "left_hip",       moves: ["left_knee", "left_ankle"] },
  leg_right: { root: "right_hip",      moves: ["right_knee", "right_ankle"] },
};

/**
 * Swing a whole limb about the vertical through its root, torso untouched.
 *
 * Every bone length and every joint angle in the limb survives, because the
 * limb moves as a rigid body. Warrior II with both arms swung 90° forward —
 * pointing ahead instead of out to the sides — is the clearest example there
 * is of a pose that is completely wrong and scores a perfect 100.
 */
export function limbSwing(P, limb, degrees) {
  const spec = LIMBS[limb];
  if (!spec) throw new Error(`unknown limb "${limb}"`);
  const pivot = P[spec.root];
  const out = { ...P };
  for (const name of spec.moves) {
    out[name] = spinPoint(P[name], pivot, VERTICAL, degrees);
  }
  return out;
}

/**
 * Negate depth on every landmark: front and back swapped.
 *
 * The most complete statement of the problem. A reflection preserves every
 * distance and every angle, so a body turned exactly inside out is, to eight
 * joint angles, the same body.
 */
export function depthMirror(P) {
  const out = {};
  for (const [name, p] of Object.entries(P)) out[name] = { ...p, z: -(p.z || 0) };
  return out;
}

export const FAULTS = { valgus, pelvisYaw, limbSwing, depthMirror };

// ─────────────────────────────────────────────────────────────
// Noise
//
// Seeded, so a run is reproducible and two runs are diffable. Without that a
// robustness number is an anecdote.
// ─────────────────────────────────────────────────────────────

/** mulberry32 — small, fast, and good enough to be uncorrelated across axes. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller, one value per call. */
export function gaussian(rand) {
  const u = Math.max(rand(), 1e-12), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Landmark error is not isotropic, and pretending otherwise is the mistake this
// whole brief is about. x and y come from the image and are good; z is
// regressed from a single view and is several times worse. The ratio is what
// matters here rather than the absolute figures — 4× is a deliberately
// conservative reading of "several times larger".
export const NOISE_XY = 0.006;      // rig units; the body is ~0.62 tall
export const NOISE_Z_RATIO = 4;

/** Anisotropic landmark noise, in rig units. */
export function addNoise(P, { seed = 1, xy = NOISE_XY, zRatio = NOISE_Z_RATIO } = {}) {
  const rand = seededRandom(seed);
  const out = {};
  for (const [name, p] of Object.entries(P)) {
    out[name] = {
      x: p.x + gaussian(rand) * xy,
      y: p.y + gaussian(rand) * xy,
      z: (p.z || 0) + gaussian(rand) * xy * zRatio,
    };
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Figures → landmark arrays
// ─────────────────────────────────────────────────────────────

const r5 = (n) => Math.round(n * 1e5) / 1e5;
const allVisible = () => 1;

/**
 * World landmarks: metres, origin at the hip midpoint, y down, +z away from
 * the camera — MediaPipe's convention, which is also the rig's.
 */
export function worldLandmarks(P, visibilityOf = allVisible) {
  const hip = hipCentre(P);
  const arr = Array.from({ length: NUM_LANDMARKS },
    () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  for (const name of NAMES) {
    const p = P[name];
    arr[LM[name]] = {
      x: r5((p.x - hip.x) * WORLD_SCALE),
      y: r5((p.y - hip.y) * WORLD_SCALE),
      z: r5(((p.z || 0) - hip.z) * WORLD_SCALE),
      visibility: visibilityOf(name),
    };
  }
  return arr;
}

/**
 * Image landmarks: x,y normalized over the frame — an orthographic projection
 * of the same figure, which is what a camera far enough away produces — and z
 * a hip-relative depth in roughly the same scale as x.
 */
export function imageLandmarks(P, visibilityOf = allVisible, displace) {
  const hip = hipCentre(P);
  const arr = Array.from({ length: NUM_LANDMARKS },
    () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  for (const name of NAMES) {
    const p = displace ? displace(name, P[name]) : P[name];
    arr[LM[name]] = {
      x: r5(p.x), y: r5(p.y), z: r5((p.z || 0) - hip.z),
      visibility: visibilityOf(name),
    };
  }
  return arr;
}

/**
 * A pose held, optionally faulted, as the app would see it.
 *
 * The depth compression of standing where the pose needs you to stand is part
 * of the observation and is always applied: a front pose loses nothing, and
 * Downward Dog, which is only legible side-on, loses most of its depth axis
 * and still has to score.
 */
export function observe(pose, { fault, noise, offIdeal = 0 } = {}) {
  let P = buildReference(pose.rig, null, pose.view);
  if (fault) P = fault(P);

  const from = idealTurn(pose.view);
  const turnFromCamera = pose.view === "side" ? from - offIdeal : from + offIdeal;
  P = rotateAboutSpine(P, turnFromCamera - from);
  P = compressDepth(P, compressionAt(turnFromCamera));
  if (noise) P = addNoise(P, noise);

  return { figure: P, image: imageLandmarks(P), world: worldLandmarks(P) };
}
