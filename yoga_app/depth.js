/**
 * Reconstructing depth from the coordinates the camera actually measures.
 *
 * The premise, established by measurement across this whole brief: MediaPipe's
 * x and y are good and its z is bad. So stop consuming z as a measurement. Use
 * the 2D observations, which are accurate, together with the bone lengths
 * measured during calibration, which do not change — and let the geometry
 * supply the rest.
 *
 * ── The geometry ───────────────────────────────────────────────────────────
 *
 * A bone of known length L whose endpoints project p apart in the image has a
 * depth extent of exactly
 *
 *     |Δz| = √(L² − p²)
 *
 * There is no estimation in that. The magnitude is free; only the **sign** is
 * ambiguous — the far end is either nearer the camera or further from it, and
 * the projection cannot say which. So the whole problem reduces to picking a
 * sign per bone, which temporal continuity settles almost always and
 * MediaPipe's own z settles the rest of the time. It is a far better use of a
 * bad depth estimate than believing its magnitude.
 *
 * Closed form, no iteration, no solver. The brief allowed Gauss-Newton over
 * thirty degrees of freedom; an exact answer is cheaper and easier to debug
 * than an approximate one.
 *
 * ── What it gives back for free ────────────────────────────────────────────
 *
 * Differentiating the expression above,
 *
 *     ∂|Δz|/∂p = −p / √(L² − p²)
 *
 * which is the per-bone depth uncertainty in closed form. It is a real variance
 * rather than a hand-tuned threshold, and it is what replaces the binary
 * measurability gate.
 *
 * ── Why the reconstruction is not simply used ──────────────────────────────
 *
 * Because measured against ground truth it is, on its own, **worse** than the
 * depth MediaPipe supplies. That derivative is the reason, and it is not a
 * detail: it goes to infinity as p → L. A bone lying flat across the image has
 * p ≈ L and a true depth extent of nearly zero — and 1.6cm of in-plane noise
 * manufactures 9cm of depth out of it. Every bone of a front-facing pose is in
 * that regime. Reconstructed alone, joint angles came out 2–3× further from
 * truth than reading z directly.
 *
 * So the two estimates are **fused by precision**, each weighted by one over
 * its own variance. Where a bone points away from the camera the reconstruction
 * is well-conditioned and dominates; where it lies flat the reconstruction is
 * worthless, its variance says so, and the observed depth carries the frame.
 * Neither estimate is thrown away and neither is trusted past its evidence,
 * which is the only defensible thing to do with two bad measurements of
 * different things.
 *
 * And when p > L the projection is longer than the bone, which cannot happen.
 * Either the calibration is wrong or the landmarks are — and a limb confidently
 * placed on the wrong side of the body is the usual cause. That residual is the
 * sign-flip detector.
 */

import { LM, v3, landmarkPoint } from "./pose-core.js";

/**
 * The skeleton as a tree, rooted at the hips.
 *
 * Depth propagates outward from the root: every child's z is its parent's z
 * plus a reconstructed offset, so an error near the root moves everything
 * beyond it. That is why the torso — measured best, and shortest-chained — is
 * the root, and why the fingers and feet are the least certain things here.
 */
export const CHAIN = [
  { parent: "hip_centre", child: "left_hip", bone: "hipSpan", scale: 0.5 },
  { parent: "hip_centre", child: "right_hip", bone: "hipSpan", scale: 0.5 },
  { parent: "hip_centre", child: "shoulder_centre", bone: "torso", scale: 1 },
  { parent: "shoulder_centre", child: "left_shoulder", bone: "shoulderSpan", scale: 0.5 },
  { parent: "shoulder_centre", child: "right_shoulder", bone: "shoulderSpan", scale: 0.5 },
  { parent: "shoulder_centre", child: "nose", bone: "neck", scale: 1 },
  { parent: "left_shoulder", child: "left_elbow", bone: "upperArm", scale: 1 },
  { parent: "right_shoulder", child: "right_elbow", bone: "upperArm", scale: 1 },
  { parent: "left_elbow", child: "left_wrist", bone: "forearm", scale: 1 },
  { parent: "right_elbow", child: "right_wrist", bone: "forearm", scale: 1 },
  { parent: "left_hip", child: "left_knee", bone: "thigh", scale: 1 },
  { parent: "right_hip", child: "right_knee", bone: "thigh", scale: 1 },
  { parent: "left_knee", child: "left_ankle", bone: "shin", scale: 1 },
  { parent: "right_knee", child: "right_ankle", bone: "shin", scale: 1 },
];

// How much longer than its bone a projection may measure before the
// observation is called impossible rather than merely noisy.
//
// A projection cannot exceed its bone, so any excess is error. 12% is about
// three times the calibration's own reproducibility budget — comfortably past
// what a correctly-measured body produces, and well short of the 30–50% a
// genuinely misplaced limb shows.
export const RESIDUAL_LIMIT = 0.12;

// Below this much depth extent, the sign is not worth arguing about: the bone
// is lying across the image and both answers put its far end within a
// centimetre of the same place.
const SIGN_DEADZONE = 0.01;   // metres

// How much noisier the observed depth is than the observed x and y, after the
// smoothing both have been through. Measured: a shared One Euro tuning leaves z
// jitter at 3.5× x/y and the separate depth tuning brings it to 1.9×. This is
// the number that decides how much the two estimates are each believed.
export const DEPTH_NOISE_RATIO = 1.9;

/**
 * Rebuild every landmark's depth from the image plane and the bone lengths.
 *
 * Two passes, and the second is the important one.
 *
 * **Pass one** asks each bone how much depth it ought to have: √(L² − p²),
 * exact, from a measured projection and a calibrated length. Compared against
 * the depth actually observed, each well-conditioned bone yields a *ratio* —
 * how much the observed depth has been shortened.
 *
 * **Pass two** takes the median of those ratios and applies it to every bone,
 * including the ones that had nothing to say.
 *
 * Correcting bone by bone was the first attempt and it is worse than doing
 * nothing. The bones that can be reconstructed get their depth restored and
 * the ones that cannot keep theirs compressed, and the result is a body that
 * is internally inconsistent — part at full depth, part flattened. Measured,
 * that scored worse than leaving the whole thing flattened, because the joint
 * angles between the corrected and uncorrected halves are now wrong in a way
 * they were not before.
 *
 * A single scale keeps the skeleton coherent. It is also the right model of
 * the error: depth compression is a property of the view, not of the femur.
 */
export function reconstructDepths(world, lengths, { previous = null, hints = null,
                                                    noiseXY = 0.011, turnDegrees = 0 } = {}) {
  const source = hints || world;
  const flatOf = {}, extentOf = {}, observedOf = {};
  const residuals = {};
  const impossible = [];
  const ratios = [];

  const seen = { hip_centre: { x: 0, y: 0, z: 0 } };
  for (const name of Object.keys(LM)) {
    const point = world[LM[name]];
    seen[name] = { x: point.x, y: point.y, z: point.z };
  }
  seen.shoulder_centre = {
    x: (seen.left_shoulder.x + seen.right_shoulder.x) / 2,
    y: (seen.left_shoulder.y + seen.right_shoulder.y) / 2,
    z: (seen.left_shoulder.z + seen.right_shoulder.z) / 2,
  };

  // ── Pass one: what depth should each bone have, and what does it report? ──
  const noiseP = noiseXY * Math.SQRT2;
  for (const { parent, child, bone, scale } of CHAIN) {
    const length = lengths[bone] !== undefined ? lengths[bone] * scale : null;
    const flat = Math.hypot(seen[child].x - seen[parent].x, seen[child].y - seen[parent].y);
    const observed = depthOf(source, child) - depthOf(source, parent);
    flatOf[child] = flat;
    observedOf[child] = observed;

    if (!length || !(length > 0)) { extentOf[child] = null; continue; }

    const overshoot = flat / length - 1;
    residuals[bone] = Math.max(residuals[bone] ?? -Infinity, overshoot);
    if (overshoot > RESIDUAL_LIMIT) impossible.push(child);

    // Noise inflates the reconstructed extent and can only inflate it — √ of a
    // squared quantity cannot come out negative — so its own contribution to p²
    // comes back out. Four terms: two endpoints, two measured axes.
    const usable = Math.max(0, length * length - flat * flat - 4 * noiseXY * noiseXY);
    const extent = Math.sqrt(usable);
    extentOf[child] = extent;

    // Is there more depth here than noise alone could invent? Near p = L the
    // extent is the square root of a noisy near-zero quantity, and below the
    // scale √(2·p·σ_p) it is an estimate of the noise rather than of the body.
    const noiseScale = Math.sqrt(2 * flat * noiseP);
    if (extent > noiseScale && Math.abs(observed) > noiseScale / 2) {
      ratios.push(extent / Math.abs(observed));
    }
  }

  // ── Pass two: each bone believed in proportion to how well it is known ──
  const scale = medianOf(ratios);
  const points = { hip_centre: { x: 0, y: 0, z: 0 } };
  for (const name of Object.keys(LM)) {
    points[name] = { x: seen[name].x, y: seen[name].y, z: 0 };
  }
  points.shoulder_centre = { x: seen.shoulder_centre.x, y: seen.shoulder_centre.y, z: 0 };

  // A monocular depth estimate does not merely get noisier as a body turns away
  // from the lens — it gets systematically short, and a bias is not something
  // averaging fixes. sin(turn) rather than the suite's compression curve on
  // purpose: the direction of the effect is physics, the exact shape of it is a
  // model of one landmarker.
  const turnPenalty = Math.abs(Math.sin(turnDegrees * Math.PI / 180));

  const variance = { hip_centre: 0 };
  for (const { parent, child } of CHAIN) {
    const extent = extentOf[child];
    const observed = observedOf[child];
    const flat = flatOf[child];
    const noiseScale = Math.sqrt(2 * flat * noiseP);

    const informative = extent !== null && extent > noiseScale;
    const reconstructed = informative
      ? chooseSign(child, parent, extent, previous, observedOf) * extent
      : 0;

    const reconVariance = informative ? ((flat / extent) * noiseXY) ** 2 : Infinity;
    const observedVariance = (noiseXY * DEPTH_NOISE_RATIO) ** 2 +
                             (turnPenalty * observed) ** 2;

    const wRecon = Number.isFinite(reconVariance) && reconVariance > 0 ? 1 / reconVariance : 0;
    const wObserved = 1 / observedVariance;

    points[child].z = points[parent].z +
      (reconstructed * wRecon + observed * wObserved) / (wRecon + wObserved);

    // Depth accumulates down the chain, and so does its uncertainty.
    variance[child] = (variance[parent] ?? 0) + 1 / (wRecon + wObserved);
  }

  return { points, variance, residuals, impossible, scale };
}

/** Median, with 1 — no correction — when nothing had anything to say. */
function medianOf(values) {
  if (!values.length) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted[Math.floor(sorted.length / 2)];
  // A body cannot be more than a few times deeper than it looks; anything past
  // that is a broken calibration rather than a compressed view.
  return Math.max(0.5, Math.min(4, middle));
}

const depthOf = (world, name) =>
  name === "hip_centre" ? 0
  : name === "shoulder_centre" ? (world[LM.left_shoulder].z + world[LM.right_shoulder].z) / 2
  : world[LM[name]].z;

/**
 * Which way the far end of this bone leans.
 *
 * Continuity first: bodies do not turn inside out between frames, and a sign
 * that agrees with the last frame is almost always right. MediaPipe's own z
 * decides the first frame and any bone that has just reappeared — its sign is
 * worth far more than its magnitude, which is the whole argument of this file.
 */
function chooseSign(child, parent, extent, previous, observedOf) {
  if (extent < SIGN_DEADZONE) return 1;   // flat to the camera; the sign is moot

  if (previous && previous[child] && previous[parent]) {
    const was = previous[child].z - previous[parent].z;
    if (Math.abs(was) > SIGN_DEADZONE) return Math.sign(was);
  }
  const hinted = observedOf[child];
  if (Math.abs(hinted) > 1e-9) return Math.sign(hinted);
  return 1;
}

/** The rebuilt points as the 33-entry array the rest of the app expects. */
export function asLandmarkArray(world, points) {
  return world.map((seen, index) => {
    const name = Object.keys(LM).find(n => LM[n] === index);
    if (!name || !points[name]) return seen;
    return { ...seen, z: points[name].z };
  });
}

/**
 * Landmarks the calibration says cannot be where they appear to be.
 *
 * A bone's projection cannot be longer than the bone. When it measures longer,
 * something is wrong that averaging will not fix — most often a limb that has
 * been confidently placed on the wrong side of the body, which is worse than a
 * noisy one because it is wrong with conviction and the smoothing will hold it
 * there.
 *
 * This is the one part of the depth work that does not depend on any model of
 * how the depth estimate fails. It compares a measured length in the image
 * plane against a length measured from the same user, and both of those are
 * things this app knows well.
 */
export function implausibleLandmarks(world, lengths, { noiseXY = 0.011 } = {}) {
  const bad = new Set();
  if (!lengths) return bad;

  const seen = { hip_centre: { x: 0, y: 0 } };
  for (const name of Object.keys(LM)) seen[name] = world[LM[name]];
  seen.shoulder_centre = {
    x: (seen.left_shoulder.x + seen.right_shoulder.x) / 2,
    y: (seen.left_shoulder.y + seen.right_shoulder.y) / 2,
  };

  for (const { parent, child, bone, scale } of CHAIN) {
    const length = lengths[bone] !== undefined ? lengths[bone] * scale : null;
    if (!length || !(length > 0)) continue;
    const flat = Math.hypot(seen[child].x - seen[parent].x, seen[child].y - seen[parent].y);
    // The allowance covers the calibration's own 2% reproducibility and the
    // landmark noise on both endpoints; past that it is not measurement error.
    if (flat / length - 1 > RESIDUAL_LIMIT + (2 * noiseXY) / length) bad.add(child);
  }
  return bad;
}
