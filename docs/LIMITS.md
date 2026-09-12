# What this cannot tell you

An honest account of where the scoring stops being trustworthy. Written at the
end of `CLAUDE_CODE_BRIEF.md` and revised at the end of
`SPATIAL_ACCURACY_BRIEF.md`, which closed the largest item on it.

The short version: the app now measures both how bent each limb is and where it
points, which together describe a pose. What it still cannot do is see depth,
know your body, or tell you anything that has been checked against a real
person.

---

## 1. Rotation — fixed, and worth recording how

**This was the largest limitation and it is closed.** The account is kept
because the reasoning is worth more than the fix.

Joint angles are invariant to rotation. Warrior II held with both arms straight
and level but swung 90° forward — pointing ahead instead of out to the sides —
scored **100.0**, with half a metre of wrist travel and not one of the eight
numbers moving enough to notice. A knee could collapse 13cm inward, a pelvis
yaw 45°, and a body could be reflected front-to-back, all for free.

The fix was the one this document pointed at: the rig already described each
segment's *direction*, and those directions were being used to derive the target
angles and then discarded. They are scored now, in the body's own frame, with
the depth component discounted by how little the camera resolves it. Measured:

```
warrior2  valgus 30°     100.0 →  91.3    Track your left knee back
warrior2  valgus 45°     100.0 →  83.3
warrior2  pelvisYaw 30°  100.0 →  82.9    Square your hips towards the front
warrior2  armSwing 45°   100.0 →  90.9    Take your left elbow back
```

`tests/eval-baseline.txt` is the full table and `tests/spatial.test.js` holds it
down. Two things it is worth knowing about the fix:

- **The invariance it had to preserve was the harder half.** A correct pose seen
  30° off-axis still scores exactly what it scores head-on. Direction scoring
  switches off entirely when the user is facing the wrong way for the pose,
  because the body frame is then being read through a compressed depth axis —
  measured at 22° of error per leg segment on Downward Dog with no noise
  present. Scoring that would report the viewing angle as bad form.
- **It rests on the smoothing.** The 4° tolerance is set against 0.7–1.5° of
  direction noise, which is what the One Euro filter leaves. Unsmoothed the same
  noise is 3–8° and the tolerance would be meaningless.

### What rotation still cannot see

- **Spine shape.** Nothing measures curvature, so Downward Dog's "as far as they
  go without rounding your back" is a tip and can never be a score. Neither can
  Triangle's "don't collapse your chest". The rig describes nine straight
  segments and a spine is not one of them.
- **Rotation about a limb's own axis.** A forearm pronated or supinated points
  exactly where it did. Only the hand would show it, and hands are not tracked.
- **Anything below the ankle or above the neck.** Feet, hands, head tilt, gaze.

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
  instead, which survive flattening.

  The reconstruction still under-reads, and the correction is **downward, not
  upward** — an earlier version of this document had the direction backwards and
  used it to justify a threshold. Measured against the repository's own
  compression model:

  | true turn from camera | 10° | 30° | 50° | 60° | 80° | 90° |
  |---|---|---|---|---|---|---|
  | what `bodyFrame` reports | 9° | 22° | 32° | 39° | 66° | 90° |

  The shipped `turned` fixture agrees: 30° true, reads 21.9°. So a reported
  angle is a *lower bound* on how far round the user has actually turned, and
  any threshold on it has to sit lower than the true angle it means to catch —
  which is why `SIDE_MIN_TURN_DEGREES` is 60 and not 76.

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
  everybody. The target *outline* is now rebuilt from bone lengths measured from
  the user during calibration, reproducible to within 2% — but the target
  *angles and directions* still come from the idealised figure.
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

All 239 tests run on synthetic fixtures built by posing the rig and reading the
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

---

## 5. The depth reconstruction is built and not switched on

`yoga_app/depth.js` reconstructs each bone's depth from its length and its
projection — √(L² − p²), exact, no solver. Measured against ground truth under
the noise model it is 19% better overall and 54–77% better on a body turned 60°
off-axis, and it recovers the depth compression the fixtures apply without being
told it exists.

It is not in the live scoring path, and the reason is the same one as §4. Its
entire measured benefit comes from undoing a uniform z-scale, and a uniform
z-scale is precisely what the fixtures apply — a model of MediaPipe's error,
explicitly labelled a stand-in rather than a measurement. Real depth error is a
pose-dependent regression failure, not a scale factor. Under the favourable
model it still regresses two of six poses at 60°.

What *is* switched on is the part that leans on no error model: a bone cannot
project longer than it is, so when it does, that landmark is not where it
appears and it drops out of the frame's scoring.

The reconstruction is one line from being live. It should not be until someone
has the recordings from §4 to check it against.

---

## In order

If you only do one thing: **record the clips** (§4). Everything below and above
is argued from first principles or from a synthetic model, and would benefit
from contact with a real body. It is also what would let §5 be switched on.

If you only do one thing to the scoring: nothing, until then. The largest
structural gap is closed, and the next honest move is evidence rather than more
machinery.

And accept §2. One camera, one phone against a wall — the depth is not there to
be had.
