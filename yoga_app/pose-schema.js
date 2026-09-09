/**
 * The pose schema: what a pose definition may contain, what it must contain,
 * and how the scoring targets are worked out from it.
 *
 * See docs/ADDING_A_POSE.md for the authoring guide. This file is the authority
 * on the format — if the two ever disagree, this one is right.
 *
 * The important property is that a pose describes its shape exactly **once**,
 * as a rig of segment directions. The eight target joint angles are computed
 * from that rig, not written alongside it. They used to be written alongside
 * it, and a check showed every one of them was the derived value rounded to a
 * whole degree: forty numbers carrying no information, all of them free to
 * drift away from the shape they were supposed to describe.
 */

import {
  ANGLE_JOINTS, buildReference, computeAngles, figureLandmarks,
} from "./pose-core.js";

export const JOINT_NAMES = Object.keys(ANGLE_JOINTS);
export const LIMBS = ["arm_left", "arm_right", "leg_left", "leg_right"];
export const LIMB_SEGMENTS = { arm: ["upper", "fore"], leg: ["thigh", "shin"] };
export const FOCUS_PARTS = ["torso", "head", "left_arm", "right_arm", "left_leg", "right_leg"];

/**
 * Which way the user has to stand for the pose to be measurable.
 *
 *   front  the pose lives in the frontal plane — the camera sees its shape
 *   side   the pose lives in the sagittal plane, so the user must turn side-on
 *
 * This is not decoration. A single camera resolves the plane it faces and
 * guesses at depth, so a Downward Dog shot head-on is a body pointing straight
 * at the lens and there is nothing in the image to measure. Same pose, side-on,
 * is completely legible. The app uses this to tell the user which way to stand.
 */
export const VIEWS = ["front", "side"];

export const DEFAULT_TOLERANCE = 25;
export const DEFAULT_WEIGHT = 1;

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
const isDirection = (v) =>
  isFiniteNumber(v) ||
  (Array.isArray(v) && v.length === 2 && v.every(isFiniteNumber));

/** The eight target angles this rig implies, in degrees. */
export function deriveTargets(rig, view) {
  return computeAngles(figureLandmarks(buildReference(rig, null, view)), null, 1, 1);
}

/**
 * Everything wrong with a pose definition, as sentences someone can act on.
 * Empty means it is sound.
 */
export function validatePose(key, pose) {
  const problems = [];
  const at = (field) => `${key}.${field}`;
  const bad = (field, message) => problems.push(`${at(field)} ${message}`);

  if (!pose || typeof pose !== "object") return [`${key} is not a pose definition`];

  for (const field of ["name", "sanskrit", "emoji", "description"]) {
    if (typeof pose[field] !== "string" || !pose[field].trim()) {
      bad(field, "must be a non-empty string");
    }
  }

  if (pose.view !== undefined && !VIEWS.includes(pose.view)) {
    bad("view", `must be one of ${VIEWS.join(", ")} (default "front")`);
  }

  // Sidedness: a pose is either the same on both sides or written for one of
  // them. Saying both, or neither, leaves mirroring with nothing to go on.
  const symmetric = pose.symmetric === true;
  const sided = pose.side === "left" || pose.side === "right";
  if (symmetric && sided) bad("side", 'cannot be set on a pose marked symmetric');
  if (!symmetric && !sided) {
    problems.push(`${key} must set either symmetric: true or side: "left" | "right"`);
  }

  // ── steps ──
  if (!Array.isArray(pose.steps) || pose.steps.length === 0) {
    bad("steps", "must be a non-empty array");
  } else {
    pose.steps.forEach((step, i) => {
      if (!step || typeof step.text !== "string" || !step.text.trim()) {
        bad(`steps[${i}].text`, "must be a non-empty string");
      }
      if (step && step.focus !== undefined) {
        if (!Array.isArray(step.focus)) {
          bad(`steps[${i}].focus`, "must be an array of body parts");
        } else {
          for (const part of step.focus) {
            if (!FOCUS_PARTS.includes(part)) {
              bad(`steps[${i}].focus`, `has unknown body part "${part}" — expected one of ${FOCUS_PARTS.join(", ")}`);
            }
          }
        }
      }
    });
  }

  // ── tips ──
  if (!Array.isArray(pose.tips)) {
    bad("tips", "must be an array");
  } else {
    pose.tips.forEach((tip, i) => {
      if (!tip || typeof tip.text !== "string" || !tip.text.trim()) {
        bad(`tips[${i}].text`, "must be a non-empty string");
      }
      if (!tip || typeof tip.icon !== "string") bad(`tips[${i}].icon`, "must be a string");
    });
  }

  // ── rig ──
  const rig = pose.rig;
  if (!rig || typeof rig !== "object") {
    bad("rig", "must be an object");
  } else {
    if (!isDirection(rig.torso)) {
      bad("rig.torso", "must be a direction: theta, or [theta, phi]");
    }
    for (const limb of LIMBS) {
      const segments = LIMB_SEGMENTS[limb.startsWith("arm") ? "arm" : "leg"];
      const value = rig[limb];
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        bad(`rig.${limb}`, `must be an object with ${segments.join(" and ")}`);
        continue;
      }
      for (const segment of segments) {
        if (!isDirection(value[segment])) {
          bad(`rig.${limb}.${segment}`, "must be a direction: theta, or [theta, phi]");
        }
      }
      for (const extra of Object.keys(value)) {
        if (!segments.includes(extra)) {
          bad(`rig.${limb}`, `has unknown segment "${extra}" — expected ${segments.join(" and ")}`);
        }
      }
    }
    for (const extra of Object.keys(rig)) {
      if (extra !== "torso" && !LIMBS.includes(extra)) {
        bad("rig", `has unknown limb "${extra}"`);
      }
    }
  }

  // ── joints ──
  if (pose.joints !== undefined) {
    if (typeof pose.joints !== "object" || pose.joints === null) {
      bad("joints", "must be an object");
    } else {
      for (const [name, spec] of Object.entries(pose.joints)) {
        if (name !== "default" && !JOINT_NAMES.includes(name)) {
          bad("joints", `has unknown joint "${name}" — expected one of ${JOINT_NAMES.join(", ")}`);
          continue;
        }
        if (!spec || typeof spec !== "object") {
          bad(`joints.${name}`, "must be an object with tolerance and/or weight");
          continue;
        }
        if (spec.tolerance !== undefined &&
            (!isFiniteNumber(spec.tolerance) || spec.tolerance <= 0 || spec.tolerance > 90)) {
          bad(`joints.${name}.tolerance`, "must be a number of degrees between 0 and 90");
        }
        if (spec.weight !== undefined && (!isFiniteNumber(spec.weight) || spec.weight < 0)) {
          bad(`joints.${name}.weight`, "must be a number of 0 or more");
        }
        for (const extra of Object.keys(spec)) {
          if (extra !== "tolerance" && extra !== "weight") {
            bad(`joints.${name}`, `has unknown field "${extra}"`);
          }
        }
      }
    }
  }

  // ── the shape the rig actually produces ──
  // A rig can be well-formed and still describe nothing: a limb folded exactly
  // onto itself, a direction of NaN. Building it is the only way to find out.
  if (!problems.length) {
    let targets;
    try {
      targets = deriveTargets(pose.rig, pose.view);
    } catch (err) {
      bad("rig", `cannot be built into a figure: ${err.message}`);
      return problems;
    }
    for (const [joint, degrees] of Object.entries(targets)) {
      if (!Number.isFinite(degrees) || degrees < 0 || degrees > 180) {
        bad("rig", `produces an impossible ${joint} of ${degrees}°`);
      }
    }
  }

  return problems;
}

/** A validated definition, with its targets worked out and defaults filled in. */
export function compilePose(key, pose) {
  const view = pose.view || "front";
  const targets = deriveTargets(pose.rig, view);
  const specs = pose.joints || {};
  const fallback = specs.default || {};

  const angles = {};
  const weights = {};
  for (const joint of JOINT_NAMES) {
    const spec = specs[joint] || {};
    const tolerance = spec.tolerance ?? fallback.tolerance ?? DEFAULT_TOLERANCE;
    angles[joint] = [targets[joint], tolerance];
    weights[joint] = spec.weight ?? fallback.weight ?? DEFAULT_WEIGHT;
  }

  return { ...pose, key, view, angles, weights };
}

/**
 * Compile every pose, or refuse to start.
 *
 * A malformed pose is not something to work around at runtime: a rig with a
 * missing segment silently becomes a figure with a limb at the origin, scores
 * the user against it, and tells them to move. Better to fail here, loudly,
 * with the file and the field named.
 */
export function compileAll(poses) {
  const problems = [];
  for (const [key, pose] of Object.entries(poses)) {
    problems.push(...validatePose(key, pose));
  }
  if (problems.length) {
    throw new Error(
      `poses.js has ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n  · ` +
      problems.join("\n  · "));
  }

  const out = {};
  for (const [key, pose] of Object.entries(poses)) out[key] = compilePose(key, pose);
  return out;
}
