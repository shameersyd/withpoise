import { suite, test, assert, assertEqual, assertClose } from "./harness.js";
import { makeFilters, smooth, TUNING, LM, v3, bodyFrame, reliableLandmarks }
  from "../yoga_app/pose-core.js";
import {
  CalibrationRun, BONES, observeBone, weightedMedian, robustLength, fuseBoneLengths,
  proportionsOf, loadCalibration, saveCalibration, clearCalibration, HOLD_MS,
  hipHeightAboveGround, STILL_LIMIT, TURN_REQUIRED_DEGREES,
} from "../yoga_app/calibration.js";
import { YOGA_POSES } from "./poses.js";
import { observe, WORLD_SCALE } from "./synthetic.js";

suite("calibration — the pieces");

test("a bone seen end-on measures short, which is why there are two views", () => {
  // Warrior II holds its arms straight out sideways: square to the lens from
  // the front, straight down it from the side. The side view cannot see the
  // arm's length at all, and reports a short one — never a long one, because a
  // projection only ever shortens. That is what makes the larger of the two
  // readings the right answer rather than their average.
  const front = observe(YOGA_POSES.warrior2);
  const arm = observeBone(front.world, bodyFrame(front.world), BONES.upperArm[0]);

  // 80° rather than exactly 90°: a bone precisely along the camera axis has no
  // image-plane extent at all, and observeBone rightly reports nothing rather
  // than a length of zero.
  const sideOn = observe(YOGA_POSES.warrior2, { offIdeal: 80 });
  const sideArm = observeBone(sideOn.world, bodyFrame(sideOn.world), BONES.upperArm[0]);

  assert(sideArm.length < arm.length * 0.6,
    `side-on ${sideArm.length.toFixed(3)} vs front-on ${arm.length.toFixed(3)}`);
  assert(sideArm.share > arm.share, "and it knows it is looking down the bone");
});

test("the median ignores a frame that went badly wrong", () => {
  // A limb briefly confused with the background produces a length wrong by a
  // factor, not a percent. A mean carries that forever; a median does not.
  const good = Array.from({ length: 20 }, () => ({ length: 0.30, weight: 1 }));
  const disaster = [{ length: 3.0, weight: 1 }, { length: 0.01, weight: 1 }];
  assertClose(weightedMedian([...good, ...disaster]), 0.30, 1e-9);
});

test("a trimmed mean is robust to a bad frame and still averages the good ones", () => {
  // The median survives the disaster but returns one frame's value; the trimmed
  // mean survives it and uses the rest. On a forearm that difference is the
  // whole ±2% reproducibility budget.
  const spread = [0.28, 0.29, 0.30, 0.31, 0.32, 0.30, 0.29, 0.31, 0.30, 0.30]
    .map(length => ({ length, weight: 1 }));
  const withDisaster = [...spread, { length: 3.0, weight: 1 }, { length: 0.01, weight: 1 }];
  assertClose(robustLength(withDisaster), 0.30, 0.01, "outliers trimmed away");
  assert(robustLength(spread) !== spread[0].length, "and it is not just picking one");
});

test("too few samples to trim falls back to the median", () => {
  const few = [{ length: 0.3, weight: 1 }, { length: 0.31, weight: 1 }];
  assert(robustLength(few) > 0, "still produces an answer");
  assertEqual(robustLength([]), null);
});

test("fusion takes the best view, not the average of the views", () => {
  // The foreshortened view is not half right. Averaging it in is simply wrong.
  const fused = fuseBoneLengths({
    thighL: {
      front: Array.from({ length: 10 }, () => ({ length: 0.42, weight: 1 })),
      side: Array.from({ length: 10 }, () => ({ length: 0.26, weight: 1 })),
    },
    thighR: { front: [] },
  });
  assertClose(fused.thighL, 0.42, 1e-4, "the view that could see it wins outright");
  assert(!("thighR" in fused), "an unmeasured bone is absent, not zero");
});

test("proportions are relative to the torso, and refuse a body with none", () => {
  const p = proportionsOf({ torso: 0.5, thighL: 0.4 });
  assertEqual(p.torso, 1);
  assertClose(p.thighL, 0.8, 1e-9);
  assertEqual(proportionsOf({ thighL: 0.4 }), null, "no torso, no proportions");
  assertEqual(proportionsOf(null), null);
});

test("hip height needs a gravity direction worth having", () => {
  const { world } = observe(YOGA_POSES.mountain);
  const upright = hipHeightAboveGround(world, { x: 0, y: 1, z: 0 });
  assert(upright > 0.5 && upright < 1.5, `hips ${upright?.toFixed(2)}m above the floor`);
  assertEqual(hipHeightAboveGround(world, { x: 0, y: 0, z: 0 }), null,
    "a zero gravity vector is not a direction");
});

// ─────────────────────────────────────────────────────────────
suite("calibration — the routine");

/**
 * Drive a whole calibration against a synthetic body, through the same One Euro
 * smoothing the app applies before anything sees a landmark.
 */
function calibrate(poseKey, seed) {
  const pose = YOGA_POSES[poseKey];
  const run = new CalibrationRun();
  const filters = makeFilters(TUNING.world);
  let frame = 0, result = null;

  const feed = (offIdeal) => {
    const { world, image } = observe(pose, { noise: { seed: seed + frame }, offIdeal });
    const smoothed = smooth(world, filters, frame / 30);
    const out = run.update({
      world: smoothed,
      reliable: reliableLandmarks(image),
      gravity: { x: 0, y: 1, z: 0 },
      now: (frame / 30) * 1000,
    });
    frame++;
    if (out.result) result = out.result;
    return out;
  };

  for (let i = 0; i < 150 && run.step === "front"; i++) feed(0);
  for (let i = 0; i < 120 && run.step === "turn"; i++) feed(Math.min(90, i * 3));
  for (let i = 0; i < 150 && run.step === "side"; i++) feed(90);
  return { run, result, frames: frame };
}

test("a calibration completes, in both views, within a sane number of frames", () => {
  const { run, result, frames } = calibrate("mountain", 1000);
  assert(run.done, `stopped at step "${run.step}"`);
  assert(result && result.bones, "produced bone lengths");
  assertEqual(Object.keys(result.bones).length, Object.keys(BONES).length,
    "every bone measured");
  assert(frames < 360, `took ${frames} frames`);
});

test("repeat calibrations of the same body agree within 2%", () => {
  // The acceptance criterion. Different noise, same person: if the answer moves
  // by more than a couple of percent, nothing downstream can lean on it.
  const a = calibrate("mountain", 2000).result.bones;
  const b = calibrate("mountain", 7000).result.bones;

  let worst = 0, worstBone = "";
  for (const name of Object.keys(a)) {
    const spread = Math.abs(a[name] - b[name]) / a[name];
    if (spread > worst) { worst = spread; worstBone = name; }
  }
  assert(worst < 0.02,
    `${worstBone} moved ${(worst * 100).toFixed(2)}% between calibrations`);
});

test("the measured bones are the real ones, not the foreshortened ones", () => {
  // Reproducibility without accuracy is just a consistent mistake. Checked
  // against the figure the fixtures were built from, which is exactly known.
  const { world } = observe(YOGA_POSES.mountain);
  const truth = {};
  for (const [name, segments] of Object.entries(BONES)) {
    truth[name] = observeBone(world, bodyFrame(world), segments[0]).length;
  }
  const measured = calibrate("mountain", 3000).result.bones;

  let worst = 0, worstBone = "";
  for (const name of Object.keys(truth)) {
    const off = Math.abs(measured[name] - truth[name]) / truth[name];
    if (off > worst) { worst = off; worstBone = name; }
  }
  assert(worst < 0.06,
    `${worstBone} is ${(worst * 100).toFixed(1)}% from its true length`);
});

test("a body that will not hold still never finishes", () => {
  const run = new CalibrationRun();
  const filters = makeFilters(TUNING.world);
  for (let i = 0; i < 200; i++) {
    // Turning continuously: never still, so the hold never accumulates.
    const { world } = observe(YOGA_POSES.mountain,
      { noise: { seed: 5000 + i }, offIdeal: (i * 7) % 90 });
    run.update({
      world: smooth(world, filters, i / 30),
      gravity: { x: 0, y: 1, z: 0 },
      now: (i / 30) * 1000,
    });
  }
  assert(!run.done, "finished a calibration on a body that never stopped moving");
});

test("drifting mid-hold restarts the hold rather than banking it", () => {
  const run = new CalibrationRun({ warmupMs: 0 });
  const still = observe(YOGA_POSES.mountain).world;
  const elsewhere = observe(YOGA_POSES.mountain, { offIdeal: 40 }).world;

  run.update({ world: still, now: 0 });
  const partway = run.update({ world: still, now: HOLD_MS * 0.6 });
  assert(partway.progress > 0.4, `a hold is accumulating (${partway.progress})`);

  const drifted = run.update({ world: elsewhere, now: HOLD_MS * 0.7 });
  assertEqual(drifted.progress, 0, "and drifting resets it");
  assertEqual(drifted.still, false);
});

test("nothing at all in frame does not advance anything", () => {
  const run = new CalibrationRun();
  const out = run.update({ world: null, now: 0 });
  assertEqual(out.done, false);
  assertEqual(out.progress, 0);
  assertEqual(run.step, "front");
});

test("the turn step waits for a real turn", () => {
  const run = new CalibrationRun({ warmupMs: 0 });
  run.step = "turn";
  const square = observe(YOGA_POSES.mountain).world;
  run.update({ world: square, now: 0 });
  assertEqual(run.step, "turn", "still square to the camera");

  const sideOn = observe(YOGA_POSES.mountain, { offIdeal: 90 }).world;
  assert(bodyFrame(sideOn).turnDegrees >= TURN_REQUIRED_DEGREES,
    "the fixture really is side-on");
  run.update({ world: sideOn, now: 100 });
  assertEqual(run.step, "side", "and now it collects the second view");
});

// ─────────────────────────────────────────────────────────────
suite("calibration — persistence");

/** A localStorage that behaves, and one that does not. */
const workingStore = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
};
const hostileStore = () => ({
  getItem() { throw new Error("denied"); },
  setItem() { throw new Error("denied"); },
  removeItem() { throw new Error("denied"); },
});

test("a calibration survives a reload", () => {
  const store = workingStore();
  assertEqual(loadCalibration(store), null, "nothing stored yet");
  assert(saveCalibration({ bones: { torso: 0.5 } }, store));
  const back = loadCalibration(store);
  assertClose(back.bones.torso, 0.5, 1e-9);
  assert(back.at > 0, "and knows when it was taken");
});

test("a calibration from another version is ignored rather than trusted", () => {
  const store = workingStore();
  store.setItem("yoga.calibration", JSON.stringify({ version: 99, bones: { torso: 1 } }));
  assertEqual(loadCalibration(store), null);
});

test("junk in storage does not take the app down with it", () => {
  const store = workingStore();
  store.setItem("yoga.calibration", "{not json");
  assertEqual(loadCalibration(store), null);
  store.setItem("yoga.calibration", JSON.stringify({ version: 1 }));
  assertEqual(loadCalibration(store), null, "a record with no bones is no record");
});

test("storage that throws is the same as storage that is empty", () => {
  // Private browsing throws on every touch. The app must simply calibrate
  // again next session rather than fail to start.
  const store = hostileStore();
  assertEqual(loadCalibration(store), null);
  assertEqual(saveCalibration({ bones: { torso: 0.5 } }, store), false);
  clearCalibration(store);      // must not throw
});
