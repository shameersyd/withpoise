# What this cannot tell you

An honest account of where the scoring stops being trustworthy. Written at the
end of the improvement work in `CLAUDE_CODE_BRIEF.md`, and meant to be read
before anyone extends it.

The short version: the app is a good instrument for eight joint angles and is
blind to most of the rest of a yoga pose. Some of that is fixable and some of
it is not fixable from one camera.

---

## 1. Joint angles cannot see rotation

**The biggest one, and it has nothing to do with cameras.**

Warrior II, held with both arms straight and level at shoulder height but
swung 90° forward so they point straight ahead instead of out to the sides,
scores **100.0**. The wrists have moved about half a metre. Not one of the
eight numbers moves enough to notice.

```
arms as written:      score 100.0
arms swung 45°:       score 100.0    left_shoulder 91.1°   (target 92°)
arms swung 90°:       score 100.0    left_shoulder 89.4°   (target 92°)
```

The reason is arithmetic, not a defect. An angle at a joint is the angle
between two segments meeting there. Rotating a limb about an axis that one of
those segments already lies along leaves that angle unchanged. At the shoulder
the second segment is the torso, which is roughly vertical, so swinging the
arms about the body's vertical axis is very nearly invisible.

The same blindness covers a great deal of what a teacher actually corrects:

- **Hips square to the front** in Warrior I — the instruction the pose's own
  step 5 gives, and the one everybody gets wrong. Unmeasurable.
- **Front knee tracking over the foot** rather than collapsing inward. The knee
  *angle* is right either way.
- **Shoulder rotation**, open chest versus rolled forward.
- **Spine shape.** Nothing measures curvature at all, so Downward Dog's "as far
  as they go without rounding your back" can be a tip and can never be a score.
  Neither can Triangle's "don't collapse your chest".

`tests/scoring.test.js` has a test named *"Warrior II scores 100 with both arms
pointing the wrong way"* that pins this down.

**This one is fixable, and it is the obvious next piece of work.** The rig
already describes each segment's *direction*, not just the angles between them,
and `pose-core.js` already builds a body frame and can express landmarks in it
(`bodyFrame`, `toBodyFrame`). Scoring segment directions in the body frame —
"your upper arm should point 90° laterally and 0° forward, relative to your
hips" — would catch every item on that list, and it is strictly more
information than the angles it would supplement. It was left out of Phase 1
because the brief scoped that phase to angles, not because it is hard.

---

## 2. One camera does not know depth

MediaPipe returns metric 3D world landmarks, and their depth axis is a
regression from a single RGB image. It is much the least certain of the three
coordinates, and its error is largest exactly where it matters most: on a body
turned away from the lens.

The app's response is to notice rather than to guess. `jointMeasurability`
works out how much of each joint's angle is being read off the camera's depth
axis and reports the joint as *can't tell* rather than scoring it. That is the
honest answer, and it is worth being clear that **it is an admission, not a
fix.** The information is not in the image. Marking a joint unmeasurable does
not recover it.

What that costs in practice:

- **You have to stand for the camera, not for your practice.** Turn 40° off and
  the app starts writing joints off. Warrior II seen edge-on loses six of its
  eight.
- **Some poses only work from one angle at all.** Downward Dog is filmed from
  the side because head-on it is a body pointing at the lens with nothing in the
  image to measure. `view: "side"` in the pose schema is the app conceding this
  in the format itself.
- **Depth compression hides its own evidence.** A monocular landmarker flattens
  depth on a turned body, which makes a naive "how much of this segment is
  along the camera axis" test *under*-report exactly when it should fire hardest.
  The gate reconstructs the depth component from the hip and shoulder axes
  instead, which survive flattening — but the reconstruction is itself
  conservative. A user genuinely at 10° to the camera reads as about 47°.

**This is the part no amount of engineering fixes from one RGB camera.** A
second camera at 90° would resolve it outright: two views make the depth axis of
each the image axis of the other, and every joint currently written off becomes
measurable. A depth sensor would do the same — recent iPhones have LiDAR, though
a web page cannot reach it today.

Two cameras is a real option for a fixed setup and a non-starter for the actual
use case, which is one phone propped against a wall. Given that, the current
design — measure what is measurable and say so about the rest — is the right
one. It is just worth knowing that the honesty is covering a hole rather than
filling it.

---

## 3. One idealised body

Every target is derived from a rig with fixed segment proportions, and every
pose has exactly one correct shape.

- **Proportions are fixed.** The rig's torso is 0.26 and its thigh is 0.20 for
  everybody. The target *outline* is rebuilt from the user's own measured limb
  lengths, so what you see fits you — but the target *angles* come from the
  idealised figure.
- **Range of motion is not.** Downward Dog's 86° hip is right for someone with
  average hamstrings and wrong for a beginner and wrong for a dancer. The app
  widens the tolerance and weights the knees low, which is a blunt instrument
  standing in for "your best version of this pose today".
- **There is no progression and no calibration.** The app cannot tell someone
  working correctly at their limit from someone doing it badly, and it scores
  the second one lower.
- **The targets were authored from geometry**, by reasoning about what the
  shape should be, and checked against anatomy — not set by a teacher and not
  measured from anyone doing the poses well. They are plausible, not
  authoritative.

---

## 4. Nothing here has been checked against a real body

All 186 tests run on synthetic fixtures built by posing the rig and reading the
joints back. That is deliberate and it is stated at the top of
`tests/make-fixtures.js`: they are exact, deterministic and diffable, and they
pin down the behaviour of our code precisely.

They also contain none of MediaPipe's error. A synthetic body is a body the
landmarker got perfectly right. The suite can prove the scoring math does what
we think; it cannot prove the app works on a person, and no number of synthetic
fixtures ever will.

`tests/smoke.sh` proves inference runs in a real browser. It does not prove the
landmarks are accurate, because there is no ground truth in this repository to
compare them against.

**What would actually settle it:** record a few short clips of someone holding
each pose correctly and incorrectly, hand-label which is which, and check what
the app says. That is a morning's work and it is the single most valuable thing
anyone could do to this project next. Everything above is reasoning; that would
be evidence.

---

## In order

If you only do one thing: **record the clips** (§4). Everything else here is
argued from first principles and would benefit from contact with a real body.

If you only do one thing to the scoring: **score segment directions in the body
frame** (§1). It closes the largest gap, the machinery is already in place, and
it is the difference between measuring eight angles and measuring a pose.

And accept §2. One camera, one phone against a wall — the depth is not there to
be had.
