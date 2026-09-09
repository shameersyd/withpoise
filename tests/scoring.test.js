import { suite, test, assert, assertEqual, assertClose, assertDeepEqual, assertSameSet } from "./harness.js";
import {
  LM, computeAngles, matchSinglePose, reliableLandmarks, correctionsFor, calcAngle,
  bodyFrame, toBodyFrame, jointMeasurability, v3, TURN_LIMIT_DEGREES, facingWrongWay,
  jointQuality, VerdictLatch, FALLOFF_MARGIN,
  sidesOf, mirrorPose, mirrorRig, mirrorJoint, mirrorText, SideSelector, buildReference,
} from "../yoga_app/pose-core.js";
import { YOGA_POSES, CORRECTION_TIPS } from "./poses.js";

suite("scoring");

const POSES = Object.keys(YOGA_POSES);
const fixture = (key) => JSON.parse(readFile(`tests/fixtures/${key}.json`));

/** What the app does with one fixture variant, end to end. */
function score(key, variantName) {
  const v = fixture(key).variants[variantName];
  const reliable = reliableLandmarks(v.image);
  const angles = computeAngles(v.world, v.image, 1280, 720);
  const measurability = jointMeasurability(v.world);
  const match = matchSinglePose(angles, YOGA_POSES[key].angles,
    { reliable, measurability, weights: YOGA_POSES[key].weights });
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
// What one bent shin costs, per pose. These differ because the joint's weight
// differs: the same fault is worth more in Tree, where the standing leg is the
// pose, than in Mountain, where it is one of four equally weighted essentials.
// What one bent shin costs, per pose. Downward Dog barely notices, and that is
// the weights doing their job: its own tips say to bend the knees if you need
// to, so its knee carries a wide tolerance and the least weight in the pose.
const FAULT_SCORE = { mountain: 83.33, warrior1: 87.85, warrior2: 87.85,
                      tree: 80.00, downdog: 95.95 };

for (const key of POSES.filter(k => k !== "triangle")) {
  test(`${key}: a bent shin fails that knee and only that knee`, () => {
    const r = score(key, "fault");
    assertDeepEqual(failing(r), [r.meta.fault.joint], "failing joints");
    assertEqual(r.scored, 8, "all eight still scored");
    assertEqual(r.coverage, 1, "and all eight still counted");
    assertClose(r.score, FAULT_SCORE[key], 0.01, "score");
  });

  test(`${key}: the fault emits exactly the expected instruction`, () => {
    const r = score(key, "fault");
    assertDeepEqual(r.corrections.map(c => c.text), [r.meta.fault.expectCorrection]);
  });
}

test("triangle: a fault that leaves the frame is reported as unseen, not as perfect", () => {
  // Bending Triangle's front shin swings the ankle out of the frame, so the
  // knee cannot be judged at all. It used to be dropped from the denominator
  // and the score rose from 87.5 to 100 — doing the pose worse scored better.
  //
  // A score is now a fraction of what was judged *and carries how much that
  // was*. The number is still 100 because everything visible really is correct,
  // which is the honest answer; coverage is what says not to trust it, and the
  // UI withholds "Perfect form" on the strength of it.
  const r = score("triangle", "fault");
  assertEqual(r.score, 100, "everything that could be seen was right");
  assertDeepEqual(r.unscored, ["left_knee"], "and the faulted joint could not be");
  assert(r.coverage < 0.85, `coverage ${(r.coverage * 100).toFixed(0)}% must show the gap`);
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

  test(`${key}: a half-visible body reports how little it could see`, () => {
    // The score is still 100 — the visible half really is correct, and marking
    // it down for the size of the user's room would be its own lie. What used
    // to be missing is any sign that half the pose was never looked at.
    // Coverage carries that, and it is what stops the UI saying "Perfect form".
    const r = score(key, "partial");
    assertEqual(r.score, 100, "what was judged was correct");
    assert(r.coverage <= 0.5, `coverage ${(r.coverage * 100).toFixed(0)}%`);
    assert(r.coverage > 0, "but something was judged");
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
  test(`${key}: 30° off the right view scores the same as standing in it`, () => {
    const ideal = score(key, "correct");
    const turned = score(key, "turned");
    assertClose(turned.score, ideal.score, 0.001, "score");
    assertDeepEqual(turned.corrections, [], "no invented faults");
  });
}

for (const key of POSES.filter(k => YOGA_POSES[k].view === "front")) {
  test(`${key}: 30° off-axis still judges every joint`, () => {
    const turned = score(key, "turned");
    assertEqual(turned.scored, 8, "joints judged");
    assertDeepEqual(turned.uncertain, [], "nothing written off as unmeasurable");
  });
}

test("Downward Dog 30° off its view loses the plane it lives in, and says so", () => {
  // The reverse of every front pose, and the whole reason a pose declares a
  // view. Turning towards the camera is what destroys this one.
  const turned = score("downdog", "turned");
  assert(turned.uncertain.length >= 4, `only ${turned.uncertain.length} joints written off`);
  assert(turned.coverage < 0.6, `coverage ${(turned.coverage * 100).toFixed(0)}%`);
  assertDeepEqual(turned.corrections, [], "but nothing is invented out of it");
});

test("Downward Dog seen the right way is fully judged, depth loss and all", () => {
  // Side-on is the worst possible view for depth — the fixture compresses it to
  // 0.39x — and this pose is completely legible there anyway, because every
  // angle it cares about lies in the plane the camera can still see.
  const r = score("downdog", "correct");
  assertEqual(r.score, 100, "score");
  assertEqual(r.coverage, 1, "every joint judged");
  assertDeepEqual(r.uncertain, [], "none written off");
  assert(r.frame.turnDegrees > 80, `and it reads as side-on: ${r.frame.turnDegrees.toFixed(0)}°`);
});

// Edge-on, the body's frontal plane is gone and its sagittal plane is if
// anything clearer than before. What survives is judged; what does not is named
// rather than guessed at. Nothing here scores as a fault: the user is holding
// every one of these correctly.
const EDGE_ON_UNCERTAIN = {
  // Downward Dog turned towards the camera loses the sagittal plane it lives in,
  // which is the reverse of every other pose here and the reason `view` exists.
  downdog: ["left_hip", "right_hip", "left_knee", "right_knee"],
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

test("standing the wrong way for the pose is reported as a turn to make", () => {
  // "Wrong way" is not one direction. A front pose goes wrong by turning away
  // from the camera; Downward Dog goes wrong by turning towards it.
  for (const key of POSES) {
    const r = score(key, "edgeOn");
    assert(facingWrongWay(YOGA_POSES[key].view, r.frame.turnDegrees),
      `${key} reads ${r.frame.turnDegrees.toFixed(0)}° and no warning fires`);
  }
  for (const key of POSES) {
    const r = score(key, "turned");
    assert(!facingWrongWay(YOGA_POSES[key].view, r.frame.turnDegrees),
      `${key} at 30° off should not warn, reads ${r.frame.turnDegrees.toFixed(0)}°`);
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

test("every pose is measurable in the view it asks for", () => {
  // Including Downward Dog, which asks to be seen from the side — the angle at
  // which a monocular camera knows least about depth, and the only angle at
  // which this pose has any shape to read.
  for (const key of POSES) {
    const m = jointMeasurability(fixture(key).variants.correct.world);
    for (const [joint, r] of Object.entries(m)) {
      assert(r.measurable, `${key} ${joint} share ${r.depthShare.toFixed(2)}`);
    }
  }
});

test("a front pose seen head-on has no depth component at all", () => {
  for (const key of POSES.filter(k => YOGA_POSES[k].view === "front")) {
    const m = jointMeasurability(fixture(key).variants.correct.world);
    for (const [joint, r] of Object.entries(m)) {
      assertClose(r.depthShare, 0, 1e-6, `${key} ${joint} lies in the frontal plane`);
    }
  }
});

test("a side pose seen side-on has almost none either", () => {
  // Not exactly zero — the shoulders and hips are separated along the camera
  // axis, so the segments that reach them are very slightly out of plane. The
  // margin to the 0.65 limit is what matters, and it is enormous.
  const m = jointMeasurability(fixture("downdog").variants.correct.world);
  for (const [joint, r] of Object.entries(m)) {
    assert(r.depthShare < 0.1, `${joint} share ${r.depthShare.toFixed(3)}`);
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

// ─────────────────────────────────────────────────────────────
// Grading
// ─────────────────────────────────────────────────────────────
suite("graded scoring");

test("a joint inside its tolerance is simply correct", () => {
  assertEqual(jointQuality(0, 20), 1);
  assertEqual(jointQuality(19.9, 20), 1);
  assertEqual(jointQuality(20, 20), 1, "the boundary is inside");
});

test("quality falls off smoothly instead of over a cliff", () => {
  const tol = 20, margin = FALLOFF_MARGIN;
  const at = (diff) => jointQuality(diff, tol, margin);

  assert(at(21) > 0.99, `one degree out is still nearly right, got ${at(21).toFixed(3)}`);
  assertEqual(at(tol + margin), 0, "and past the margin it is worth nothing");
  assertEqual(at(tol + margin + 50), 0, "with no negative scores");

  // Monotonic, and no step anywhere along it — the property the old boolean
  // could not have, and the reason the percentage used to move in eighths.
  let prev = 1;
  for (let d = tol; d <= tol + margin; d += 0.5) {
    const q = at(d);
    assert(q <= prev + 1e-12, `not monotonic at ${d}°`);
    assert(prev - q < 0.05, `a step of ${(prev - q).toFixed(3)} at ${d}°`);
    prev = q;
  }
});

test("the falloff is flat where it meets both ends", () => {
  // Smoothstep, not a straight line: a kink at the tolerance boundary would put
  // the jumpiness back, one derivative further down.
  const slope = (d) => (jointQuality(d + 0.01, 20) - jointQuality(d - 0.01, 20)) / 0.02;
  assert(Math.abs(slope(20.5)) < 0.01, `slope at the tolerance edge: ${slope(20.5)}`);
  assert(Math.abs(slope(44.5)) < 0.01, `slope at the far edge: ${slope(44.5)}`);
  assert(Math.abs(slope(32.5)) > 0.04, "and it does actually fall in between");
});

test("a zero margin is the old cliff, for anyone who wants it back", () => {
  assertEqual(jointQuality(20, 20, 0), 1);
  assertEqual(jointQuality(20.1, 20, 0), 0);
});

test("weights decide how much a joint is the pose", () => {
  const template = { left_knee: [175, 20], left_elbow: [175, 20] };
  const angles = { left_knee: 175, left_elbow: 100 };   // elbow far outside its margin

  const even = matchSinglePose(angles, template);
  const knee = matchSinglePose(angles, template, { weights: { left_knee: 4, left_elbow: 1 } });
  const elbow = matchSinglePose(angles, template, { weights: { left_knee: 1, left_elbow: 4 } });

  assertEqual(even.score, 50, "unweighted, a bent elbow is half the pose");
  assertEqual(knee.score, 80, "weighted toward the leg it barely registers");
  assertEqual(elbow.score, 20, "weighted toward the arm it dominates");
});

test("a joint missing from the weights map still counts once", () => {
  const template = { left_knee: [175, 20], left_elbow: [175, 20] };
  const angles = { left_knee: 175, left_elbow: 100 };
  assertEqual(matchSinglePose(angles, template, { weights: { left_knee: 1 } }).score, 50);
});

test("coverage is measured in weight, not in joints", () => {
  // Losing Tree's standing leg costs far more coverage than losing a wrist,
  // which is the whole reason coverage is weighted rather than counted.
  const angles = Object.fromEntries(
    Object.entries(YOGA_POSES.tree.angles).map(([j, [t]]) => [j, t]));
  const all = new Set(Object.keys(LM));
  const without = (name) => { const r = new Set(all); r.delete(name); return r; };
  const opts = (reliable) => ({ reliable, weights: YOGA_POSES.tree.weights });

  assertEqual(matchSinglePose(angles, YOGA_POSES.tree.angles, opts(all)).coverage, 1);

  const noAnkle = matchSinglePose(angles, YOGA_POSES.tree.angles, opts(without("left_ankle")));
  const noWrist = matchSinglePose(angles, YOGA_POSES.tree.angles, opts(without("left_wrist")));
  assert(noAnkle.coverage < noWrist.coverage,
    `standing leg ${noAnkle.coverage.toFixed(2)} should cost more than a wrist ${noWrist.coverage.toFixed(2)}`);
});

suite("verdict latching");

const resultAt = (quality) => ({ left_knee: { quality, ok: quality >= 0.95 } });

test("a joint must be clearly right to go green and clearly wrong to go red", () => {
  const latch = new VerdictLatch();
  assertEqual(latch.apply(resultAt(1)).left_knee.ok, true, "clearly right");
  assertEqual(latch.apply(resultAt(0.8)).left_knee.ok, true, "drifting, but holds green");
  assertEqual(latch.apply(resultAt(0.6)).left_knee.ok, true, "still holds");
  assertEqual(latch.apply(resultAt(0.4)).left_knee.ok, false, "clearly wrong now");
  assertEqual(latch.apply(resultAt(0.7)).left_knee.ok, false, "and holds red on the way back");
  assertEqual(latch.apply(resultAt(0.99)).left_knee.ok, true, "until it is clearly right again");
});

test("a joint sitting exactly on its tolerance does not strobe", () => {
  // The failure this exists for: quality hovering either side of the threshold
  // at frame rate used to repaint the whole limb every frame.
  const latch = new VerdictLatch();
  latch.apply(resultAt(1));
  let flips = 0, last = true;
  for (let i = 0; i < 60; i++) {
    const q = 0.75 + (i % 2 ? 0.08 : -0.08);   // jittering across the old boundary
    const now = latch.apply(resultAt(q)).left_knee.ok;
    if (now !== last) flips++;
    last = now;
  }
  assertEqual(flips, 0, "sixty frames of jitter, no repaint");
});

test("the first frame falls back to the raw verdict", () => {
  assertEqual(new VerdictLatch().apply(resultAt(0.7)).left_knee.ok, false,
    "nothing latched yet, so believe the threshold");
});

test("a joint that drops out for a frame keeps its state", () => {
  const latch = new VerdictLatch();
  latch.apply(resultAt(1));
  latch.apply({});                                   // occluded — not in results at all
  assertEqual(latch.apply(resultAt(0.7)).left_knee.ok, true, "came back green, not red");
});

test("resetting clears every latch", () => {
  const latch = new VerdictLatch();
  latch.apply(resultAt(1));
  latch.reset();
  assertEqual(latch.apply(resultAt(0.7)).left_knee.ok, false, "a new session starts clean");
});

test("latching leaves the numbers alone", () => {
  const out = new VerdictLatch().apply({
    left_knee: { quality: 0.8, ok: false, diff: 24, target: 175 } });
  assertEqual(out.left_knee.diff, 24, "still there");
  assertEqual(out.left_knee.target, 175);
  assertEqual(out.left_knee.quality, 0.8, "the graded value is untouched");
});

// ─────────────────────────────────────────────────────────────
// Sides
// ─────────────────────────────────────────────────────────────
suite("mirroring");

const ASYMMETRIC = POSES.filter(k => !YOGA_POSES[k].symmetric);

test("the symmetric poses are the ones that are the same on both sides", () => {
  assertDeepEqual(POSES.filter(k => YOGA_POSES[k].symmetric).sort(), ["downdog", "mountain"]);
  assertEqual(sidesOf(YOGA_POSES.mountain).length, 1, "nothing to mirror");
  for (const key of ASYMMETRIC) {
    assertEqual(sidesOf(YOGA_POSES[key]).length, 2, `${key} has two sides`);
  }
});

test("the mirrored rig builds the mirrored figure", () => {
  // buildReference pins the hips at x = 0.5, so mirroring the rig has to come
  // out as a reflection of the figure about that line, with the left and right
  // labels swapped. If this holds, the demo drawing, the target outline and the
  // scoring targets are all mirrored consistently — they are all built here.
  for (const key of ASYMMETRIC) {
    const original = buildReference(YOGA_POSES[key].rig);
    const mirrored = buildReference(mirrorRig(YOGA_POSES[key].rig));
    for (const name of Object.keys(original)) {
      const there = mirrored[mirrorJoint(name)];
      assertClose(there.x, 1 - original[name].x, 1e-9, `${key} ${name}.x`);
      assertClose(there.y, original[name].y, 1e-9, `${key} ${name}.y`);
      assertClose(there.z, original[name].z, 1e-9, `${key} ${name}.z`);
    }
  }
});

test("mirroring twice is the original pose", () => {
  for (const key of POSES) {
    const there = mirrorPose(YOGA_POSES[key]);
    const back = mirrorPose(there);
    assertDeepEqual(back.angles, YOGA_POSES[key].angles, `${key} angles`);
    assertDeepEqual(back.weights, YOGA_POSES[key].weights, `${key} weights`);
    assertDeepEqual(back.steps.map(s => s.text), YOGA_POSES[key].steps.map(s => s.text),
      `${key} instructions`);
    assertEqual(back.side, YOGA_POSES[key].side, `${key} side label`);
  }
});

test("targets and weights swap sides together", () => {
  const w1 = YOGA_POSES.warrior1, m = mirrorPose(w1);
  assertDeepEqual(m.angles.right_knee, w1.angles.left_knee, "the bent knee changes leg");
  assertDeepEqual(m.angles.left_knee, w1.angles.right_knee, "so does the straight one");
  assertEqual(m.weights.right_knee, w1.weights.left_knee, "and the weight goes with it");
});

test("the instructions say the other side", () => {
  const m = mirrorPose(YOGA_POSES.warrior1);
  assert(m.steps[0].text.includes("left foot back"), m.steps[0].text);
  assert(m.steps[1].text.includes("right (front) knee"), m.steps[1].text);
  assertDeepEqual(m.steps[0].focus, ["left_leg"], "and so does the highlight");
});

test("mirrorText swaps whole words only, keeping case", () => {
  assertEqual(mirrorText("Left hand to your right shin"), "Right hand to your left shin");
  assertEqual(mirrorText("LEFT and Right"), "RIGHT and Left");
  assertEqual(mirrorText("leftover birthright"), "leftover birthright", "not inside words");
  assertEqual(mirrorText("left-hand side"), "right-hand side", "hyphens are boundaries");
});

test("a body doing the other side scores the mirrored pose, not the written one", () => {
  // The whole point. Reflect a correct fixture — swap the left and right
  // landmarks and negate x, which is what a person turning round does — and the
  // written side should reject it while the mirror accepts it.
  for (const key of ASYMMETRIC) {
    const v = fixture(key).variants.correct;
    const flip = (pts) => {
      const out = pts.map(p => ({ ...p, x: -p.x }));
      for (const name of Object.keys(LM)) {
        const other = mirrorJoint(name);
        if (other !== name) out[LM[other]] = { ...pts[LM[name]], x: -pts[LM[name]].x };
      }
      return out;
    };
    const angles = computeAngles(flip(v.world), v.image, 1280, 720);
    const [written, mirrored] = sidesOf(YOGA_POSES[key]);

    const asWritten = matchSinglePose(angles, written.angles, { weights: written.weights });
    const asMirrored = matchSinglePose(angles, mirrored.angles, { weights: mirrored.weights });

    assertEqual(asMirrored.score, 100, `${key}: the mirror is a perfect match`);
    assert(asWritten.score < 80,
      `${key}: the written side should not accept it, scored ${asWritten.score.toFixed(1)}`);
  }
});

suite("side selection");

const cand = (a, b) => [{ key: "written", score: a }, { key: "mirrored", score: b }];

test("the first frame simply takes the better side", () => {
  assertEqual(new SideSelector().pick(cand(40, 90), 0), "mirrored");
});

test("a side has to win by a margin, and hold it, before it takes over", () => {
  const sel = new SideSelector({ margin: 8, holdMs: 700 });
  assertEqual(sel.pick(cand(90, 40), 0), "written");
  assertEqual(sel.pick(cand(80, 85), 100), "written", "five points is not a margin");
  assertEqual(sel.pick(cand(40, 90), 200), "written", "a clear lead, but only just arrived");
  assertEqual(sel.pick(cand(40, 90), 800), "written", "still inside the hold");
  assertEqual(sel.pick(cand(40, 90), 901), "mirrored", "held long enough");
});

test("a challenge that lapses does not accumulate", () => {
  // Coming up out of one side and down into the other passes through a moment
  // where the wrong side leads. That must not count toward a switch.
  const sel = new SideSelector({ margin: 8, holdMs: 700 });
  sel.pick(cand(90, 40), 0);
  sel.pick(cand(40, 90), 100);           // challenger appears
  sel.pick(cand(90, 40), 300);           // and loses its lead again
  assertEqual(sel.pick(cand(40, 90), 700), "written", "the clock restarted");
  assertEqual(sel.pick(cand(40, 90), 1000), "written", "still counting from 300ms");
  assertEqual(sel.pick(cand(40, 90), 1500), "mirrored");
});

test("scores rattling within the margin never switch sides", () => {
  const sel = new SideSelector();
  assertEqual(sel.pick(cand(70, 60), 0), "written");
  for (let t = 1; t < 200; t++) {
    const jitter = (t % 2) ? 6 : -6;
    assertEqual(sel.pick(cand(70, 70 + jitter), t * 33), "written", `frame ${t}`);
  }
});

test("resetting forgets the side", () => {
  const sel = new SideSelector();
  sel.pick(cand(90, 40), 0);
  sel.reset();
  assertEqual(sel.pick(cand(40, 90), 1), "mirrored", "a new session picks afresh");
});

// ─────────────────────────────────────────────────────────────
// The one thing about the overlay that can be checked from here
// ─────────────────────────────────────────────────────────────
suite("overlay mapping");

test("the video and the overlay canvas are fitted to the screen the same way", () => {
  // Not a unit test so much as a tripwire. The video and the canvas are two
  // replaced elements sharing an intrinsic size, and everything the app draws
  // assumes they map to the screen identically. They did not: the video was
  // object-fit: cover and the canvas, with none, was stretched — so on any
  // phone whose aspect ratio differed from the camera's, every landmark and
  // every correction arrow was drawn somewhere the body was not, while looking
  // perfect in a 16:9 desktop window.
  //
  // Nothing here can render CSS, so this reads the rule and asserts the two
  // selectors are still styled as one block. Crude, and it would have caught
  // the bug.
  // Comments carry commas, which would otherwise read as selector lists.
  const css = readFile("yoga_app/index.html").replace(/\/\*[\s\S]*?\*\//g, "");

  // Every rule whose selector list names either element on its own.
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(m => ({ selectors: m[1].split(",").map(x => x.trim()), body: m[2] }))
    .filter(b => b.selectors.includes("#video") || b.selectors.includes("#canvas"));

  assertEqual(blocks.length, 1, "the two must be styled by exactly one rule");
  assertSameSet(blocks[0].selectors, ["#video", "#canvas"],
    "and that rule must cover both of them");
  assert(/object-fit:\s*cover/.test(blocks[0].body),
    "which must set object-fit: cover, matching how the video is fitted");
});

test("the service worker precaches every module the app imports", () => {
  // This list has fallen behind twice: once when the scoring core was split out
  // of index.html, and once when the coaching modules were added. Both times
  // the symptom would have been a first offline visit loading an index.html
  // whose imports 404, which is not something a unit test would otherwise see.
  const html = readFile("yoga_app/index.html");
  const sw = readFile("yoga_app/sw.js");

  const imported = [...html.matchAll(/from\s+"\.\/([\w.-]+\.js)"/g)].map(m => m[1]);
  assert(imported.length >= 4, `expected several local imports, found ${imported.length}`);

  const assets = sw.slice(sw.indexOf("const ASSETS"), sw.indexOf("];", sw.indexOf("const ASSETS")));
  for (const file of imported) {
    assert(assets.includes(file), `sw.js does not precache ${file}`);
  }

  // The worker's own imports ride along on the same list.
  const workerImports = [...readFile("yoga_app/pose-worker.js")
    .matchAll(/from\s+"\.\/([\w.-]+\.js)"/g)].map(m => m[1]);
  for (const file of workerImports) {
    assert(assets.includes(file), `sw.js does not precache ${file}, needed by the worker`);
  }
});

test("the service worker's asset paths are relative to its own scope", () => {
  // "/index.html" is only correct at a domain root. Under a subpath — a project
  // page, a preview deploy, a shared folder — addAll rejects and takes the
  // whole install down with it, so the app never caches anything at all.
  const sw = readFile("yoga_app/sw.js");
  const list = sw.slice(sw.indexOf("const ASSETS"), sw.indexOf("];", sw.indexOf("const ASSETS")));
  const paths = [...list.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  assert(paths.length > 3, `expected an asset list, found ${paths.length} entries`);
  for (const path of paths) {
    assert(!path.startsWith("/"), `${path} is host-absolute`);
  }
  assert(!/caches\.match\("\//.test(sw), "the navigation fallback is host-absolute too");
});

test("the runtime cache is versioned apart from the app shell", () => {
  // They must not share a version. The runtime cache holds a 9-30 MB model, and
  // tying it to the app version would re-download that on every deploy.
  const sw = readFile("yoga_app/sw.js");
  const app = sw.match(/APP_CACHE\s*=\s*"([^"]+)"/);
  const runtime = sw.match(/RUNTIME_CACHE\s*=\s*"([^"]+)"/);
  assert(app && runtime, "both caches must be named");
  const version = (name) => name.slice(name.lastIndexOf("-v"));
  assert(app[1] !== runtime[1], "the two caches must have different names");
  assert(version(app[1]) !== version(runtime[1]),
    `both caches are at ${version(app[1])}, so bumping the app evicts the model`);
});

test("a joint weighted zero is left out of the pose entirely", () => {
  // Not just left out of the average: a joint the pose does not care about must
  // not colour the outline red or produce an instruction either.
  const template = { left_knee: [175, 20], left_elbow: [175, 20] };
  const angles = { left_knee: 175, left_elbow: 90 };   // elbow wildly wrong

  const counted = matchSinglePose(angles, template, { weights: { left_elbow: 1 } });
  assertEqual(counted.score, 50, "with a weight it drags the score down");
  assertEqual(counted.scored, 2);

  const ignored = matchSinglePose(angles, template, { weights: { left_elbow: 0 } });
  assertEqual(ignored.score, 100, "without one it is not scored");
  assertEqual(ignored.scored, 1, "nor counted");
  assertEqual(ignored.coverage, 1, "nor missed from coverage");
  assert(!("left_elbow" in ignored.results), "nor available to be corrected");
  assertDeepEqual(correctionsFor(ignored.results, CORRECTION_TIPS), []);
});
