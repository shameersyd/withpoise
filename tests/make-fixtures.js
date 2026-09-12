/**
 * Writes the canonical fixtures: each pose held correctly, held with one known
 * fault, seen from the wrong angle, and seen half out of frame.
 *
 * The bodies themselves — and the geometry that faults them — live in
 * synthetic.js, which explains at length what a synthetic fixture is worth.
 * The spatial faults are deliberately NOT written out here: a severity curve
 * across six poses and four faults is hundreds of landmark arrays that nobody
 * will ever read, and they are reproducible from the rig on demand. See
 * tests/eval.js.
 *
 * Run via tests/make-fixtures.sh.
 */

import { buildReference } from "../yoga_app/pose-core.js";
import { YOGA_POSES, CORRECTION_TIPS } from "./poses.js";
import { validatePose } from "../yoga_app/pose-schema.js";
import {
  compressionAt, idealTurn, rotateAboutSpine, compressDepth,
  worldLandmarks, imageLandmarks, EDGE_ON_DEGREES,
} from "./synthetic.js";

// How far the turned variants stand from the view the pose *needs*, which is
// not the same as how far they stand from the camera. A front pose wants to be
// square to the lens; Downward Dog only exists side-on, so for it these turn
// the body towards the camera rather than away from it.
const TURNED_DEGREES = 30;

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
  downdog:  { side: "left" },
};

const allVisible = () => 1;

function variant(P, note, opts = {}) {
  return {
    note,
    ...(opts.meta || {}),
    image: imageLandmarks(P, opts.visibilityOf || allVisible, opts.displace),
    world: worldLandmarks(P, opts.visibilityOf || allVisible),
  };
}

/** A correctly held pose seen from `off` degrees away from the view it needs. */
function turnedVariant(P, view, off, note) {
  const from = idealTurn(view);
  const turnFromCamera = view === "side" ? from - off : from + off;
  const factor = compressionAt(turnFromCamera);
  return variant(
    compressDepth(rotateAboutSpine(P, turnFromCamera - from), factor),
    `${note} ${turnFromCamera}° from the camera, depth compressed to ${factor.toFixed(2)}×.`,
    { meta: { offIdeal: off, turnFromCamera, depthCompression: Number(factor.toFixed(4)) } });
}

/** A deep-enough copy of a rig to bend one segment in. */
const cloneRig = (rig) => JSON.parse(JSON.stringify(rig));

/** Rotate a direction, whether it carries a phi or not. */
const bend = (direction, degrees) =>
  Array.isArray(direction) ? [direction[0] + degrees, direction[1]] : direction + degrees;

function build(key) {
  const pose = YOGA_POSES[key];
  const correct = buildReference(pose.rig, null, pose.view);

  // ── fault: one straight leg's shin bent away from its thigh ──
  const side = FAULTS[key].side;
  const faultRig = cloneRig(pose.rig);
  const leg = faultRig[`leg_${side}`];
  faultRig[`leg_${side}`] = { ...leg, shin: bend(leg.shin, SHIN_BEND_DEGREES) };

  // The faulted pose goes through the validator like any other. This generator
  // reaches into a rig and changes it, which is exactly the sort of edit that
  // produces a well-shaped object describing nothing — and did, silently, when
  // the rig format changed underneath it.
  const faultPose = { ...pose, rig: faultRig };
  const problems = validatePose(`${key}(faulted)`, faultPose);
  if (problems.length) throw new Error(problems.join("\n"));

  const faulted = buildReference(faultRig, null, pose.view);
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
      // Compressed like any other variant, because the depth loss of standing
      // where a pose needs you to stand is part of the pose. A front pose loses
      // nothing; Downward Dog, which is only legible side-on, loses almost all
      // of its depth axis and still has to score.
      correct: turnedVariant(correct, pose.view, 0,
        "The rig held exactly, in the view this pose needs."),

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

      turned: turnedVariant(correct, pose.view, TURNED_DEGREES,
        `Correct, standing ${TURNED_DEGREES}° off the view this pose needs — ` +
        `which must score the same as standing in it.`),

      edgeOn: turnedVariant(correct, pose.view, EDGE_ON_DEGREES,
        `Correct, but standing ${EDGE_ON_DEGREES}° off the view this pose ` +
        `needs — about as badly as it can be seen.`),

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
