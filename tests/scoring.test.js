import { suite, test, assert, assertEqual, assertClose, assertDeepEqual, assertSameSet } from "./harness.js";
import {
  LM, computeAngles, matchSinglePose, reliableLandmarks, correctionsFor, calcAngle,
  bodyFrame, toBodyFrame, jointMeasurability, v3, TURN_LIMIT_DEGREES,
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
  const measurability = jointMeasurability(v.world);
  const match = matchSinglePose(angles, YOGA_POSES[key].angles, { reliable, measurability });
  const corrections = correctionsFor(match.results, CORRECTION_TIPS);
  return { ...match, corrections, meta: v, reliable, frame: bodyFrame(v.world) };
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

// A correct pose held 30° off-axis is the brief's acceptance criterion: it must
// score exactly what it scores head-on, with nothing quietly dropped to get
// there.
for (const key of POSES) {
  test(`${key}: 30° off-axis scores the same as head-on, judging every joint`, () => {
    const head = score(key, "correct");
    const turned = score(key, "turned");
    assertClose(turned.score, head.score, 0.001, "score");
    assertEqual(turned.scored, head.scored, "joints judged");
    assertDeepEqual(turned.uncertain, [], "nothing written off as unmeasurable");
    assertDeepEqual(turned.corrections, [], "and no invented faults");
  });
}

// Edge-on, the body's frontal plane is gone and its sagittal plane is if
// anything clearer than before. What survives is judged; what does not is named
// rather than guessed at. Nothing here scores as a fault: the user is holding
// every one of these correctly.
const EDGE_ON_UNCERTAIN = {
  mountain: [],   // arms and legs hang along the spine — readable from any angle
  warrior1: ["left_hip", "left_knee"],
  warrior2: ["left_elbow", "left_hip", "left_knee", "left_shoulder", "right_elbow", "right_shoulder"],
  tree:     ["right_knee"],
  triangle: ["left_elbow", "left_hip", "left_knee", "left_shoulder", "right_elbow", "right_shoulder"],
};

for (const key of POSES) {
  test(`${key}: edge-on judges what it can and admits to the rest`, () => {
    const r = score(key, "edgeOn");
    assertEqual(r.score, 100, "no fault is invented out of the depth axis");
    assertDeepEqual(failing(r), [], "no corrections");
    assertSameSet(r.uncertain, EDGE_ON_UNCERTAIN[key], "joints marked can't-tell");
    assertEqual(r.scored + r.uncertain.length, 8, "every joint is accounted for");
  });
}

test("edge-on is reported as a turn the user can act on", () => {
  for (const key of POSES) {
    const r = score(key, "edgeOn");
    assert(r.frame.turnDegrees > TURN_LIMIT_DEGREES,
      `${key} reads ${r.frame.turnDegrees.toFixed(0)}°, under the ${TURN_LIMIT_DEGREES}° warning`);
  }
  for (const key of POSES) {
    const r = score(key, "turned");
    assert(r.frame.turnDegrees < TURN_LIMIT_DEGREES,
      `${key} at 30° should not trigger a warning, reads ${r.frame.turnDegrees.toFixed(0)}°`);
  }
});

test("turning side-on costs the frontal plane and keeps the sagittal one", () => {
  // Warrior II is held almost entirely in the frontal plane, so edge-on takes
  // nearly all of it. Mountain is a vertical line and loses nothing. That
  // asymmetry is anatomy, not a threshold that happened to land well.
  assertEqual(EDGE_ON_UNCERTAIN.mountain.length, 0);
  assert(EDGE_ON_UNCERTAIN.warrior2.length >= 6);
});

suite("body frame");

/** Rotate hip-centred world landmarks about the vertical axis. */
const turnBy = (pts, deg) => {
  const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  return pts.map(p => ({ ...p, x: p.x * c + p.z * s, z: -p.x * s + p.z * c }));
};

test("the frame is orthonormal", () => {
  for (const key of POSES) {
    const f = bodyFrame(fixture(key).variants.correct.world);
    for (const axis of ["spine", "lateral", "forward"]) {
      assertClose(v3.len(f[axis]), 1, 1e-9, `${key} ${axis} is a unit vector`);
    }
    assertClose(v3.dot(f.spine, f.lateral), 0, 1e-9, `${key} spine ⟂ lateral`);
    assertClose(v3.dot(f.spine, f.forward), 0, 1e-9, `${key} spine ⟂ forward`);
    assertClose(v3.dot(f.lateral, f.forward), 0, 1e-9, `${key} lateral ⟂ forward`);
  }
});

test("facing reads 1 head-on and 0 edge-on", () => {
  const world = fixture("mountain").variants.correct.world;
  assertClose(bodyFrame(world).facing, 1, 1e-6, "square to the lens");
  assertClose(bodyFrame(turnBy(world, 90)).facing, 0, 1e-6, "side-on");
  assertClose(bodyFrame(turnBy(world, 180)).facing, 1, 1e-6,
    "backs-on is as measurable as head-on, and the camera cannot tell them apart");
  assertClose(bodyFrame(turnBy(world, 30)).turnDegrees, 30, 1e-6, "and it reports the angle");
});

test("the forward axis comes out of the chest, not the back", () => {
  // +z is away from the camera, so a body facing the lens has a chest normal
  // with negative z. Get this backwards and every measurability call inverts.
  const f = bodyFrame(fixture("mountain").variants.correct.world);
  assert(f.forward.z < 0, `forward.z = ${f.forward.z}`);
});

test("scoring in the body frame is a no-op, which is why we do not", () => {
  // toBodyFrame exists for things that are not angles. Angles are already
  // rotation-invariant, so routing them through it would burn a matrix multiply
  // per landmark per frame to arrive at the same eight numbers. Proving that
  // here is cheaper than believing it.
  const v = fixture("warrior1").variants.correct;
  const camera = computeAngles(v.world, v.image, 1280, 720);
  const body = computeAngles(toBodyFrame(v.world), v.image, 1280, 720);
  for (const joint of Object.keys(camera)) {
    assertClose(body[joint], camera[joint], 1e-9, joint);
  }
});

suite("joint measurability");

test("everything is measurable when the user faces the camera", () => {
  for (const key of POSES) {
    const m = jointMeasurability(fixture(key).variants.correct.world);
    for (const [joint, r] of Object.entries(m)) {
      assert(r.measurable, `${key} ${joint} share ${r.depthShare.toFixed(2)}`);
      assertClose(r.depthShare, 0, 1e-6, `${key} ${joint} lies in the frontal plane`);
    }
  }
});

test("a limb pointing down the camera axis is not measurable", () => {
  // Mountain with the left arm reaching straight at the lens. The elbow angle
  // is then a question about depth alone, which is the one thing we cannot ask.
  const world = fixture("mountain").variants.correct.world.map(p => ({ ...p }));
  const sh = world[LM.left_shoulder];
  world[LM.left_elbow]  = { ...sh, z: sh.z - 0.28 };
  world[LM.left_wrist]  = { ...sh, z: sh.z - 0.54 };
  const m = jointMeasurability(world);
  assert(!m.left_elbow.measurable, `elbow share ${m.left_elbow.depthShare.toFixed(2)}`);
  assert(!m.left_shoulder.measurable, `shoulder share ${m.left_shoulder.depthShare.toFixed(2)}`);
  assert(m.right_elbow.measurable, "the other arm is untouched");
  assert(m.left_knee.measurable, "and so are the legs");
});

test("a collapsed segment is treated as unmeasurable, not as an angle", () => {
  const world = fixture("mountain").variants.correct.world.map(p => ({ ...p }));
  world[LM.left_wrist] = { ...world[LM.left_elbow] };
  assert(!jointMeasurability(world).left_elbow.measurable, "no segment, no angle");
});

test("the depth share is bounded, so the gate cannot be tripped by scale", () => {
  for (const key of POSES) {
    for (const variantName of ["correct", "turned", "edgeOn", "partial"]) {
      const m = jointMeasurability(fixture(key).variants[variantName].world);
      for (const [joint, r] of Object.entries(m)) {
        assert(r.depthShare >= 0 && r.depthShare <= 1 + 1e-9,
          `${key}/${variantName} ${joint} = ${r.depthShare}`);
      }
    }
  }
});

suite("scoring");

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
  const m = matchSinglePose(angles, YOGA_POSES.tree.angles);
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
