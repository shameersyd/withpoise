import { suite, test, expectedFail, assert, assertEqual, assertClose, assertDeepEqual } from "./harness.js";
import {
  computeAngles, matchSinglePose, reliableLandmarks, sidesOf, buildReference, v3,
} from "../yoga_app/pose-core.js";
import { scoreObservation } from "../yoga_app/scoring.js";
import { facingWrongWay } from "../yoga_app/pose-core.js";
import { YOGA_POSES, CORRECTION_TIPS } from "./poses.js";
import {
  observe, valgus, pelvisYaw, limbSwing, depthMirror, addNoise, rotateAboutSpine,
} from "./synthetic.js";
import { makeFilters, smooth, TUNING } from "../yoga_app/pose-core.js";

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

/**
 * The same, but through the One Euro smoothing the worker applies before
 * anything on the main thread sees a landmark.
 *
 * Direction scoring needs it. An unsmoothed frame carries 3–8° of direction
 * noise per segment against a 4° tolerance, and judging that would be judging
 * the jitter. Smoothed, the same noise is 0.7–1.5°. The app has never had
 * unsmoothed landmarks available to it, so this is the honest path — but it is
 * worth knowing that the tolerance depends on the filter.
 */
function judgeOverTime(key, fault, { seed = 11, frames = 70 } = {}) {
  const pose = YOGA_POSES[key];
  const filters = makeFilters(TUNING.world);
  let last = null;
  for (let i = 0; i < frames; i++) {
    const { image, world } = observe(pose, { fault, noise: { seed: seed + i * 17 } });
    const smoothed = smooth(world, filters, i / 30);
    last = scoreObservation({ landmarks: image, world: smoothed }, {
      variants: variantsOf(pose),
      tips: CORRECTION_TIPS,
      reliable: reliableLandmarks(image),
    }).match;
  }
  return last;
}

const mentions = (match, word) =>
  match.corrections.some(c => c.text.toLowerCase().includes(word));

test("a knee collapsing inward is caught", () => {
  // 30° of valgus is 13cm of knee travel with the foot planted — the single
  // most common fault in a lunge, and the one every teacher calls out first.
  const match = judge("warrior1", (P) => valgus(P, "left", 30));
  assert(match.score < 95, `scored ${match.score.toFixed(1)}`);
  assert(mentions(match, "knee"), `no knee correction: ${JSON.stringify(match.corrections)}`);
});

test("hips that are not square are caught", () => {
  // Warrior I's own step 5 is "square your hips toward the front of your mat".
  const match = judge("warrior1", (P) => pelvisYaw(P, 30));
  assert(match.score < 95, `scored ${match.score.toFixed(1)}`);
  assert(mentions(match, "hip"), `no hip correction: ${JSON.stringify(match.corrections)}`);
});

test("an arm pointing the wrong way is caught", () => {
  // Warrior II with the arm swung forward instead of out to the side: every
  // bone and every angle correct, the pose entirely wrong.
  const match = judge("warrior2", (P) => limbSwing(P, "arm_left", 45));
  assert(match.score < 95, `scored ${match.score.toFixed(1)}`);
});

test("a person facing the other way is a rotation, and still correct", () => {
  // The case that actually happens: someone sets up facing the other end of the
  // room. That is a 180° rotation, it preserves handedness, and the body frame
  // turns with them — so every pose must score exactly what it scored before.
  // Direction scoring has to leave this alone or it has broken the app for half
  // its users.
  for (const key of Object.keys(YOGA_POSES)) {
    const facing = judge(key, (P) => P);
    const away = judge(key, (P) => rotateAboutSpine(P, 180));
    assertClose(away.score, facing.score, 1e-6, key);
  }
});

test("a body mirrored front-to-back is invisible in a planar pose", () => {
  // Every front-view pose here is planar — every z is zero — so negating z is
  // literally the identity and there is nothing to detect. The fault is real in
  // principle; these bodies cannot exhibit it.
  for (const key of Object.keys(YOGA_POSES)) {
    if (YOGA_POSES[key].view === "side") continue;
    assertClose(judge(key, depthMirror).score, judge(key, (P) => P).score, 1e-9, key);
  }
});

test("a mirrored side-on pose is a body turned inside out, and reads as one", () => {
  // Downward Dog is the one pose whose left and right separate along z, so
  // negating z actually changes it — into a body with inverted handedness,
  // which is not a person. Direction scoring notices; angles never could.
  //
  // Worth distinguishing from the test above it: this is not the app catching a
  // fault someone could commit. It is the app no longer being blind to a
  // reflection, which is the last row of the diagnosis table.
  const flipped = judge("downdog", depthMirror);
  assert(flipped.score < 90, `mirrored Downward Dog scored ${flipped.score.toFixed(1)}`);
});

test("noise alone does not invent a fault", () => {
  // The floor under every later claim: if the scoring cannot tell a clean body
  // from a noisy one, nothing measured against the noise model means anything.
  for (const key of Object.keys(YOGA_POSES)) {
    const match = judgeOverTime(key, (P) => P);
    assert(match.score > 97, `${key} scored ${match.score.toFixed(1)} on noise alone`);
  }
});

test("and neither does noise on a body standing 30° off-axis", () => {
  // The invariance requirement, under the noise model, through the whole
  // pipeline. If direction scoring made camera angle look like bad form, this
  // is where it would show.
  //
  // Front poses only. For Downward Dog "30° off" means 30° away from the
  // side-on view it requires, which is not a mild inconvenience — it is most of
  // the way to unreadable, and the app's answer there is to ask the user to
  // turn rather than to score them. That case is the test below.
  for (const key of Object.keys(YOGA_POSES).filter(k => YOGA_POSES[k].view === "front")) {
    const pose = YOGA_POSES[key];
    const filters = makeFilters(TUNING.world);
    let match = null;
    for (let i = 0; i < 70; i++) {
      const { image, world } = observe(pose, { offIdeal: 30, noise: { seed: 5 + i * 17 } });
      match = scoreObservation({ landmarks: image, world: smooth(world, filters, i / 30) }, {
        variants: variantsOf(pose), tips: CORRECTION_TIPS, reliable: reliableLandmarks(image),
      }).match;
    }
    assert(match.score > 95, `${key} scored ${match.score.toFixed(1)} standing 30° off-axis`);
  }
});

test("a side-on pose seen from the wrong angle is a turn to make, not a fault", () => {
  // Down Dog 30° off its view is not a bad Down Dog, it is a Down Dog nobody
  // can read. The body frame every direction is expressed in is itself being
  // measured through a compressed depth axis, so scoring directions there would
  // be scoring the viewing angle. They go to "can't tell" instead.
  const pose = YOGA_POSES.downdog;
  const { image, world } = observe(pose, { offIdeal: 30 });
  const { match } = scoreObservation({ landmarks: image, world }, {
    variants: variantsOf(pose), tips: CORRECTION_TIPS, reliable: reliableLandmarks(image),
  });

  assert(facingWrongWay("side", match.turnDegrees),
    `reads ${match.turnDegrees.toFixed(0)}°, which does not trigger the warning`);
  assert(match.coverage < 0.5, `coverage ${(match.coverage * 100).toFixed(0)}%`);
  assertDeepEqual(match.corrections, [], "and nothing is invented out of it");
});
