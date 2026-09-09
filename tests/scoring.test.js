import { suite, test, assert, assertEqual, assertClose, assertDeepEqual, assertSameSet } from "./harness.js";
import {
  LM, computeAngles, matchSinglePose, reliableLandmarks, correctionsFor, calcAngle,
} from "../yoga_app/pose-core.js";
import { YOGA_POSES, CORRECTION_TIPS } from "../yoga_app/poses.js";

suite("scoring");

const POSES = Object.keys(YOGA_POSES);
const fixture = (key) => JSON.parse(readFile(`tests/fixtures/${key}.json`));

/** What the app does with one fixture variant, end to end. */
function score(key, variantName) {
  const v = fixture(key).variants[variantName];
  const reliable = reliableLandmarks(v.image);
  const angles = computeAngles(v.world, v.image, 1280, 720);
  const match = matchSinglePose(angles, YOGA_POSES[key].angles, reliable);
  const corrections = correctionsFor(match.results, CORRECTION_TIPS);
  return { ...match, corrections, meta: v, reliable };
}

const failing = (r) => r.corrections.map(c => c.joint).sort();

// ─────────────────────────────────────────────────────────────
// A correctly held pose
// ─────────────────────────────────────────────────────────────
for (const key of POSES) {
  test(`${key}: a correctly held pose scores 100 on all eight joints`, () => {
    const r = score(key, "correct");
    assertEqual(r.score, 100, "score");
    assertEqual(r.scored, 8, "joints scored");
    assertDeepEqual(r.unscored, [], "nothing unscored");
    assertDeepEqual(r.corrections, [], "no corrections");
  });

  test(`${key}: every joint of a correct pose sits inside its tolerance`, () => {
    const r = score(key, "correct");
    for (const [joint, res] of Object.entries(r.results)) {
      assert(res.diff <= res.tolerance,
        `${joint} off by ${res.diff.toFixed(1)}° (tolerance ${res.tolerance}°)`);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// A single known fault
//
// Each fixture bends one straight leg's shin. That changes exactly one joint
// angle: the hip is measured shoulder-hip-knee and never touches the ankle.
// ─────────────────────────────────────────────────────────────
for (const key of POSES.filter(k => k !== "triangle")) {
  test(`${key}: a bent shin fails that knee and only that knee`, () => {
    const r = score(key, "fault");
    const expected = r.meta.fault;
    assertDeepEqual(failing(r), [expected.joint], "failing joints");
    assertEqual(r.scored, 8, "all eight still scored");
    assertClose(r.score, 87.5, 0.001, "seven of eight");
  });

  test(`${key}: the fault emits exactly the expected instruction`, () => {
    const r = score(key, "fault");
    assertDeepEqual(r.corrections.map(c => c.text), [r.meta.fault.expectCorrection]);
  });
}

test("triangle: a fault that leaves the frame RAISES the score to 100", () => {
  // Not a quirk of the fixture — the pathology itself. Bending Triangle's front
  // shin swings the ankle below the bottom of the frame, so `reliable` drops the
  // ankle, the knee joint goes unscored, and the denominator shrinks to match.
  // The user is now doing the pose *worse* and being told they are perfect.
  //
  // Phase 1b changes this. When it does, this test should fail loudly and be
  // rewritten — that is what it is here for.
  const r = score("triangle", "fault");
  assertEqual(r.score, 100, "score");
  assertEqual(r.scored, 7, "joints scored");
  assertDeepEqual(r.unscored, ["left_knee"], "the faulted joint is the one dropped");
  assertDeepEqual(r.corrections, [], "and nothing is said about it");
});

// ─────────────────────────────────────────────────────────────
// Partly out of frame
// ─────────────────────────────────────────────────────────────
for (const key of POSES) {
  test(`${key}: joints below the frame are dropped, not scored wrong`, () => {
    const r = score(key, "partial");
    assertSameSet(r.unscored, ["left_knee", "right_knee", "left_hip", "right_hip"],
      "knees need ankles and hips need knees");
    assertEqual(r.scored, 4, "only the upper body is scored");
    for (const name of r.meta.offFrame) {
      assert(!r.reliable.has(name), `${name} should not be reliable`);
    }
  });

  test(`${key}: a half-visible body still reports 100%`, () => {
    // Current behaviour, and wrong: unscored joints leave the denominator, so
    // four aligned joints out of a possible eight read as a perfect pose. Only
    // the green glow guards on hidden === 0; the headline number does not.
    // Phase 1b changes this.
    const r = score(key, "partial");
    assertEqual(r.score, 100);
  });
}

// ─────────────────────────────────────────────────────────────
// Camera angle
// ─────────────────────────────────────────────────────────────
test("a rigid turn changes no joint angle at all", () => {
  // World landmarks are hip-centred, so rotating them about the origin is
  // rotating the body in place. calcAngle is rotation-invariant, so this must
  // be exact — which localises the whole view-dependence problem in the depth
  // *error* of the landmarker, not in our math.
  const v = fixture("warrior1").variants.correct;
  const turn = (pts, deg) => {
    const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    return pts.map(p => ({ ...p, x: p.x * c + p.z * s, z: -p.x * s + p.z * c }));
  };
  const head = computeAngles(v.world, v.image, 1280, 720);
  for (const deg of [15, 45, 80, 135]) {
    const turned = computeAngles(turn(v.world, deg), v.image, 1280, 720);
    for (const joint of Object.keys(head)) {
      assertClose(turned[joint], head[joint], 1e-9, `${joint} at ${deg}°`);
    }
  }
});

// What each pose scores once the depth axis is compressed the way a monocular
// landmarker compresses it on a body turned 80° off-axis. These numbers are the
// cost of having no view-invariant preprocessing: the user is holding the pose
// correctly in every case.
const EDGE_ON = {
  mountain: { score: 100,  failing: [] },
  warrior1: { score: 87.5, failing: ["left_knee"] },
  warrior2: { score: 100,  failing: [] },
  tree:     { score: 87.5, failing: ["right_knee"] },
  triangle: { score: 62.5, failing: ["left_hip", "left_shoulder", "right_shoulder"] },
};

for (const key of POSES) {
  test(`${key}: edge-on with compressed depth scores ${EDGE_ON[key].score}`, () => {
    const r = score(key, "edgeOn");
    assertClose(r.score, EDGE_ON[key].score, 0.001, "score");
    assertDeepEqual(failing(r), EDGE_ON[key].failing.sort(), "failing joints");
  });
}

test("the poses that survive edge-on are the ones held in the frontal plane", () => {
  // Mountain and Warrior II are flat to the camera, so squashing depth barely
  // touches them. Triangle is the opposite and loses 37 points for standing at
  // an angle rather than for anything the body did.
  assert(EDGE_ON.mountain.score === 100 && EDGE_ON.warrior2.score === 100);
  assert(EDGE_ON.triangle.score < 70);
});

// ─────────────────────────────────────────────────────────────
// The pieces underneath
// ─────────────────────────────────────────────────────────────
test("calcAngle measures the angle at the middle point, in 3D", () => {
  const o = { x: 0, y: 0, z: 0 };
  assertClose(calcAngle({ x: 1, y: 0, z: 0 }, o, { x: 0, y: 1, z: 0 }), 90, 1e-9, "right angle in x/y");
  assertClose(calcAngle({ x: 1, y: 0, z: 0 }, o, { x: 0, y: 0, z: 1 }), 90, 1e-9, "right angle into depth");
  assertClose(calcAngle({ x: 1, y: 0, z: 0 }, o, { x: -1, y: 0, z: 0 }), 180, 1e-9, "straight");
  assertClose(calcAngle({ x: 1, y: 0, z: 0 }, o, { x: 1, y: 0, z: 0 }), 0, 1e-6, "folded");
});

test("a limb pointing at the camera is straight in 3D and bent in 2D", () => {
  // The reason scoring moved to world landmarks. Shoulder, elbow and wrist in a
  // straight line down the camera axis: unambiguous in 3D, a right angle once
  // you drop z.
  const a = { x: 0, y: 0, z: 0 }, b = { x: 0.2, y: 0, z: 0.2 }, c = { x: 0.4, y: 0, z: 0.4 };
  // acos is ill-conditioned at ±1 — a last-bit error in the cosine is worth
  // ~1e-5 degrees here — so straightness is asserted to a thousandth of a
  // degree rather than exactly. Against a 20° tolerance that is exact enough.
  assertClose(calcAngle(a, b, c), 180, 1e-3, "in 3D");
  const flat = (p) => ({ x: p.x, y: p.y, z: 0 });
  assertClose(calcAngle(flat(a), flat(b), flat(c)), 180, 1e-3, "flat, but still collinear in x");
  // Fold it out of the image plane instead and 2D loses the bend entirely.
  const d = { x: 0.4, y: 0, z: -0.4 };
  assert(calcAngle(a, b, d) < 100, "a real 90° bend in 3D");
  assertClose(calcAngle(flat(a), flat(b), flat(d)), 180, 1e-3, "invisible once flattened");
});

test("reliableLandmarks rejects held, dim and off-frame landmarks", () => {
  const base = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  assertEqual(reliableLandmarks(base).size, Object.keys(LM).length, "all thirteen named landmarks");

  const held = base.map((p, i) => (i === LM.left_knee ? { ...p, held: true } : p));
  assert(!reliableLandmarks(held).has("left_knee"), "held is a guess, not a measurement");

  const dim = base.map((p, i) => (i === LM.left_knee ? { ...p, visibility: 0.49 } : p));
  assert(!reliableLandmarks(dim).has("left_knee"), "below threshold");

  const edge = base.map((p, i) => (i === LM.left_knee ? { ...p, visibility: 0.5 } : p));
  assert(reliableLandmarks(edge).has("left_knee"), "exactly at threshold is trusted");

  for (const off of [{ x: -0.03 }, { x: 1.03 }, { y: -0.03 }, { y: 1.03 }]) {
    const out = base.map((p, i) => (i === LM.left_knee ? { ...p, ...off } : p));
    assert(!reliableLandmarks(out).has("left_knee"), `off-frame ${JSON.stringify(off)}`);
  }
});

test("matchSinglePose scores every joint when given no reliability set", () => {
  const v = fixture("tree").variants.partial;
  const angles = computeAngles(v.world, v.image, 1280, 720);
  const m = matchSinglePose(angles, YOGA_POSES.tree.angles, null);
  assertEqual(m.scored, 8, "no gate means no joint is dropped");
  assertDeepEqual(m.unscored, []);
});

test("correctionsFor picks its phrasing from the sign of the error", () => {
  const tips = { left_knee: ["TOO_BENT", "TOO_STRAIGHT"] };
  const bent = { left_knee: { ok: false, direction: -30 } };
  const straight = { left_knee: { ok: false, direction: 30 } };
  assertDeepEqual(correctionsFor(bent, tips), [{ joint: "left_knee", text: "TOO_BENT" }]);
  assertDeepEqual(correctionsFor(straight, tips), [{ joint: "left_knee", text: "TOO_STRAIGHT" }]);
  assertDeepEqual(correctionsFor({ left_knee: { ok: true, direction: -30 } }, tips), []);
  assertDeepEqual(correctionsFor({ nose: { ok: false, direction: 1 } }, tips), [],
    "a joint with no phrasing is silently skipped");
});
