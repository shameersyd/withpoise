import { suite, test, assert, assertEqual, assertClose, assertDeepEqual } from "./harness.js";
import { POSE_DATA } from "./poses.js";
import {
  validatePose, compilePose, compileAll, deriveTargets,
  JOINT_NAMES, DEFAULT_TOLERANCE, DEFAULT_WEIGHT, VIEWS,
} from "../yoga_app/pose-schema.js";
import { buildReference, computeAngles, figureLandmarks } from "../yoga_app/pose-core.js";

suite("pose schema");

const clone = (o) => JSON.parse(JSON.stringify(o));
const broken = (mutate) => {
  const pose = clone(POSE_DATA.warrior1);
  mutate(pose);
  return validatePose("warrior1", pose);
};
const complains = (problems, about) =>
  assert(problems.some(p => p.includes(about)),
    `expected a complaint about ${about}, got:\n      ${problems.join("\n      ") || "(none)"}`);

test("every pose that ships is valid", () => {
  for (const [key, pose] of Object.entries(POSE_DATA)) {
    assertDeepEqual(validatePose(key, pose), [], key);
  }
});

test("the targets are the rig, not a second opinion about it", () => {
  // The whole point of the format: a pose describes its shape once. These used
  // to be forty hand-written numbers that happened to agree with the rig.
  for (const [key, pose] of Object.entries(POSE_DATA)) {
    const compiled = compilePose(key, pose);
    const straightFromTheRig = computeAngles(
      figureLandmarks(buildReference(pose.rig, null, pose.view)), null, 1, 1);
    for (const joint of JOINT_NAMES) {
      assertClose(compiled.angles[joint][0], straightFromTheRig[joint], 1e-9, `${key} ${joint}`);
    }
  }
});

test("a missing name, emoji or description is caught", () => {
  for (const field of ["name", "sanskrit", "emoji", "description"]) {
    complains(broken(p => { delete p[field]; }), `warrior1.${field}`);
    complains(broken(p => { p[field] = "   "; }), `warrior1.${field}`);
  }
});

test("sidedness has to be stated exactly once", () => {
  complains(broken(p => { delete p.side; }), "symmetric: true");
  complains(broken(p => { p.symmetric = true; }), "cannot be set on a pose marked symmetric");
  complains(broken(p => { delete p.side; p.side = "sideways"; }), "symmetric: true");
  assertDeepEqual(validatePose("m", { ...clone(POSE_DATA.mountain) }), [], "symmetric alone is fine");
});

test("a view has to be one the app knows how to ask for", () => {
  complains(broken(p => { p.view = "overhead"; }), "warrior1.view");
  for (const view of VIEWS) {
    assertDeepEqual(broken(p => { p.view = view; }), [], view);
  }
  assertDeepEqual(broken(p => { delete p.view; }), [], "and it may be left out");
});

test("a rig missing a segment is caught rather than built", () => {
  // The failure this exists for: a missing segment silently becomes a limb at
  // the origin, and the app scores somebody against it and tells them to move.
  complains(broken(p => { delete p.rig.leg_left.shin; }), "rig.leg_left.shin");
  complains(broken(p => { delete p.rig.arm_right.upper; }), "rig.arm_right.upper");
  complains(broken(p => { delete p.rig.torso; }), "rig.torso");
  complains(broken(p => { delete p.rig.leg_right; }), "rig.leg_right");
});

test("a rig with a segment nobody will read is caught too", () => {
  // Silently ignoring it means an author writes "calf", sees no effect, and has
  // no idea why.
  complains(broken(p => { p.rig.leg_left.calf = -90; }), 'unknown segment "calf"');
  complains(broken(p => { p.rig.tail = 10; }), 'unknown limb "tail"');
});

test("a direction must be a number or a pair of them", () => {
  for (const value of ["90", null, [90], [90, 0, 0], NaN, {}]) {
    complains(broken(p => { p.rig.torso = value; }), "rig.torso");
  }
  assertDeepEqual(broken(p => { p.rig.torso = [90, 15]; }), [], "[theta, phi] is fine");
  assertDeepEqual(broken(p => { p.rig.leg_left.shin = [-90, -20]; }), [],
    "and a limb segment can be tilted out of plane now too");
});

test("a rig that cannot make a real angle is caught", () => {
  complains(broken(p => { p.rig.leg_left.thigh = Infinity; }), "rig.leg_left.thigh");
});

test("steps and their highlights are checked", () => {
  complains(broken(p => { p.steps = []; }), "warrior1.steps");
  complains(broken(p => { delete p.steps[1].text; }), "steps[1].text");
  complains(broken(p => { p.steps[0].focus = ["elbows"]; }), 'unknown body part "elbows"');
  complains(broken(p => { p.steps[0].focus = "left_leg"; }), "steps[0].focus");
  assertDeepEqual(broken(p => { delete p.steps[0].focus; }), [], "focus is optional");
});

test("tips are checked", () => {
  complains(broken(p => { p.tips[0].text = ""; }), "tips[0].text");
  complains(broken(p => { delete p.tips[1].icon; }), "tips[1].icon");
});

test("joint tolerances and weights are checked", () => {
  complains(broken(p => { p.joints.left_knee.tolerance = 0; }), "left_knee.tolerance");
  complains(broken(p => { p.joints.left_knee.tolerance = 120; }), "left_knee.tolerance");
  complains(broken(p => { p.joints.left_knee.weight = -1; }), "left_knee.weight");
  complains(broken(p => { p.joints.left_shin = { weight: 2 }; }), 'unknown joint "left_shin"');
  complains(broken(p => { p.joints.left_knee.wobble = 2; }), 'unknown field "wobble"');
  assertDeepEqual(broken(p => { p.joints.left_knee.weight = 0; }), [],
    "a weight of zero is a deliberate 'do not score this'");
});

test("defaults fill in whatever a pose does not say", () => {
  const compiled = compilePose("x", {
    ...clone(POSE_DATA.mountain),
    joints: { default: { tolerance: 18, weight: 4 }, left_knee: { weight: 9 } },
  });
  assertEqual(compiled.angles.right_elbow[1], 18, "tolerance from the default");
  assertEqual(compiled.weights.right_elbow, 4, "weight from the default");
  assertEqual(compiled.weights.left_knee, 9, "overridden where stated");
  assertEqual(compiled.angles.left_knee[1], 18, "and the default still applies to the rest of it");
});

test("a pose with no joints block at all still compiles", () => {
  const pose = clone(POSE_DATA.mountain);
  delete pose.joints;
  assertDeepEqual(validatePose("m", pose), []);
  const compiled = compilePose("m", pose);
  assertEqual(compiled.angles.left_knee[1], DEFAULT_TOLERANCE);
  assertEqual(compiled.weights.left_knee, DEFAULT_WEIGHT);
  assertEqual(Object.keys(compiled.angles).length, 8, "all eight joints are always scored");
});

test("view defaults to front", () => {
  const pose = clone(POSE_DATA.mountain);
  delete pose.view;
  assertEqual(compilePose("m", pose).view, "front");
});

test("compileAll refuses the whole library and says why", () => {
  const library = clone(POSE_DATA);
  delete library.tree.rig.leg_left.shin;
  library.triangle.steps[0].focus = ["nose"];
  let message = null;
  try {
    compileAll(library);
  } catch (err) {
    message = err.message;
  }
  assert(message, "compileAll must throw rather than return something broken");
  assert(message.includes("2 problems"), message);
  assert(message.includes("tree.rig.leg_left.shin"), "names the first");
  assert(message.includes("triangle.steps[0].focus"), "and the second");
});

test("compileAll accepts the real library", () => {
  const compiled = compileAll(POSE_DATA);
  assertEqual(Object.keys(compiled).length, Object.keys(POSE_DATA).length);
  for (const [key, pose] of Object.entries(compiled)) {
    assertEqual(pose.key, key, "each pose knows its own key");
  }
});

test("deriveTargets is pure and repeatable", () => {
  const once = deriveTargets(POSE_DATA.tree.rig);
  const twice = deriveTargets(POSE_DATA.tree.rig);
  assertDeepEqual(once, twice);
});
