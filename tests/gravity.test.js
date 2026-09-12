import { suite, test, assert, assertEqual, assertClose } from "./harness.js";
import {
  gravityFromOrientation, tiltFromUpright, rollFromGravity, pitchFromGravity,
  Tilt, TILT_WARN_DEGREES,
} from "../yoga_app/gravity.js";

suite("gravity");

test("the axis convention matches the landmarks, not the device", () => {
  // Device axes are y-up, z-out-of-screen. Landmarks are y-DOWN, z-away. Get
  // this backwards and every reading is silently inverted, which is the kind of
  // bug that looks like bad tuning for a week.
  const upright = gravityFromOrientation(90, 0);
  assertClose(upright.y, 1, 1e-9, "upright: gravity runs down the image");
  assertClose(upright.x, 0, 1e-9);
  assertClose(upright.z, 0, 1e-9);

  const flat = gravityFromOrientation(0, 0);
  assertClose(flat.z, 1, 1e-9, "face up on a table: gravity points away from the lens");
  assertClose(flat.y, 0, 1e-9);
});

test("pitch is the reading that matters and roll is the one that doesn't", () => {
  // A rolled phone still sees the whole body undistorted — the frame is just
  // turned. A pitched one foreshortens it, and nothing downstream can undo that.
  const leaningBack = gravityFromOrientation(70, 0);
  assertClose(pitchFromGravity(leaningBack), 20, 1e-6, "20° of pitch");
  assertClose(rollFromGravity(leaningBack), 0, 1e-6, "and no roll");

  const landscape = gravityFromOrientation(0, 90);
  assertClose(rollFromGravity(landscape), 90, 1e-6, "landscape is 90° of roll");
  assertClose(pitchFromGravity(landscape), 0, 1e-6, "and no pitch");
});

test("rolling a phone in its own plane does not read as tilt", () => {
  // Gimbal reality: at beta = 90 the gamma axis points along gravity, so gamma
  // genuinely cannot move it. Worth a test because it looks like a bug.
  for (const gamma of [0, 15, 45, 90]) {
    const g = gravityFromOrientation(90, gamma);
    assertClose(pitchFromGravity(g), 0, 1e-6, `beta 90, gamma ${gamma}`);
  }
});

test("tilt grows smoothly from upright to flat", () => {
  assertClose(tiltFromUpright(gravityFromOrientation(90, 0)), 0, 1e-6, "upright");
  assertClose(tiltFromUpright(gravityFromOrientation(0, 0)), 90, 1e-6, "flat");
  let previous = -1;
  for (const beta of [90, 80, 70, 50, 30, 10, 0]) {
    const tilt = tiltFromUpright(gravityFromOrientation(beta, 0));
    assert(tilt > previous, `not monotonic at beta ${beta}`);
    previous = tilt;
  }
});

test("a zero vector does not produce a NaN", () => {
  // A device that reports nothing must not poison every number downstream.
  assert(Number.isFinite(tiltFromUpright({ x: 0, y: 0, z: 0 })));
  assert(Number.isFinite(pitchFromGravity({ x: 0, y: 0, z: 0 })));
});

suite("gravity — the absent path");

test("with no sensor at all, the app believes exactly what it believed before", () => {
  // The whole point of a graceful-degradation path: nothing downstream branches
  // on whether the sensor exists, because the default IS the old assumption.
  const tilt = new Tilt();
  assertEqual(tilt.available, false);
  assertEqual(tilt.tiltDegrees, 0);
  assertEqual(tilt.pitchDegrees, 0);
  assertEqual(tilt.tilted, false, "upright until told otherwise");
  assertClose(tilt.gravity.y, 1, 1e-9, "and down is down");
});

test("starting is safe where DeviceOrientationEvent does not exist", async () => {
  // jsc has no DOM at all, which makes it a decent stand-in for a browser that
  // refuses. This must resolve false rather than throw.
  const tilt = new Tilt();
  assertEqual(Tilt.supported, typeof DeviceOrientationEvent !== "undefined");
  const started = await tilt.start();
  assertEqual(started, false);
  assertEqual(tilt.available, false);
  tilt.stop();          // and stopping something never started is harmless
});

test("a phone that has not moved does not ask to be recalibrated", () => {
  const tilt = new Tilt();
  tilt.markCalibrated();
  assertEqual(tilt.movedSinceCalibration, false);

  // Simulate readings arriving, as the event handler would set them.
  tilt.pitchDegrees = TILT_WARN_DEGREES - 1;
  tilt.markCalibrated();
  assertEqual(tilt.movedSinceCalibration, false, "calibrated while already leaning");
});
