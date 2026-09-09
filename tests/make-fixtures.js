/**
 * Fixture generator.
 *
 * ── What these fixtures are, and what they are not ──────────────────────────
 *
 * They are SYNTHETIC. There is no camera in this toolchain, so every fixture is
 * built by posing the rig from poses.js and reading the joints back out. That
 * makes them exact, deterministic and diffable, and it means they pin down the
 * behaviour of *our* code precisely.
 *
 * It also means they contain none of MediaPipe's own error. A synthetic body is
 * a body the landmarker got perfectly right. So these fixtures can prove that
 * the scoring math does what we think it does; they cannot prove the app works
 * on a real person, and no amount of them ever will.
 *
 * The one place we deliberately model a real failure is the `edgeOn` variant:
 * a rigid rotation alone would change no 3D angle at all (the math is already
 * rotation-invariant), so it also compresses the depth axis, which is the
 * characteristic error of a monocular depth regressor looking at a body turned
 * away from it. The compression factor is a stand-in, not a measurement.
 *
 * Run via tests/make-fixtures.sh.
 */

import { LM, buildReference } from "../yoga_app/pose-core.js";
import { YOGA_POSES, CORRECTION_TIPS } from "../yoga_app/poses.js";

// Rig units → metres. The rig's torso is 0.26 long; a real shoulder-to-hip span
// is around half a metre. Angles are scale-invariant, so this only makes the
// numbers look like the metric world landmarks they stand in for.
const WORLD_SCALE = 1.9;

// How far off-axis the `edgeOn` variant stands, and how much of the depth axis
// a monocular regressor loses at that angle.
const EDGE_ON_DEGREES = 80;
const DEPTH_COMPRESSION = 0.4;

// Each pose's straight-leg fault: bend the shin away from the thigh, which
// changes that knee's angle and nothing else — the hip angle is measured from
// shoulder-hip-knee and never touches the ankle.
const SHIN_BEND_DEGREES = -45;
const FAULTS = {
  mountain: { side: "left" },
  warrior1: { side: "right" },   // the straight back leg
  warrior2: { side: "right" },   // the straight back leg
  tree:     { side: "left" },    // the standing leg
  triangle: { side: "left" },
};

const NAMES = Object.keys(LM);
const NUM_LANDMARKS = 33;
const r5 = (n) => Math.round(n * 1e5) / 1e5;

const hipCentre = (P) => ({
  x: (P.left_hip.x + P.right_hip.x) / 2,
  y: (P.left_hip.y + P.right_hip.y) / 2,
  z: (P.left_hip.z + P.right_hip.z) / 2,
});

/** Rotate a figure about the vertical axis through its hips. +deg turns away. */
function rotateAboutSpine(P, deg) {
  const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  const hip = hipCentre(P);
  const out = {};
  for (const [name, p] of Object.entries(P)) {
    const dx = p.x - hip.x, dz = (p.z || 0) - hip.z;
    out[name] = { x: hip.x + dx * c + dz * s, y: p.y, z: hip.z - dx * s + dz * c };
  }
  return out;
}

/** Squash the depth axis toward the hip plane. Models monocular depth loss. */
function compressDepth(P, factor) {
  const hip = hipCentre(P);
  const out = {};
  for (const [name, p] of Object.entries(P)) {
    out[name] = { x: p.x, y: p.y, z: hip.z + ((p.z || 0) - hip.z) * factor };
  }
  return out;
}

/**
 * World landmarks: metres, origin at the hip midpoint, y down, +z away from
 * the camera — MediaPipe's convention, which is also the rig's.
 */
function worldLandmarks(P, visibilityOf) {
  const hip = hipCentre(P);
  const arr = Array.from({ length: NUM_LANDMARKS }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
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
function imageLandmarks(P, visibilityOf, displace) {
  const hip = hipCentre(P);
  const arr = Array.from({ length: NUM_LANDMARKS }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  for (const name of NAMES) {
    const p = displace ? displace(name, P[name]) : P[name];
    arr[LM[name]] = {
      x: r5(p.x),
      y: r5(p.y),
      z: r5((p.z || 0) - hip.z),
      visibility: visibilityOf(name),
    };
  }
  return arr;
}

const allVisible = () => 1;

function variant(P, note, opts = {}) {
  return {
    note,
    ...(opts.meta || {}),
    image: imageLandmarks(P, opts.visibilityOf || allVisible, opts.displace),
    world: worldLandmarks(P, opts.visibilityOf || allVisible),
  };
}

/** A deep-enough copy of a rig to bend one segment in. */
const cloneRig = (rig) => JSON.parse(JSON.stringify(rig));

function build(key) {
  const pose = YOGA_POSES[key];
  const correct = buildReference(pose.rig);

  // ── fault: one straight leg's shin bent away from its thigh ──
  const side = FAULTS[key].side;
  const faultRig = cloneRig(pose.rig);
  const leg = faultRig[`leg_${side}`];
  faultRig[`leg_${side}`] = [leg[0], leg[1] + SHIN_BEND_DEGREES];
  const faulted = buildReference(faultRig);
  const faultJoint = `${side}_knee`;

  // ── partial: correct pose, lower body below the bottom of the frame ──
  const lowerBody = new Set([
    "left_knee", "right_knee", "left_ankle", "right_ankle",
  ]);
  const partialVis = (name) => (lowerBody.has(name) ? 0.25 : 1);
  const partialDisplace = (name, p) => (lowerBody.has(name) ? { ...p, y: 1.1 } : p);

  return {
    pose: key,
    name: pose.name,
    generated: "synthetic — tests/make-fixtures.js; see the header there",
    variants: {
      correct: variant(correct,
        "The rig held exactly. Every joint should sit on its target."),

      fault: variant(faulted,
        `Correct except the ${side} shin, bent ${-SHIN_BEND_DEGREES}° away from its thigh.`,
        { meta: {
            fault: {
              joint: faultJoint,
              // Bending shortens the knee angle, so the actual falls below the
              // target and the "too small" phrasing is the one that should fire.
              expectCorrection: CORRECTION_TIPS[faultJoint][0],
            },
        } }),

      edgeOn: variant(
        compressDepth(rotateAboutSpine(correct, EDGE_ON_DEGREES), DEPTH_COMPRESSION),
        `Correct, but turned ${EDGE_ON_DEGREES}° off-axis with the depth axis ` +
        `compressed to ${DEPTH_COMPRESSION}× — a model of what a monocular ` +
        `landmarker loses on a body edge-on to the camera.`,
        { meta: { turnedDegrees: EDGE_ON_DEGREES, depthCompression: DEPTH_COMPRESSION } }),

      partial: variant(correct,
        "Correct, but knees and ankles are below the frame and barely visible.",
        { visibilityOf: partialVis,
          displace: partialDisplace,
          meta: { offFrame: [...lowerBody] } }),
    },
  };
}

const out = {};
for (const key of Object.keys(YOGA_POSES)) out[key] = build(key);
print(JSON.stringify(out));
