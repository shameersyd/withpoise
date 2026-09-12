import { suite, test, expectedFail, assert, assertEqual, assertClose } from "./harness.js";
import {
  computeAngles, matchSinglePose, reliableLandmarks, sidesOf, buildReference, v3,
} from "../yoga_app/pose-core.js";
import { scoreObservation } from "../yoga_app/scoring.js";
import { YOGA_POSES, CORRECTION_TIPS } from "./poses.js";
import {
  observe, valgus, pelvisYaw, limbSwing, depthMirror, addNoise, worldLandmarks,
} from "./synthetic.js";

suite("spatial faults — the generators");

const figureOf = (key) => observe(YOGA_POSES[key]).figure;
const span = (P, a, b) => v3.len(v3.sub(P[a], P[b]));

const BONES = [
  ["left_hip", "left_knee"], ["left_knee", "left_ankle"],
  ["right_hip", "right_knee"], ["right_knee", "right_ankle"],
  ["left_shoulder", "left_elbow"], ["left_elbow", "left_wrist"],
  ["right_shoulder", "right_elbow"], ["right_elbow", "right_wrist"],
];

test("valgus moves the knee without changing a single bone", () => {
  // Rotating the knee about the hip→ankle axis keeps its distance to both ends,
  // because a rotation about an axis preserves distance to every point on it.
  // That is what makes this fault invisible to joint angles, and it is why it
  // is the right fault to test with.
  const base = figureOf("warrior1");
  const bent = valgus(base, "left", 30);
  for (const [a, b] of BONES) {
    assertClose(span(bent, a, b), span(base, a, b), 1e-12, `${a}→${b}`);
  }
  assert(v3.len(v3.sub(base.left_knee, bent.left_knee)) > 0.05,
    "and the knee really has moved");
});

test("valgus is invisible because the deadband swallows it, not because nothing moves", () => {
  // Worth being precise about, because "joint angles cannot see this" is only
  // half true and the other half matters.
  //
  // The knee angle really is untouched — exact to four decimal places, by
  // construction. The *hip* angle does move, because the knee has swung round
  // and the hip is measured shoulder→hip→knee. It just does not move enough:
  // 2.7° at 30° of valgus against a 25° tolerance, 10.4° at 60°. The fault is
  // real and measurable and the deadband eats it.
  //
  // Which is also why narrowing tolerances is not the fix. At a tolerance tight
  // enough to catch 30° of valgus through the hip angle, every honest pose
  // would fail too.
  const base = observe(YOGA_POSES.warrior1);
  const before = computeAngles(base.world, base.image, 1, 1);

  const drift = {};
  for (const deg of [15, 30, 45, 60]) {
    const f = observe(YOGA_POSES.warrior1, { fault: (P) => valgus(P, "left", deg) });
    const after = computeAngles(f.world, f.image, 1, 1);
    assertClose(after.left_knee, before.left_knee, 0.01,
      `the knee angle itself at ${deg}°`);
    drift[deg] = Math.abs(after.left_hip - before.left_hip);
  }

  assert(drift[30] < 4, `30° of valgus moves the hip angle ${drift[30].toFixed(1)}°`);
  assert(drift[60] < 12, `60° of valgus moves the hip angle ${drift[60].toFixed(1)}°`);
  assert(drift[60] > drift[15], "and it does grow with severity");

  const tolerance = YOGA_POSES.warrior1.angles.left_hip[1];
  assert(drift[60] < tolerance,
    `even 60° stays inside the ${tolerance}° tolerance — which is the problem`);
});

test("a swung limb keeps its bones and its angles", () => {
  const base = figureOf("warrior2");
  const swung = limbSwing(base, "arm_left", 90);
  for (const [a, b] of BONES) {
    assertClose(span(swung, a, b), span(base, a, b), 1e-12, `${a}→${b}`);
  }
  assert(v3.len(v3.sub(base.left_wrist, swung.left_wrist)) > 0.2,
    "the wrist travels a long way");
});

test("pelvis yaw turns the upper body as one piece", () => {
  const base = figureOf("warrior1");
  const yawed = pelvisYaw(base, 45);
  assertClose(span(yawed, "left_shoulder", "right_shoulder"),
    span(base, "left_shoulder", "right_shoulder"), 1e-12, "shoulder span");
  assertClose(span(yawed, "left_hip", "right_hip"),
    span(base, "left_hip", "right_hip"), 1e-12, "hip span");
  assertEqual(yawed.left_ankle, base.left_ankle, "feet stay planted");
});

test("the noise model is seeded, anisotropic, and reproducible", () => {
  const base = figureOf("tree");
  const a = addNoise(base, { seed: 42 });
  const b = addNoise(base, { seed: 42 });
  const c = addNoise(base, { seed: 43 });
  assertEqual(JSON.stringify(a), JSON.stringify(b), "same seed, same body");
  assert(JSON.stringify(a) !== JSON.stringify(c), "different seed, different body");

  // Depth noise has to dominate, because that is the real error profile and
  // the whole premise of the work that follows.
  let spreadXY = 0, spreadZ = 0, n = 0;
  for (const [name, p] of Object.entries(a)) {
    spreadXY += Math.abs(p.x - base[name].x) + Math.abs(p.y - base[name].y);
    spreadZ += Math.abs(p.z - (base[name].z || 0));
    n++;
  }
  assert(spreadZ / n > (spreadXY / (2 * n)) * 2.5,
    `z noise ${(spreadZ / n).toFixed(4)} should dwarf x/y ${(spreadXY / (2 * n)).toFixed(4)}`);
});

// ─────────────────────────────────────────────────────────────
suite("spatial faults — what the scoring sees");

const variantsOf = (pose) => sidesOf(pose).map((p) => ({
  pose: p, reference: buildReference(p.rig, null, p.view),
}));

function judge(key, fault) {
  const { image, world } = observe(YOGA_POSES[key], { fault });
  return scoreObservation({ landmarks: image, world }, {
    variants: variantsOf(YOGA_POSES[key]),
    tips: CORRECTION_TIPS,
    reliable: reliableLandmarks(image),
  }).match;
}

const mentions = (match, word) =>
  match.corrections.some(c => c.text.toLowerCase().includes(word));

expectedFail("a knee collapsing inward is caught", () => {
  // 30° of valgus is 13cm of knee travel with the foot planted — the single
  // most common fault in a lunge, and the one every teacher calls out first.
  const match = judge("warrior1", (P) => valgus(P, "left", 30));
  assert(match.score < 95, `scored ${match.score.toFixed(1)}`);
  assert(mentions(match, "knee"), `no knee correction: ${JSON.stringify(match.corrections)}`);
});

expectedFail("hips that are not square are caught", () => {
  // Warrior I's own step 5 is "square your hips toward the front of your mat".
  const match = judge("warrior1", (P) => pelvisYaw(P, 30));
  assert(match.score < 95, `scored ${match.score.toFixed(1)}`);
  assert(mentions(match, "hip"), `no hip correction: ${JSON.stringify(match.corrections)}`);
});

expectedFail("an arm pointing the wrong way is caught", () => {
  // Warrior II with the arm swung forward instead of out to the side: every
  // bone and every angle correct, the pose entirely wrong.
  const match = judge("warrior2", (P) => limbSwing(P, "arm_left", 45));
  assert(match.score < 95, `scored ${match.score.toFixed(1)}`);
});

test("a body mirrored front-to-back is invisible, and always will be", () => {
  // Kept as a passing test rather than an expected failure, because this one is
  // not a gap that closes. Two separate reasons:
  //
  //   · All six poses are planar, so every z is zero and negating it is
  //     literally the identity. A rig can express depth now, but none of these
  //     use it.
  //   · Even given a pose with depth, the forward component of any direction
  //     comes from z, which one camera does not know. Scoring it confidently
  //     would be scoring a guess — see docs/LIMITS.md §2.
  //
  // The right response to a front/back ambiguity is to report low confidence,
  // which is what the measurability gate already does.
  for (const key of Object.keys(YOGA_POSES)) {
    const plain = judge(key, (P) => P);
    const flipped = judge(key, depthMirror);
    assertClose(flipped.score, plain.score, 1e-9, key);
  }
});

test("noise alone does not invent a fault", () => {
  // The floor under every later claim: if the scoring cannot tell a clean body
  // from a noisy one, nothing measured against the noise model means anything.
  for (const key of Object.keys(YOGA_POSES)) {
    const match = judge(key, (P) => addNoise(P, { seed: 11 }));
    assert(match.score > 95, `${key} scored ${match.score.toFixed(1)} on noise alone`);
  }
});
