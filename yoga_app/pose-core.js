/**
 * Pose scoring core.
 *
 * Every pure function the app scores with lives here: landmark indexing, joint
 * angle math, the reliability test, the rig-to-figure geometry, and the match
 * itself. Nothing in this file touches the DOM, a canvas or a worker, which is
 * what lets `tests/` import it and pin its behaviour down.
 *
 * Coordinate spaces — these are not interchangeable and mixing them is the
 * easiest way to break this app:
 *
 *   image landmarks   x,y normalized to [0,1] over the video frame, z a
 *                     relative depth in roughly the same scale as x, plus
 *                     `visibility`. Says where the body is *in the picture*.
 *                     Framing, drawing and limb measurement use these.
 *
 *   world landmarks   metres, origin at the hip midpoint, axes aligned to the
 *                     camera. Says what shape the body *is*. Joint angles use
 *                     these.
 */

// ─────────────────────────────────────────────────────────────
// Landmark Indices
// ─────────────────────────────────────────────────────────────
export const LM = {
  nose: 0,
  left_shoulder: 11, right_shoulder: 12,
  left_elbow: 13, right_elbow: 14,
  left_wrist: 15, right_wrist: 16,
  left_hip: 23, right_hip: 24,
  left_knee: 25, right_knee: 26,
  left_ankle: 27, right_ankle: 28,
};

export const SKELETON = [
  ["left_shoulder","right_shoulder"],
  ["left_shoulder","left_elbow"],["left_elbow","left_wrist"],
  ["right_shoulder","right_elbow"],["right_elbow","right_wrist"],
  ["left_shoulder","left_hip"],["right_shoulder","right_hip"],
  ["left_hip","right_hip"],
  ["left_hip","left_knee"],["left_knee","left_ankle"],
  ["right_hip","right_knee"],["right_knee","right_ankle"],
];

// Below this visibility a landmark is a guess, not a measurement. The worker
// imports this too, so the `held` flag it sets and the `reliable` set computed
// here can never drift apart.
export const VIS_THRESHOLD = 0.5;

// ─────────────────────────────────────────────────────────────
// Angle Calculation
// ─────────────────────────────────────────────────────────────
/**
 * Angle at b between ba and bc, in 3D. Measuring in the image plane alone made
 * every angle depend on where the camera stood — a limb pointing towards the
 * lens looked bent no matter how straight it was. Including z removes that.
 */
export function calcAngle(a, b, c) {
  const ba = [a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0)];
  const bc = [c.x - b.x, c.y - b.y, (c.z ?? 0) - (b.z ?? 0)];
  const dot = ba[0]*bc[0] + ba[1]*bc[1] + ba[2]*bc[2];
  const magBA = Math.sqrt(ba[0]**2 + ba[1]**2 + ba[2]**2);
  const magBC = Math.sqrt(bc[0]**2 + bc[1]**2 + bc[2]**2);
  // Floor the divisor rather than padding it: adding an epsilon to the product
  // shrinks every cosine slightly, and by an amount that depends on how long
  // the limbs are, so a straight limb read 179.9° in pixels and 179.7° in
  // metres. Against targets that are mostly 175° that is a standing bias
  // toward "slightly bent". A floor leaves real magnitudes untouched and still
  // yields the same 90° for a degenerate zero-length segment.
  let cosAngle = dot / Math.max(magBA * magBC, 1e-12);
  cosAngle = Math.max(-1, Math.min(1, cosAngle));
  return Math.acos(cosAngle) * (180 / Math.PI);
}

// Which three landmarks form each scored joint angle.
export const ANGLE_JOINTS = {
  left_elbow:     ["left_shoulder", "left_elbow", "left_wrist"],
  right_elbow:    ["right_shoulder", "right_elbow", "right_wrist"],
  left_shoulder:  ["left_elbow", "left_shoulder", "left_hip"],
  right_shoulder: ["right_elbow", "right_shoulder", "right_hip"],
  left_hip:       ["left_shoulder", "left_hip", "left_knee"],
  right_hip:      ["right_shoulder", "right_hip", "right_knee"],
  left_knee:      ["left_hip", "left_knee", "left_ankle"],
  right_knee:     ["right_hip", "right_knee", "right_ankle"],
};

/**
 * Joint angles from a landmark array. Prefers MediaPipe's world landmarks:
 * they are metric and hip-centred, so the angles are anatomical rather than a
 * projection. Falls back to image landmarks scaled to pixels, which at least
 * keeps the three axes in comparable units.
 */
export function computeAngles(world, image, w, h) {
  let points;
  if (world) {
    points = (n) => world[LM[n]];
  } else {
    points = (n) => {
      const lm = image[LM[n]];
      return { x: lm.x * w, y: lm.y * h, z: (lm.z ?? 0) * w };
    };
  }

  const out = {};
  for (const [joint, [a, b, c]] of Object.entries(ANGLE_JOINTS)) {
    out[joint] = calcAngle(points(a), points(b), points(c));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Reliability
// ─────────────────────────────────────────────────────────────
/**
 * Landmarks we can actually trust this frame: confidently seen, not a held-over
 * guess, and inside the frame. Everything else is greyed out rather than scored.
 */
export function reliableLandmarks(landmarks) {
  const reliable = new Set();
  for (const name of Object.keys(LM)) {
    const lm = landmarks[LM[name]];
    if (!lm) continue;
    if (lm.held) continue;
    if ((lm.visibility ?? 1) < VIS_THRESHOLD) continue;
    if (lm.x < -0.02 || lm.x > 1.02 || lm.y < -0.02 || lm.y > 1.02) continue;
    reliable.add(name);
  }
  return reliable;
}

// ─────────────────────────────────────────────────────────────
// Pose Matching (single pose)
// ─────────────────────────────────────────────────────────────
// How far beyond its tolerance a joint has to go before it counts for nothing.
// Inside tolerance a joint is simply correct; past tolerance + margin it is
// simply wrong; in between the score slides.
export const FALLOFF_MARGIN = 25;

/**
 * How right a joint is, from 1 to 0.
 *
 * The old answer was a boolean, and the boundary showed. A knee resting on its
 * tolerance flipped the outline red and green frame to frame, and each flip
 * moved the total by a full eighth. Worse, it made every degree inside the
 * tolerance worth nothing and the first degree outside it worth everything,
 * which is not how a body works.
 *
 * Smoothstep rather than a straight line, so the curve is flat where it meets 1
 * and flat where it meets 0: no kink at either end for the score to catch on.
 */
export function jointQuality(diff, tolerance, margin = FALLOFF_MARGIN) {
  if (diff <= tolerance) return 1;
  if (margin <= 0) return 0;
  const t = Math.min(1, (diff - tolerance) / margin);
  return 1 - t * t * (3 - 2 * t);
}

/**
 * Score only the joints we can actually judge. A joint is set aside for one of
 * two different reasons, and the difference matters to the user:
 *
 *   unscored   its landmarks are off-screen or occluded — "step back"
 *   uncertain  it is pointing down the camera axis — "turn side-on"
 *
 * Neither helps nor hurts the score. That is what lets tracking carry on with
 * your feet out of shot, and what stops the app inventing a fault out of the
 * one coordinate it cannot see.
 *
 * Joints carry weights, because they are not equally the pose. Tree is about a
 * straight standing leg and level hips; the elbow is decoration. An unweighted
 * mean says otherwise and lets a good pose be dragged down by a detail.
 *
 * `coverage` is the share of the pose's total weight that was actually judged.
 * A score is a fraction of what could be seen, so without coverage beside it a
 * user with their legs out of frame reads 100% for holding half a pose.
 *
 * opts: { reliable: Set<string>, measurability: object,
 *         weights: { [joint]: number }, margin: number }
 */
export function matchSinglePose(angles, template, opts = {}) {
  const { reliable = null, measurability = null, weights = null,
          margin = FALLOFF_MARGIN } = opts;
  const results = {};
  const unscored = [];
  const uncertain = [];
  const weightOf = (joint) => (weights && weights[joint] != null ? weights[joint] : 1);

  let correct = 0, total = 0;
  let earned = 0, judgedWeight = 0, totalWeight = 0;

  for (const [joint, [target, tolerance]] of Object.entries(template)) {
    if (!(joint in angles)) continue;
    totalWeight += weightOf(joint);

    if (reliable) {
      const needed = ANGLE_JOINTS[joint] || [];
      if (!needed.every(name => reliable.has(name))) {
        unscored.push(joint);
        continue;
      }
    }

    if (measurability && measurability[joint] && !measurability[joint].measurable) {
      uncertain.push(joint);
      continue;
    }

    total++;
    const actual = angles[joint];
    const diff = Math.abs(actual - target);
    const ok = diff <= tolerance;
    const direction = actual - target;
    const quality = jointQuality(diff, tolerance, margin);
    const weight = weightOf(joint);

    results[joint] = { actual, target, tolerance, diff, ok, direction, quality, weight };
    if (ok) correct++;
    earned += quality * weight;
    judgedWeight += weight;
  }

  const score = judgedWeight > 0 ? (earned / judgedWeight) * 100 : 0;
  return {
    score, results, unscored, uncertain, scored: total,
    aligned: correct,
    coverage: totalWeight > 0 ? judgedWeight / totalWeight : 0,
    judgedWeight, totalWeight,
  };
}

// ─────────────────────────────────────────────────────────────
// Camera geometry
//
// World landmarks are metric and hip-centred, but their axes are the camera's:
// x right, y down, z away from the lens. So the pose is described in a frame
// that moves when the user turns, even though the body has not changed shape.
//
// Joint angles are already immune to that — an angle is rotation-invariant, and
// tests/scoring.test.js proves ours is, exactly, for any rigid turn. What is
// *not* immune is the depth axis itself: MediaPipe regresses z from a single
// RGB image, and it is much the least certain of the three. A limb lying along
// the camera axis has its direction decided almost entirely by that number.
//
// That is the real view-dependence, and it cannot be rotated away. What can be
// done is to notice it, and to say "can't tell" instead of scoring a guess.
// ─────────────────────────────────────────────────────────────

export const v3 = {
  sub:   (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) }),
  scale: (a, k) => ({ x: a.x * k, y: a.y * k, z: (a.z ?? 0) * k }),
  dot:   (a, b) => a.x * b.x + a.y * b.y + (a.z ?? 0) * (b.z ?? 0),
  cross: (a, b) => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }),
  len:  (a) => Math.hypot(a.x, a.y, a.z ?? 0),
  unit: (a) => { const n = Math.hypot(a.x, a.y, a.z ?? 0); return n < 1e-12 ? { x: 0, y: 0, z: 0 } : { x: a.x / n, y: a.y / n, z: (a.z ?? 0) / n }; },
  mid:  (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z ?? 0) + (b.z ?? 0)) / 2 }),
};

/**
 * An orthonormal frame rigidly attached to the torso, built from the hip and
 * shoulder vectors:
 *
 *   spine    hips → shoulders, up the body
 *   lateral  right hip → left hip, made perpendicular to the spine
 *   forward  out of the chest
 *
 * `facing` is how squarely the chest points at the lens: 1 when the user is
 * head-on (or backs-on — the camera cannot tell, and for measurability it does
 * not matter), 0 when they are edge-on. `turnDegrees` is the same thing in
 * degrees off-axis, which is what you would say out loud to a person.
 *
 * A body whose hips have collapsed onto each other yields a zero frame, which
 * reads as fully edge-on — the safe direction to fail in, since it makes the
 * app say "I can't see this" rather than score noise.
 */
export function bodyFrame(world) {
  const P = (n) => world[LM[n]];
  const hipC = v3.mid(P("left_hip"), P("right_hip"));
  const shC  = v3.mid(P("left_shoulder"), P("right_shoulder"));

  const spine = v3.unit(v3.sub(shC, hipC));
  const hipAxis = v3.unit(v3.sub(P("left_hip"), P("right_hip")));
  // Gram-Schmidt: the hip axis is not quite perpendicular to the spine on a
  // real body, and the frame has to be orthonormal to be a rotation.
  const lateral = v3.unit(v3.sub(hipAxis, v3.scale(spine, v3.dot(hipAxis, spine))));
  const forward = v3.unit(v3.cross(lateral, spine));

  const facing = Math.min(1, Math.abs(forward.z));
  return {
    origin: hipC, spine, lateral, forward, facing,
    turnDegrees: Math.acos(facing) * 180 / Math.PI,
  };
}

/**
 * Landmarks re-expressed in the body frame: x along the body's lateral axis, y
 * up the spine, z out of the chest, origin at the hips.
 *
 * Deliberately NOT part of the scoring path. Joint angles are rotation-
 * invariant, so scoring them here would produce bit-identical numbers at more
 * cost — the brief's "rotate into a body frame and score in it" is a no-op for
 * angles specifically, and pretending otherwise would be theatre. It is here
 * because anything that is *not* an angle — a segment's direction relative to
 * the hips, say — needs this frame to be comparable between users, and that is
 * the natural next thing to score.
 */
export function toBodyFrame(world, frame) {
  const f = frame || bodyFrame(world);
  return world.map((p) => {
    const d = v3.sub(p, f.origin);
    return { ...p, x: v3.dot(d, f.lateral), y: v3.dot(d, f.spine), z: v3.dot(d, f.forward) };
  });
}

// A segment more than this much aligned with the camera axis has its direction
// decided mostly by the depth estimate, which is the one number a single RGB
// camera does not really know. Angles built on such a segment are not
// measurements.
//
// 0.65 is ~49° off the camera axis, and it is chosen from the requirement
// rather than from taste: the brief asks that a correct pose score the same
// head-on and at 30°, and a limb held straight out to the side is sin(30°) =
// 0.50 aligned with the camera axis at 30° of turn. 0.65 clears that with room
// to spare and starts excluding frontal-plane joints from about 40° of turn,
// which is where their depth genuinely stops being resolvable.
export const AXIS_LIMIT = 0.65;

// Past this much turn the torso itself is edge-on and the user should be told
// to turn, rather than shown a score built out of whatever survived.
export const TURN_LIMIT_DEGREES = 55;

/**
 * Per joint: how much of its angle is being read off the camera's depth axis,
 * and whether that leaves anything worth scoring.
 *
 * The obvious test — take each segment's z share directly — has a hole in it.
 * A monocular landmarker's characteristic failure is to *compress* depth on a
 * turned body, and a compressed z share looks small. The evidence of the error
 * is destroyed by the error. Measured straight, a Triangle held 80° off-axis
 * reports every joint as comfortably measurable and then scores three of them
 * wrong.
 *
 * So the depth component is reconstructed instead, from the two things that
 * survive: the body frame (hips and shoulders, which come from x and y) and
 * the turn angle derived from it. The camera axis expressed in body
 * coordinates is sin(turn) along the lateral axis plus cos(turn) along the
 * forward axis, so
 *
 *     along-camera = sin(turn)·(v·lateral) + cos(turn)·(v·forward)
 *
 * At turn = 0 this is exactly v·forward — the naive z share, which is right
 * when the user faces the lens. At turn = 90° it becomes v·lateral, computed
 * from the axes the camera actually resolves.
 *
 * What falls out is anatomically the right answer: turning side-on destroys
 * the body's frontal plane and preserves its sagittal one. An arm held out to
 * the side becomes unjudgeable; a bent knee becomes *easier* to judge, which
 * is why a physio films a squat from the side.
 */
export function jointMeasurability(world, frame) {
  const f = frame || bodyFrame(world);
  const cosTurn = f.facing;
  const sinTurn = Math.sqrt(Math.max(0, 1 - f.facing * f.facing));

  const depthShare = (v) => {
    const n = v3.len(v);
    if (n < 1e-9) return 1;   // a collapsed segment tells us nothing
    const alongCamera = sinTurn * v3.dot(v, f.lateral) + cosTurn * v3.dot(v, f.forward);
    return Math.abs(alongCamera) / n;
  };

  const out = {};
  for (const [joint, [a, b, c]] of Object.entries(ANGLE_JOINTS)) {
    const pb = world[LM[b]];
    const share = Math.max(
      depthShare(v3.sub(world[LM[a]], pb)),
      depthShare(v3.sub(world[LM[c]], pb)),
    );
    out[joint] = { depthShare: share, measurable: share <= AXIS_LIMIT };
  }
  return out;
}

/**
 * The corrections a match implies, as physical instructions. Pure, and keyed by
 * joint so a caller can throttle or prioritise them rather than just print them.
 *
 * `tips` maps a joint to [ too-small phrasing, too-large phrasing ]. A joint
 * angle grows as the joint straightens, so the first string always fixes an
 * over-bent joint.
 */
export function correctionsFor(jointResults, tips) {
  const out = [];
  for (const [joint, res] of Object.entries(jointResults)) {
    if (res.ok) continue;
    const phrasing = tips[joint];
    if (phrasing) out.push({ joint, text: res.direction < 0 ? phrasing[0] : phrasing[1] });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Sides
//
// Warrior I, Warrior II, Triangle and Tree are asymmetric, and each is written
// out for one side only. A user doing the second half of their practice was
// being scored against the first half's shape: every leg and hip joint wrong,
// corrections telling them to undo a correct pose.
//
// Rather than write each pose twice — two copies to keep in step, and the
// mirror of a pose is not a judgement call — the other side is derived.
// ─────────────────────────────────────────────────────────────

/** left_knee ⇄ right_knee; anything unsided is left alone. */
export function mirrorJoint(name) {
  if (name.startsWith("left_")) return `right_${name.slice(5)}`;
  if (name.startsWith("right_")) return `left_${name.slice(6)}`;
  return name;
}

const mirrorKeys = (obj) =>
  obj && Object.fromEntries(Object.entries(obj).map(([k, v]) => [mirrorJoint(k), v]));

/**
 * Reflect a rig direction across the body's sagittal plane.
 *
 * dirVec is (cos θ cos φ, −sin θ cos φ, sin φ), so flipping x is θ → 180 − θ
 * with φ untouched: the segment keeps its height and its depth and swaps sides.
 * A vertical torso at 90° stays at 90°, which is the sanity check.
 */
export function mirrorDirection(entry) {
  if (Array.isArray(entry)) return [180 - entry[0], entry[1] ?? 0];
  return 180 - entry;
}

const mirrorLimb = (limb) => Object.fromEntries(
  Object.entries(limb).map(([segment, direction]) => [segment, mirrorDirection(direction)]));

export function mirrorRig(rig) {
  return {
    torso: mirrorDirection(rig.torso),
    arm_left:  mirrorLimb(rig.arm_right),
    arm_right: mirrorLimb(rig.arm_left),
    leg_left:  mirrorLimb(rig.leg_right),
    leg_right: mirrorLimb(rig.leg_left),
  };
}

const SWAPS = { left: "right", right: "left", Left: "Right", Right: "Left",
                LEFT: "RIGHT", RIGHT: "LEFT" };

/**
 * Swap the sides named in a sentence. Whole words only, so "left" inside
 * another word is safe, and case is preserved so a sentence still reads.
 */
export function mirrorText(text) {
  return text.replace(/\b(left|right|Left|Right|LEFT|RIGHT)\b/g, (w) => SWAPS[w]);
}

const mirrorPart = (part) =>
  part.startsWith("left_") ? `right_${part.slice(5)}`
  : part.startsWith("right_") ? `left_${part.slice(6)}`
  : part;

/**
 * The same pose, other side. Everything sided moves: the rig, the joint
 * targets, the weights, the body parts each instruction highlights, and the
 * words "left" and "right" in the instructions themselves.
 */
export function mirrorPose(pose) {
  return {
    ...pose,
    // A pose with no side (a symmetric one) keeps none: mirroring it is a
    // no-op and inventing a label for the result would be a lie.
    side: pose.side === "left" ? "right" : pose.side === "right" ? "left" : pose.side,
    rig: mirrorRig(pose.rig),
    angles: mirrorKeys(pose.angles),
    weights: mirrorKeys(pose.weights),
    steps: pose.steps.map((step) => ({
      ...step,
      text: mirrorText(step.text),
      focus: (step.focus || []).map(mirrorPart),
    })),
    tips: pose.tips.map((tip) => ({ ...tip, text: mirrorText(tip.text) })),
  };
}

/**
 * Every side of a pose, the written one first. A symmetric pose has one.
 */
export function sidesOf(pose) {
  return pose.symmetric ? [pose] : [pose, mirrorPose(pose)];
}

/**
 * Which side the user is actually doing.
 *
 * Scoring both and taking the better one is right but not stable: mid-way into
 * a pose the two are within a point of each other and the choice rattles
 * between them, taking the outline and the spoken corrections with it. So a
 * side has to win by a margin and hold it for a beat before it takes over, and
 * the incumbent keeps the pose until then.
 */
export class SideSelector {
  constructor({ margin = 8, holdMs = 700 } = {}) {
    this.margin = margin;
    this.holdMs = holdMs;
    this.reset();
  }

  reset() {
    this.current = null;
    this.challenger = null;
    this.challengerSince = 0;
  }

  /** candidates: [{ key, score }]. Returns the winning key. */
  pick(candidates, now) {
    if (!candidates.length) return null;
    const best = candidates.reduce((a, b) => (b.score > a.score ? b : a));

    if (this.current === null || !candidates.some(c => c.key === this.current)) {
      this.current = best.key;
      this.challenger = null;
      return this.current;
    }

    const held = candidates.find(c => c.key === this.current);
    if (best.key === this.current || best.score <= held.score + this.margin) {
      this.challenger = null;
      return this.current;
    }

    if (this.challenger !== best.key) {
      this.challenger = best.key;
      this.challengerSince = now;
    } else if (now - this.challengerSince >= this.holdMs) {
      this.current = best.key;
      this.challenger = null;
    }
    return this.current;
  }
}

// ─────────────────────────────────────────────────────────────
// Reference Figure — builds a skeleton from a pose rig
// ─────────────────────────────────────────────────────────────
export const SEG_DEFAULT = {
  torso: 0.26, upper: 0.135, fore: 0.135, thigh: 0.20, shin: 0.20,
  shoulderHalf: 0.06, hipHalf: 0.05, neck: 0.12, head: 0.062,
};

/**
 * A direction is `theta`, or `[theta, phi]` to tilt the segment out of the
 * frontal plane (+phi = away from the camera). Theta is degrees in the image
 * plane, 0° pointing right and 90° up.
 *
 * An array here always means [theta, phi] — it used to mean that at the torso
 * and "the two segments of this limb" inside a limb, which is why no limb could
 * express a phi at all and why every pose in the file was planar. Limbs are now
 * objects with named segments.
 *
 * Drawing simply drops z, so the demo figure shows the foreshortening the
 * camera would see, while the joint angles stay three-dimensional.
 */
export function dirVec(entry) {
  const theta = Array.isArray(entry) ? entry[0] : entry;
  const phi = Array.isArray(entry) ? (entry[1] || 0) : 0;
  const t = theta * Math.PI / 180, p = phi * Math.PI / 180;
  return {
    x: Math.cos(t) * Math.cos(p),
    y: -Math.sin(t) * Math.cos(p),   // canvas y grows downward
    z: Math.sin(p),
  };
}

export const along = (from, dist, dir) => ({
  x: from.x + dist * dir.x,
  y: from.y + dist * dir.y,
  z: (from.z || 0) + dist * dir.z,
});

// Head radius travels with the figure it belongs to, so a figure built in pixel
// units (the personalised target outline) keeps a matching head.
const FIGURE_HEAD = new WeakMap();
export const headRadius = (P) => FIGURE_HEAD.get(P) ?? SEG_DEFAULT.head;
export const setHeadRadius = (P, r) => FIGURE_HEAD.set(P, r);

/** A named-point figure as the 33-entry array the angle math expects. */
export function figureLandmarks(P) {
  const out = Array.from({ length: NUM_LANDMARKS }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  for (const name of Object.keys(LM)) {
    const p = P[name];
    if (p) out[LM[name]] = { x: p.x, y: p.y, z: p.z || 0, visibility: 1 };
  }
  return out;
}

export function buildReference(rig, len) {
  const SEG = len || SEG_DEFAULT;
  const hipC = { x: 0.5, y: 0.62, z: 0 };
  const up = dirVec(rig.torso);
  const shC = along(hipC, SEG.torso, up);
  const torsoTheta = Array.isArray(rig.torso) ? rig.torso[0] : rig.torso;
  const perp = dirVec(torsoTheta - 90);   // +perp points to the body's anatomical left
  const P = { nose: along(shC, SEG.neck, up) };

  for (const [side, sgn] of [["left", 1], ["right", -1]]) {
    const sh = along(shC, sgn * SEG.shoulderHalf, perp);
    const hp = along(hipC, sgn * SEG.hipHalf, perp);
    P[`${side}_shoulder`] = sh;
    P[`${side}_hip`] = hp;

    const arm = rig[`arm_${side}`];
    const el = along(sh, SEG.upper, dirVec(arm.upper));
    P[`${side}_elbow`] = el;
    P[`${side}_wrist`] = along(el, SEG.fore, dirVec(arm.fore));

    const leg = rig[`leg_${side}`];
    const kn = along(hp, SEG.thigh, dirVec(leg.thigh));
    P[`${side}_knee`] = kn;
    P[`${side}_ankle`] = along(kn, SEG.shin, dirVec(leg.shin));
  }
  setHeadRadius(P, SEG.head);
  return P;
}

// ─────────────────────────────────────────────────────────────
// Temporal smoothing
//
// Lives here rather than in the worker so it can be tested: it is pure math,
// and it is the step that decides how the corrective arrows feel.
// ─────────────────────────────────────────────────────────────
// One Euro tuning. minCutoff sets the floor of smoothing when still (lower =
// steadier but laggier); beta relaxes it as the joint speeds up (higher = less
// lag when moving). Image landmarks are in 0..1, world landmarks in metres, so
// they get separate constants.
export const TUNING = {
  image: { minCutoff: 1.1, beta: 0.35, dCutoff: 1.0 },
  world: { minCutoff: 1.1, beta: 0.30, dCutoff: 1.0 },
};

export const NUM_LANDMARKS = 33;

// ─────────────────────────────────────────────────────────────
// One Euro Filter
// ─────────────────────────────────────────────────────────────
class LowPass {
  constructor() { this.y = null; }
  filter(x, alpha) {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }
  get value() { return this.y; }
}

export class OneEuroFilter {
  constructor({ minCutoff, beta, dCutoff }) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = new LowPass();
    this.dx = new LowPass();
    this.tPrev = null;
    this.xPrev = null;
  }

  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  /** Feed a trusted measurement. Returns the smoothed value. */
  filter(value, tSeconds) {
    if (this.tPrev === null) {
      this.tPrev = tSeconds;
      this.xPrev = value;
      return this.x.filter(value, 1);
    }
    const dt = Math.min(0.5, Math.max(1 / 240, tSeconds - this.tPrev));
    this.tPrev = tSeconds;

    const dValue = (value - this.xPrev) / dt;
    this.xPrev = value;
    const dHat = this.dx.filter(dValue, OneEuroFilter.alpha(this.dCutoff, dt));

    const cutoff = this.minCutoff + this.beta * Math.abs(dHat);
    return this.x.filter(value, OneEuroFilter.alpha(cutoff, dt));
  }

  /**
   * No trustworthy measurement this frame: hold the smoothed history rather
   * than tracking a guessed landmark. Returns null if nothing has been seen yet.
   */
  hold(tSeconds) {
    if (this.x.value === null) return null;
    this.tPrev = tSeconds;   // so the next real sample sees a sane dt
    return this.x.value;
  }
}

/** A filter triple per landmark, for one coordinate space. */
export function makeFilters(tuning) {
  return Array.from({ length: NUM_LANDMARKS }, () => ({
    x: new OneEuroFilter(tuning),
    y: new OneEuroFilter(tuning),
    z: new OneEuroFilter(tuning),
  }));
}

/**
 * Smooth one landmark array. Landmarks below the visibility threshold keep
 * their last smoothed position and come back flagged `held`.
 */
export function smooth(points, filters, tSeconds, visibilities) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const f = filters[i];
    const visibility = visibilities ? visibilities[i] : (p.visibility ?? 1);
    const trusted = visibility >= VIS_THRESHOLD;

    if (trusted) {
      out.push({
        x: f.x.filter(p.x, tSeconds),
        y: f.y.filter(p.y, tSeconds),
        z: f.z.filter(p.z ?? 0, tSeconds),
        visibility,
        held: false,
      });
    } else {
      const hx = f.x.hold(tSeconds), hy = f.y.hold(tSeconds), hz = f.z.hold(tSeconds);
      const seen = hx !== null;
      out.push({
        x: seen ? hx : p.x,
        y: seen ? hy : p.y,
        z: seen ? hz : (p.z ?? 0),
        visibility,
        held: true,
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Hysteresis
// ─────────────────────────────────────────────────────────────
/**
 * Latched per-joint verdicts, so the outline stops strobing.
 *
 * The score is smooth now, but the outline is still binary — deliberately, a
 * limb is either where it should be or it is not, and a limb fading through
 * amber says nothing useful at arm's length. A single threshold on a joint
 * sitting exactly on tolerance flickers at frame rate, which is worse than
 * either colour.
 *
 * So the verdict is latched: a joint has to be clearly right to turn green and
 * clearly wrong to turn red again, and in the gap between it keeps whatever it
 * last was. Driven by the graded quality rather than the raw boolean, which is
 * what gives the gap a width.
 */
export class VerdictLatch {
  constructor({ enter = 0.95, leave = 0.55 } = {}) {
    this.enter = enter;
    this.leave = leave;
    this.state = new Map();
  }

  reset() { this.state.clear(); }

  /**
   * Returns a copy of `results` with `ok` replaced by the latched verdict.
   * Joints missing from this frame keep their state, so a joint that drops out
   * for a frame and comes back does not flash.
   */
  apply(results) {
    const out = {};
    for (const [joint, res] of Object.entries(results)) {
      const was = this.state.get(joint);
      let now;
      if (res.quality >= this.enter) now = true;
      else if (res.quality <= this.leave) now = false;
      else now = was === undefined ? res.ok : was;
      this.state.set(joint, now);
      out[joint] = { ...res, ok: now };
    }
    return out;
  }
}

// ─────────────────────────────────────────────────────────────
// Frame processing
// ─────────────────────────────────────────────────────────────
/**
 * One detection, start to finish, with the MediaPipe landmarker injected.
 *
 * Lives here rather than in the worker so its central promise can be tested:
 * **every call posts exactly one result**. The main thread sends one frame at a
 * time and waits for the reply, so a path that returns without replying wedges
 * the app permanently — no further frame is sent, and the render loop paints
 * the last result it has forever. A frozen skeleton, scored as live, with no
 * error raised anywhere. Two such paths existed.
 */
export class FrameProcessor {
  constructor(tuning = TUNING) {
    this.tuning = tuning;
    this.reset();
  }

  reset() {
    this.imageFilters = makeFilters(this.tuning.image);
    this.worldFilters = makeFilters(this.tuning.world);
    this.lastTimestamp = 0;
  }

  /**
   * deps: { landmarker, post, now }
   *   landmarker  anything with detectForVideo(bitmap, ts); may be null or throw
   *   post        receives exactly one { type: "result", ... }, plus a
   *               { type: "status", state: "error" } first if detection threw
   *   now         monotonic milliseconds, injected so tests can control it
   */
  process({ bitmap, timestamp }, { landmarker, post, now }) {
    // detectForVideo demands strictly increasing timestamps.
    const ts = timestamp > this.lastTimestamp ? timestamp : this.lastTimestamp + 1;
    this.lastTimestamp = ts;

    const close = () => { try { bitmap && bitmap.close && bitmap.close(); } catch { /* ignore */ } };

    if (!landmarker) {
      close();
      post({ type: "result", timestamp: ts, detected: false, inference: 0 });
      return;
    }

    const startedAt = now();
    let result = null;
    try {
      result = landmarker.detectForVideo(bitmap, ts);
    } catch (err) {
      post({ type: "status", state: "error",
             message: err && err.message ? err.message : String(err) });
      post({ type: "result", timestamp: ts, detected: false, inference: 0 });
      return;
    } finally {
      close();
    }

    const inference = now() - startedAt;
    const tSeconds = ts / 1000;

    if (!(result && result.landmarks && result.landmarks.length)) {
      post({ type: "result", timestamp: ts, detected: false, inference });
      return;
    }

    const image = result.landmarks[0];
    const visibilities = image.map(p => p.visibility ?? 1);
    const world = (result.worldLandmarks && result.worldLandmarks[0]) || null;

    post({
      type: "result",
      timestamp: ts,
      detected: true,
      inference,
      landmarks: smooth(image, this.imageFilters, tSeconds, visibilities),
      // World landmarks are metric and origin-centred on the hips — the right
      // input for view-independent joint angles.
      world: world ? smooth(world, this.worldFilters, tSeconds, visibilities) : null,
    });
  }
}
