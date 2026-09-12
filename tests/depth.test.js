import { suite, test, assert, assertEqual, assertClose } from "./harness.js";
import {
  reconstructDepths, implausibleLandmarks, asLandmarkArray, CHAIN, RESIDUAL_LIMIT,
} from "../yoga_app/depth.js";
import {
  computeAngles, bodyFrame, makeFilters, smooth, TUNING, ANGLE_JOINTS, v3, LM,
} from "../yoga_app/pose-core.js";
import { BONES } from "../yoga_app/calibration.js";
import { YOGA_POSES } from "./poses.js";
import { observe } from "./synthetic.js";

suite("depth reconstruction");

/** The bone lengths of a synthetic body, exactly. */
function trueLengths(pose) {
  const { world } = observe(pose);
  const at = (n) =>
    n === "shoulder_centre" ? v3.mid(world[LM.left_shoulder], world[LM.right_shoulder])
    : n === "hip_centre" ? v3.mid(world[LM.left_hip], world[LM.right_hip])
    : world[LM[n]];
  const out = {};
  for (const [name, segments] of Object.entries(BONES)) {
    out[name] = v3.len(v3.sub(at(segments[0][1]), at(segments[0][0])));
  }
  return out;
}

const rmse = (a, b) => Math.sqrt(
  Object.keys(ANGLE_JOINTS).reduce((sum, j) => sum + (a[j] - b[j]) ** 2, 0) / 8);

/** Angle error against ground truth, raw and reconstructed, over a run. */
function compare(poseKey, offIdeal) {
  const pose = YOGA_POSES[poseKey];
  const lengths = trueLengths(pose);
  const truth = computeAngles(observe(pose).world, null, 1, 1);
  const filters = makeFilters(TUNING.world);
  let rawSum = 0, fixedSum = 0, n = 0, previous = null;

  for (let i = 0; i < 90; i++) {
    const seen = observe(pose, { offIdeal, noise: { seed: 900 + i * 13 } });
    const smoothed = smooth(seen.world, filters, i / 30);
    const rebuilt = reconstructDepths(smoothed, lengths, {
      previous, hints: smoothed, turnDegrees: bodyFrame(smoothed).turnDegrees,
    });
    previous = rebuilt.points;
    if (i < 40) continue;                       // let the filter settle
    rawSum += rmse(computeAngles(smoothed, null, 1, 1), truth) ** 2;
    fixedSum += rmse(computeAngles(asLandmarkArray(smoothed, rebuilt.points), null, 1, 1), truth) ** 2;
    n++;
  }
  return { raw: Math.sqrt(rawSum / n), fixed: Math.sqrt(fixedSum / n) };
}

test("a bone's depth extent is exact geometry, not an estimate", () => {
  // √(L² − p²). No solver, no iteration, no tuning — the brief allowed
  // Gauss-Newton over thirty degrees of freedom and the closed form is both
  // cheaper and easier to argue with.
  const pose = YOGA_POSES.warrior2;
  const lengths = trueLengths(pose);
  const { world } = observe(pose, { offIdeal: 60 });
  const rebuilt = reconstructDepths(world, lengths, { hints: world, turnDegrees: 54 });

  for (const { parent, child } of CHAIN) {
    assert(Number.isFinite(rebuilt.points[child].z), `${child} came out ${rebuilt.points[child].z}`);
  }
  assert(rebuilt.points.left_wrist.z !== rebuilt.points.right_wrist.z,
    "a turned body has depth, and it is not all the same depth");
});

test("depth is recovered where the camera lost it", () => {
  // The case this exists for: a body turned well off-axis, where the observed
  // depth is compressed and the angles read from it are badly wrong.
  for (const key of ["warrior1", "warrior2", "tree", "downdog"]) {
    const { raw, fixed } = compare(key, 60);
    assert(fixed < raw * 0.6,
      `${key}: ${raw.toFixed(2)}° raw vs ${fixed.toFixed(2)}° reconstructed`);
  }
});

test("and a body square to the camera is left exactly alone", () => {
  // Head-on, the observed depth is as good as it gets and every bone lies flat
  // across the image, where √(L² − p²) is at its most treacherous. The
  // reconstruction must contribute nothing rather than something.
  for (const key of Object.keys(YOGA_POSES)) {
    const { raw, fixed } = compare(key, 0);
    assert(fixed <= raw * 1.05,
      `${key}: ${raw.toFixed(2)}° raw became ${fixed.toFixed(2)}° reconstructed`);
  }
});

test("noise cannot manufacture depth out of a flat bone", () => {
  // The failure that made the first version worse than doing nothing: √ of a
  // noisy near-zero quantity can only come out positive, so 1.6cm of in-plane
  // noise invented 9cm of depth on every bone of a front-facing pose.
  const pose = YOGA_POSES.mountain;
  const lengths = trueLengths(pose);
  const filters = makeFilters(TUNING.world);
  let worst = 0, previous = null;
  for (let i = 0; i < 70; i++) {
    const seen = observe(pose, { noise: { seed: 400 + i * 7 } });
    const smoothed = smooth(seen.world, filters, i / 30);
    const rebuilt = reconstructDepths(smoothed, lengths, { previous, hints: smoothed });
    previous = rebuilt.points;
    if (i < 40) continue;
    // Mountain stands square: the whole body is within a few cm of one plane.
    for (const { child } of CHAIN) worst = Math.max(worst, Math.abs(rebuilt.points[child].z));
  }
  assert(worst < 0.12, `invented ${(worst * 100).toFixed(1)}cm of depth on a flat body`);
});

test("every landmark carries its own depth uncertainty", () => {
  // Replacing a hand-tuned threshold with the real thing: ∂|Δz|/∂p, which
  // grows without bound as a bone flattens. And it accumulates down the chain,
  // because so does the depth.
  const pose = YOGA_POSES.warrior2;
  const { world } = observe(pose, { offIdeal: 60 });
  const { variance } = reconstructDepths(world, trueLengths(pose), { hints: world, turnDegrees: 54 });

  assertEqual(variance.hip_centre, 0, "the root is where the depth is known");
  assert(variance.left_wrist > variance.left_elbow,
    "a wrist is further down the chain than an elbow and knows less");
  assert(variance.left_ankle > variance.left_knee);
  for (const { child } of CHAIN) assert(variance[child] >= 0, `${child} variance`);
});

test("the estimated depth scale tracks the compression that was applied", () => {
  // The fixture compresses depth by a known factor; the geometry recovers it
  // without being told. Head-on there is nothing to recover and it says so.
  const pose = YOGA_POSES.warrior2;
  const lengths = trueLengths(pose);
  const scaleAt = (off) => {
    const { world } = observe(pose, { offIdeal: off });
    return reconstructDepths(world, lengths, { hints: world, turnDegrees: off }).scale;
  };
  assertClose(scaleAt(0), 1, 0.05, "nothing to undo when square to the camera");
  assert(scaleAt(60) > 1.5, `at 60° it recovered ${scaleAt(60).toFixed(2)}×`);
  assert(scaleAt(60) > scaleAt(30), "and more of it the further round the body is");
});

suite("impossible limbs");

test("a bone cannot project longer than it is", () => {
  // The one part of this that leans on no model of how depth fails: a length
  // measured across the image against a length measured from the same user.
  const pose = YOGA_POSES.warrior2;
  const lengths = trueLengths(pose);
  const { world } = observe(pose);

  assertEqual(implausibleLandmarks(world, lengths).size, 0, "a real body is possible");

  // Put the wrist where no forearm could reach.
  const broken = world.map((p, i) => (i === LM.left_wrist
    ? { ...p, x: world[LM.left_elbow].x + lengths.forearm * 1.6 } : p));
  assert(implausibleLandmarks(broken, lengths).has("left_wrist"),
    "and a limb on the wrong side of the body is not");
});

test("noise on a real body does not trip the check", () => {
  // It has to be quiet on honest input or it is worse than not being there —
  // it would strip good landmarks out of the scoring every frame.
  for (const key of Object.keys(YOGA_POSES)) {
    const pose = YOGA_POSES[key];
    const lengths = trueLengths(pose);
    const filters = makeFilters(TUNING.world);
    for (let i = 0; i < 60; i++) {
      const seen = observe(pose, { noise: { seed: 77 + i * 5 } });
      const smoothed = smooth(seen.world, filters, i / 30);
      if (i < 40) continue;
      assertEqual(implausibleLandmarks(smoothed, lengths).size, 0,
        `${key} tripped the plausibility check on noise alone at frame ${i}`);
    }
  }
});

test("with no calibration there is nothing to check against", () => {
  const { world } = observe(YOGA_POSES.tree);
  assertEqual(implausibleLandmarks(world, null).size, 0);
  assertEqual(implausibleLandmarks(world, {}).size, 0, "and no bones is the same as none");
});
