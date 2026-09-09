# Adding a pose

Everything a pose needs lives in one object in `yoga_app/poses.js`. There is no
build step and nothing to register: add the object, and the pose appears in the
grid with a walkthrough, a target outline, spoken coaching and a score.

The format is enforced by `yoga_app/pose-schema.js`, which is the authority if
this document and that file ever disagree.

---

## The one idea worth understanding first

**A pose describes its shape exactly once**, as a *rig* — the direction each
body segment points. The eight target joint angles are computed from the rig.
You never write a target angle.

This used to work the other way round, with the rig and the angles written out
side by side. A check found that all forty of those numbers were the derived
value rounded to a whole degree: no information, and forty chances for the two
descriptions of one shape to drift apart.

So: get the rig right and the scoring follows.

---

## Directions

A direction is an angle in degrees, in the plane of the image:

```
            90°
             │
    180° ────┼──── 0°
             │
            270°
```

`0°` points right, `90°` points up. This is the ordinary maths convention, and
it is *not* affected by the canvas drawing y downwards — that is handled for
you.

A direction may also be `[theta, phi]`, where `phi` tilts the segment out of the
frontal plane, away from the camera. All six poses in the file today use plain
angles; `phi` is there for a pose that genuinely reaches towards or away from
the lens.

> An array always means `[theta, phi]`. It used to mean that at the torso and
> "the two segments of this limb" inside a limb, which is why no limb could be
> tilted out of plane at all.

---

## The fields

```js
warrior3: {
  name: "Warrior III",
  sanskrit: "Virabhadrasana III",
  emoji: "✈️",
  description: "One line from fingertips to heel, balanced on one leg.",

  view: "front",          // or "side" — see below
  side: "left",           // or symmetric: true

  steps: [
    { text: "Stand on your left leg", focus: ["left_leg"] },
    // ...
  ],
  tips: [
    { icon: "✅", text: "Hips level — don't let the lifted one open upward" },
  ],

  rig: {
    torso: 0,
    arm_left:  { upper: 0, fore: 0 },
    arm_right: { upper: 0, fore: 0 },
    leg_left:  { thigh: 265, shin: 265 },
    leg_right: { thigh: 180, shin: 180 },
  },

  joints: {
    default: { tolerance: 25, weight: 1 },
    left_knee: { tolerance: 20, weight: 3 },
    left_hip:  { weight: 3 },
  },
},
```

### `rig`

Five entries. `torso` is the direction from the hips to the shoulders — the
direction the spine points, not the direction the body leans. Each limb is an
object with named segments:

| entry | segments |
|---|---|
| `torso` | *(a single direction)* |
| `arm_left`, `arm_right` | `upper` (shoulder→elbow), `fore` (elbow→wrist) |
| `leg_left`, `leg_right` | `thigh` (hip→knee), `shin` (knee→ankle) |

Left and right are **anatomical** — the person's left, not the viewer's.

A joint's angle is the angle between the two segments meeting at it, so a limb
whose two segments point the same way is straight (180°). In practice aim for
about 175° rather than exactly 180: at 180 the tolerance band is one-sided,
because there is nothing above it.

### `joints`

Per-joint `tolerance` (how far off is still right, in degrees) and `weight` (how
much of the pose this joint actually is). Both are optional; `default` covers
whatever you leave out, and if you omit `joints` entirely everything gets
25° and a weight of 1.

Weights are relative within a pose — only the ratios matter. They are where the
teaching lives: Tree's standing knee is a 3 and its elbow is a 1, because the
pose is a straight standing leg and the arms are decoration. Downward Dog's own
tips say to bend the knees if you need to, so its knees carry a wide tolerance
and the lowest weight in the pose, and a bent knee costs it four points rather
than twenty.

A weight of `0` means "do not score this joint at all".

### `view`

`"front"` (the default) or `"side"`.

This is a geometric statement, not a label. It decides the axis the body's left
and right sides separate along — across the image for a front pose, along the
camera axis for a side one, so the two sides sit one behind the other and
project onto each other.

Use `"side"` when the shape lives in the sagittal plane. Downward Dog is the
example: seen head-on it is a body pointing at the lens, and a single camera has
nothing to measure. Nothing in the scoring can fix that, because the information
is not in the image. Declaring the view makes the app ask the user to stand the
right way, and changes what it means by "you're facing the wrong way".

### `side` / `symmetric`

An asymmetric pose is written for **one** side and says which: `side: "left"`.
The other side is generated — the rig is reflected, targets and weights swap
joints, the highlighted body parts swap, and the words "left" and "right" swap
in the instruction text. Do not write the second side by hand.

A pose that is the same both ways says `symmetric: true` instead. Exactly one of
the two is required.

### `steps` and `tips`

`steps` drives both the numbered walkthrough and the animated demo figure.
`focus` lists the body parts that step is about, and they light up on the figure
while that step is showing: `torso`, `head`, `left_arm`, `right_arm`,
`left_leg`, `right_leg`. It is optional.

`tips` are the short reminders under the walkthrough. Nothing parses them.

---

## Doing it

**1. Copy the pose closest to yours** and change the name, sanskrit, emoji and
description.

**2. Write the rig.** Work from the picture in your head: which way does each
segment point, in that clock face. Do not try to work out the joint angles —
that is the tool's job.

**3. Look at what you built:**

```
tools/show-pose.sh warrior3
```

It prints any validation problems, the joint angles your rig implies, and a
sketch of the figure as the app will draw it:

```
  🐕  Downward Dog  (side view, symmetric)

  joint            target   tolerance   weight
  ─────────────────────────────────────────────
  left_hip          86.0°   ±22°       3
  ...

  as drawn (z dropped, exactly as the canvas does):

                     ·+
                   ··  ··
                 ··      ··
              ·+·          ·
           ·+O·             +
```

Check the angles against what you know about the pose. A hip at 86° in Downward
Dog is right; a hip at 140° would mean the rig is not folded nearly enough.

**4. Watch out for the floor.** Standing poses look wrong if the hands and feet
end at different heights. The torso-plus-arm chain and the leg chain are
different lengths, so reaching the same floor line means laying them at
different angles — Downward Dog's legs are at 307° and 302° rather than round
numbers for exactly this reason.

**5. Set tolerances and weights** from what the pose is actually about. Ask what
you would say to someone holding it badly, and weight that joint accordingly.

**6. Regenerate the test fixtures and run the tests:**

```
tests/make-fixtures.sh
tests/run.sh
```

The generator builds four synthetic bodies for your pose — correct, one known
fault, one seen 30° off the view it needs, one partly out of frame — and the
suite asserts against all of them. Several tests are keyed by pose name and will
tell you they need a value for yours; the numbers they want are printed in the
failure.

**7. Look at it in the app:**

```
python3 serve.py
```

---

## Things that go wrong

**"The pose definitions are broken" on a red screen.** The validator caught
something and named the pose and the field. Definitions are checked at load and
a bad one stops the app rather than starting with it — a rig with a missing
segment silently becomes a figure with a limb at the origin, and the app would
then score somebody against it and tell them to move.

**The figure is inside out.** Left and right are the person's, and the demo is
drawn mirrored so it reads like a mirror. If the limbs are swapped, you have
written the viewer's left.

**Everything reads as unmeasurable.** The pose probably wants `view: "side"`.
Joints whose segments point down the camera axis are reported as "can't tell"
rather than scored, and a sagittal-plane pose filmed from the front is all
of them.

**A joint sits at exactly 180°.** Aim for 175. See `rig` above.

**The score never reaches 100 in the app but the fixtures pass.** The fixtures
are synthetic — they are built from the rig and contain none of MediaPipe's own
error. They prove the math does what you think; they prove nothing about a real
body. Widen the tolerances.

---

## What a pose cannot express yet

Worth knowing before you fight the format:

- **Only eight joints are scored** — both elbows, shoulders, hips and knees.
  Wrists, ankles, neck and spine curvature are not measured at all, so "don't
  round your back" can be a tip but never a score.
- **Segment lengths are fixed proportions.** A rig sets directions, not
  lengths, so a pose distinguished by reach rather than angle cannot be
  described.
- **There is no notion of the floor**, of weight, or of balance. A pose held
  correctly in mid-air would score the same.
