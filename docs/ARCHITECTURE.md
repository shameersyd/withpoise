# Architecture — Yoga Pose Tracker

A survey of `yoga_app/` and `serve.py` as they stand today. Descriptive only:
nothing here is a proposal, and nothing was changed to write it.

> **Currency.** Written at Phase 0 of `CLAUDE_CODE_BRIEF.md` and updated at the
> end of Phases 1 to 5. Sections 1–4 describe the code as it stands; section 5
> marks what has been fixed and what is still open.

Files:

| File | Role |
|---|---|
| `yoga_app/index.html` | Markup, CSS, and one inline `<script type="module">`: the DOM, the canvas, the camera and all session state |
| `yoga_app/pose-core.js` | The pure half — angle math, reliability, camera geometry, scoring, mirroring, smoothing, latching. No DOM, no canvas, no worker |
| `yoga_app/poses.js` | The six pose definitions and the correction phrasings. Data only |
| `yoga_app/pose-schema.js` | What a pose may contain, checked at load; and the targets derived from its rig |
| `yoga_app/coach.js` | What to say and when, plus the hold timer and the session queue. Pure: time is passed in |
| `yoga_app/voice.js` | `speechSynthesis` and the completion tone, and the remembered on/off switch |
| `yoga_app/pacing.js` | How often to run detection, chosen from measured inference time |
| `yoga_app/pose-worker.js` | MediaPipe landmarker and the detect loop, off the main thread |
| `yoga_app/sw.js` | Service worker: app shell + CDN/model caching |
| `yoga_app/manifest.json` | PWA manifest |
| `serve.py` | Local HTTPS dev server with a self-signed cert, no-cache headers and port fallback |
| `LICENSE`, `README.md` | MIT, and the deploy-first README |
| `tools/show-pose.sh` | What shape a rig actually makes: validation, derived angles, an ASCII sketch |
| `tests/` | Harness, fixtures and suites, run by `./tests/run.sh`; plus `smoke.sh`, a browser test of the parts `jsc` cannot see |

`pose-core.js` is imported by both `index.html` and `pose-worker.js`, which is
what keeps the visibility threshold and the filter tuning from existing in two
copies that have to agree.

There is no build step, no package manager and no dependency manifest. There is
no Node, deno or bun on this machine either, so the test suite runs under
JavaScriptCore's `jsc` shell rather than vitest or `node:test`. MediaPipe is pulled from jsdelivr as an ES module at runtime; the
`.task` model comes from `storage.googleapis.com`. `pose_landmarker.task` sits
in the repo root but is gitignored and unused by the web app.

---

## 1. The frame lifecycle

```
getUserMedia ──▶ <video> ──▶ rAF: renderFrame()
                               │
                               ├─▶ sendFrameToWorker()
                               │     createImageBitmap(video)
                               │     postMessage({frame, bitmap, ts}, [bitmap])
                               │             │
                               │             ▼   ── worker thread ──
                               │       handleFrame()
                               │       landmarker.detectForVideo(bitmap, ts)
                               │         → landmarks[0]      (normalized 2D + rel. z)
                               │         → worldLandmarks[0] (metres, hip origin)
                               │       smooth() × One Euro, per coordinate
                               │       postMessage({result, landmarks, world, inference})
                               │             │
                               │             ▼   ── main thread ──
                               │       latestResult = msg;  frameInFlight = false
                               │
                               └─▶ reads latestResult (whatever arrived last)
                                     reliableLandmarks(landmarks)   ← image space
                                     computeAngles(world, …)        ← world space
                                     bodyFrame(world) → turnDegrees
                                     jointMeasurability(world, frame)
                                     matchSinglePose(…) × each side
                                     sideSelector.pick(…)
                                     verdicts.apply(match.results)
                                     buildTargetFigure(variant, …)
                                     drawGhost / drawSkeleton / updateTrackingUI
                                     holdTimer.update(solid, now)
                                     coach.update(state, now) → voice.speak
```

### Camera in

`startCamera()` (`index.html`) requests `facingMode` (`"user"` by default)
at an ideal 1280×720 and pipes the stream into `<video id="video">`. On failure
it fires a blocking `alert()`.

### Pump

`startTrackingLoop()` (`index.html`) installs a `requestAnimationFrame`
loop. Each tick:

1. bails if `video.readyState < 2`;
2. resizes the canvas backing store to `video.videoWidth × videoHeight`
   (`index.html`);
3. calls `sendFrameToWorker()`;
4. draws using whatever result last arrived.

`sendFrameToWorker()` (`index.html`) is gated on `frameInFlight`, so
exactly one frame is in flight at a time. It grabs an `ImageBitmap` from the
video element and transfers it to the worker with a `performance.now()`
timestamp. There is no fixed detection rate: detection runs as fast as the
worker can turn frames around, and the render loop runs at display rate
regardless.

**The render loop and the detection stream are not synchronised.** A rAF tick
paints `latestResult` even if it corresponds to a frame several display frames
old, and the same result may be painted many times.

### Inference

The worker is a thin shell: MediaPipe's lifecycle, and a `FrameProcessor` from
`pose-core.js` that does the per-frame work. It forces a strictly increasing
timestamp, runs `detectForVideo`, times it, and releases the bitmap.

**Every path posts exactly one `result`**, including the failing ones. The main
thread waits for that reply before sending another frame, so a path that returns
silently wedges the app with no error anywhere. `FrameProcessor` lives in the
core rather than the worker specifically so that promise can be tested.

The model is fetched by the worker rather than by MediaPipe, so the download
reports real progress and `modelAssetBuffer` gets the bytes. The GPU delegate is
tried first and CPU is the fallback; which one was used comes back on the ready
status.

> A module worker has no working `importScripts`, and MediaPipe's wasm glue is a
> classic script that calls it. `pose-worker.js` shims it with synchronous XHR
> and indirect eval. Without that the landmarker never starts at all — which is
> what it did, for the app's entire history before Phase 3.

Two landmark arrays come back and **both are smoothed and both are posted**:

- `result.landmarks[0]` — 33 landmarks, `x`/`y` normalized to `[0,1]` in image
  space, `z` a relative depth in roughly the same scale as `x`, plus
  `visibility`.
- `result.worldLandmarks[0]` — 33 landmarks in **metres**, origin at the hip
  midpoint, independent of where the person is in frame.

`smooth()` (`pose-core.js`) runs an independent One Euro filter per
landmark per coordinate (`TUNING` in `pose-core.js`, separate constants
for image vs. world because the units differ by ~3 orders of magnitude). A
landmark whose `visibility` is below `VIS_THRESHOLD` (0.5) does **not** feed
the filter — the filter's last output is held and the landmark comes back
flagged `held: true`. World landmarks are gated on the *image* landmarks'
visibility scores, which is the only place visibility is published.

### Landmarks → score

Per live tick:

- `reliableLandmarks(landmarks)` builds a `Set` of joint names that are
  trustworthy this frame: not `held`, `visibility ≥ 0.5`, and within
  `[-0.02, 1.02]` in normalized image coords. Uses the **image** landmarks,
  since world landmarks carry no framing information.
- `computeAngles(world, landmarks, w, h)` produces the eight joint angles.
- `bodyFrame(world)` builds an orthonormal frame from the hip and shoulder
  vectors and reports `turnDegrees`, how far off-axis the torso is.
- `jointMeasurability(world, frame)` reports, per joint, how much of its angle
  is being read off the camera's depth axis. See §3.
- `matchSinglePose(angles, template, opts)` runs once **per side** of the pose,
  and `sideSelector.pick` chooses between them with a margin and a hold.
- `verdicts.apply(results)` latches each joint's red/green verdict so the
  outline cannot strobe. Colours and corrections use the latched copy; the
  score uses the graded values underneath.

`matchSinglePose` sets a joint aside for one of two distinguishable reasons:

| | why | what the user is told |
|---|---|---|
| `unscored` | its landmarks are off-frame or occluded | "step back" |
| `uncertain` | it points down the camera axis | "turn" |

and for everything else grades it:

```js
const diff    = Math.abs(actual - target);
const quality = jointQuality(diff, tolerance, margin);  // 1 → 0, smoothstep
const ok      = diff <= tolerance;                      // raw, pre-latch
```

```
score    = Σ(quality × weight) / Σ(weight)     over judged joints
coverage = Σ(weight of judged) / Σ(weight of all)
```

`coverage` is what stops a half-visible body reading as a perfect pose: the
score is a fraction of what was judged, and coverage says how much that was.
The UI withholds "Perfect form" and the green glow below full coverage.

### Score → pixels

Three consumers, all in the same tick:

- **`buildTargetFigure()`** (`index.html`) — rebuilds the pose's reference
  figure using the user's own measured limb lengths and translates it so its
  hip midpoint sits on the user's hip midpoint. Returned in canvas pixels;
  shared by the outline and the correction arrows so both agree.
- **`drawGhost()`** (`index.html`) — dashed target outline, coloured
  segment-by-segment by `ghostSegColor()` (`index.html`): red touching a
  failing joint, green touching a passing one, grey where a landmark is
  untrusted, all-green when every scored joint passes.
- **`drawSkeleton()`** (`index.html`) — the user's actual skeleton from
  *image* landmarks scaled by `w`/`h`; green/red/grey per segment, plus yellow
  nudge arrows from each failing joint toward its position in the target figure
  (capped at 70 px, suppressed under 12 px).
- **`updateTrackingUI()`** (`index.html`) — score ring, the status card
  (percentage, verdict string, "N of M joints aligned · K hidden"), the
  corrections list (max 5 phrases from `CORRECTION_TIPS`), and the green
  full-screen `perfect-glow` at ≥95% with nothing hidden.

### Score → speech

The coaching layer is driven from the same tick, and is deliberately the only
part of the app allowed to interrupt the user.

- `holdTimer.update(solid, now)` — `solid` is `score ≥ 88 && coverage ≥ 0.7`.
  Not 100%: a body held still is never exactly on its targets, and coverage has
  to be in it because you cannot certify a hold you could not see. A lapse
  pauses the clock; only a lapse outlasting `graceMs` restarts it.
- `coach.update(state, now)` returns **at most one** utterance per frame, or
  `null`, which is the usual answer. Priority runs: hold completion → countdown
  tick → the pose coming good → framing → one correction.
- Corrections stay on a single joint until it is acted on, ranked by
  `weight × (1 − quality)` so the worst fault leads. The on-screen panel uses
  the same ranking.
- `voice.speak` cancels anything still queued before speaking, so a backlog can
  never build — by the time three corrections have queued the body has moved on
  and all three are lies.

`Session` holds the queue. An asymmetric pose owes a hold on each side, in
whichever order the user chooses, since the side is detected rather than asked.

### Session phase machine

`trackPhase` runs `loading → framing → countdown → live`, plus `lost`.
`framing` waits for all four `TORSO` landmarks to be reliable, holds for 500 ms,
then counts down 3 s before scoring starts. Nothing is scored and no
corrections are shown outside `live`.

`live → lost` when the body is gone, the torso cannot be found, or coverage
falls under `MIN_COVERAGE` — each sustained past `LOST_GRACE_MS`, and each
distinct enough to need a different instruction. `lost → live` needs the problem
gone for `REGAIN_MS`. A body merely *partly* out of frame is not lost: that is
normal in a small room, keeps scoring, and gets a spoken "step back" instead.

---

## 2. Pose definitions

All five poses live in the `YOGA_POSES` object literal at `index.html`,
inside the inline script. There is no separate data file. Related lookup
tables sit alongside: `CORRECTION_TIPS` (`index.html`), `ANGLE_JOINTS`
(`index.html`), `BODY_PARTS` (`index.html`), `SEG_DEFAULT`
(`index.html`).

### Schema

Defined and enforced by `pose-schema.js`; written for authors in
`docs/ADDING_A_POSE.md`.

```js
key: {
  name, sanskrit, emoji, description,     // all required, all non-empty

  view: "front" | "side",                 // default "front"
  symmetric: true,                        // or side: "left" | "right"

  steps: [ { text, focus: [ bodyPart… ] } ],
  tips:  [ { icon, text } ],

  rig: {                                  // the shape, stated once
    torso:     theta | [theta, phi],
    arm_left:  { upper, fore },           // each a direction
    arm_right: { upper, fore },
    leg_left:  { thigh, shin },
    leg_right: { thigh, shin },
  },

  joints: {                               // optional, and so is every entry
    default:   { tolerance, weight },
    left_knee: { tolerance: 20, weight: 3 },
  },
}
```

**The rig is the only description of the shape.** `compilePose` derives the
eight target angles from it by building the figure and reading its joints back.
There is nothing to keep in sync, because there is nothing to sync with.

A direction is `theta` — degrees in the image plane, 0° right and 90° up — or
`[theta, phi]` to tilt the segment out of the frontal plane. An array always
means the latter now; it used to mean `[theta, phi]` at the torso and
`[upperSegment, lowerSegment]` inside a limb, which is why no limb could carry a
phi and why every pose was planar.

`view` is geometry, not a label: it decides the axis the body's left and right
sides separate along — across the image for a front pose, along the camera axis
for a side one, so the two sides project onto each other. Downward Dog is a side
pose, and gets it because a single camera has nothing to measure on a body
pointing at the lens.

`joints` carries tolerance (how far off is still right) and weight (how much of
the pose that joint is), with `default` covering the rest and a global fallback
of 25° and 1. A weight of `0` removes the joint from the pose completely — not
scored, not in coverage, not coloured, never corrected.

An asymmetric pose is written for one side and `sidesOf()` derives the other.

**Validation runs at load and a bad definition stops the app**, on a red screen
naming the pose and the field. Not a warning: a rig with a missing segment
builds a figure with a limb at the origin, and the app would go on to score
somebody against it and tell them to move.

The eight joints are fixed by `ANGLE_JOINTS` and cannot be extended per-pose.
Wrists, ankles, neck and spine curvature are not measured at all.

---

## 3. Does scoring use `landmarks` or `worldLandmarks`?

**Scoring uses `worldLandmarks` — metric 3D — with a fallback to image
landmarks scaled to pixels when world landmarks are absent.**

The relevant code, `computeAngles()` at `index.html`:

```js
function computeAngles(world, image, w, h) {
  let points;
  if (world) {
    points = (n) => world[LM[n]];                       // metres, hip-centred
  } else {
    points = (n) => {                                   // fallback
      const lm = image[LM[n]];
      return { x: lm.x * w, y: lm.y * h, z: (lm.z ?? 0) * w };
    };
  }
  ...
}
```

called at `index.html` as `computeAngles(world, landmarks, w, h)` with
`world = latestResult.world`, which the worker fills from
`result.worldLandmarks[0]` (`pose-worker.js`). The fallback branch fires
only if MediaPipe returns no world landmarks — it is effectively dead code on
current tasks-vision builds, but it exists and is not flagged in the UI when
taken.

`calcAngle()` (`pose-core.js`) is a genuine 3D angle: it includes the `z`
component in both vectors.

Everything **else** uses image `landmarks`: reliability/framing checks
(`reliableLandmarks`), all drawing, limb-length measurement, and the target
figure. This split is deliberate and correct — world landmarks carry no
information about where the body is in the frame.

**Important caveat for anything built on top of this.** Using
`worldLandmarks` removes the *positional* projection error, but it does not
make scoring view-invariant. MediaPipe's world landmarks are a monocular
regression: the depth axis is the least-constrained output, and for a body
turned edge-on to the camera the depth error is largest exactly where it
matters most. Joint angles computed in that frame are still measurably
camera-dependent, and nothing in the pipeline currently detects or reports
that. There is also **no body-frame rotation step** anywhere: angles are read
straight out of MediaPipe's world frame, which is gravity-ish aligned to the
camera, not to the torso.

---

## 4. Global mutable state

Everything lives at module scope in one of two module bodies. Nothing is
encapsulated; there are no classes or closures holding session state.

### `index.html` inline module

Everything lives at module scope. Nothing is encapsulated; there are no classes
or closures holding session state, with the exception of the three objects
noted at the end.

| Name | Written by | Read by |
|---|---|---|
| `selectedPoseKey` | `showGuide()` | guide loop, tracking loop, ghost/target builders, recap sheet |
| `isTracking` | begin/back handlers | `renderFrame()` guard |
| `animFrameId` | `renderFrame()` | back handler (cancel) |
| `facingMode` | flip handler | `startCamera()` |
| `cameraStream` | `startCamera()`, `stopCamera()` | both |
| `poseWorker` | `startWorker()` | `sendFrameToWorker()`, `resetTrackPhase()` |
| `workerReady` | `startWorker()`, worker `status` msg | `sendFrameToWorker()`, `resetTrackPhase()` |
| `frameInFlight` | `sendFrameToWorker()`, worker `result` msg, `onerror` | `sendFrameToWorker()` |
| `latestResult` | worker `result` msg, `startWorker()`, `resetTrackPhase()` | `renderFrame()` |
| `currentModel` | `startWorker()` | `setModel()`, `renderModelToggles()` |
| `modelStatus` | `startWorker()`, worker `status` msg, `onerror` | `renderModelToggles()`, `renderFrame()` overlay |
| `trackPhase` | `startWorker()`, worker `status` msg, `resetTrackPhase()`, `renderFrame()` | `renderFrame()`, worker `status` msg |
| `countdownStart` | `renderFrame()` | `renderFrame()` |
| `readySince` | `renderFrame()`, `resetTrackPhase()`, worker `status` msg | `renderFrame()` |
| `ghostOn` | ghost button | `renderFrame()` |
| `overlayState` | `setOverlay()`, `hideOverlay()`, `resetTrackPhase()` | `setOverlay()`, `hideOverlay()` timeout |
| `bodyLengths` | `measureBody()`, `resetBodyLengths()` | `measureBody()`, `buildTargetFigure()` |
| `lostSince`, `lostReason`, `regainedSince` | `renderFrame()`, `resetTrackPhase()` | `renderFrame()` |
| `cameraError` | `startCamera()`, the retry button | `renderFrame()` |
| `wakeLock` | `requestWakeLock()`, `releaseWakeLock()`, the OS | both, and `visibilitychange` |
| `frameSentAt`, `stalls` | `sendFrameToWorker()`, worker `result` msg | the watchdog |
| `shownHz` | `renderFrame()` | `renderModelToggles()` |
| `queued` | the pose-card queue buttons | `renderQueue()`, session start |
| `session` | session start, `advanceSession()`, `endSession()` | `renderFrame()`, badge, advance |
| `completedAt` | `renderFrame()` on a completed hold | `renderFrame()`, to delay the advance |
| `currentVariant` | `renderFrame()`, `resetTrackPhase()` | recap sheet, ghost fallback |
| `demoStep` | `setDemoStep()` | demo loop, dots, step list |
| `demoRAF` | `startDemoLoop()`, `stopDemoLoop()` | both |
| `demoStepStart` | `setDemoStep()`, `startDemoLoop()` | demo loop |
| `VARIANTS` | built once at load: every pose and its mirror, each with a reference figure | demo drawing, tracking loop, ghost |
| `canvas.width/height` | `renderFrame()` | all drawing |

Three objects own state behind a method rather than in the open, and all three
are cleared together by `resetTrackPhase()`:

| | holds |
|---|---|
| `verdicts` (`VerdictLatch`) | the latched red/green verdict per joint |
| `holdTimer` (`HoldTimer`) | how much of the current hold is banked |
| `coach` (`Coach`) | what has been said and when, so it is not said again |
| `voice` (`Voice`) | the speech queue, the audio context, the remembered toggle |
| `budget` (`FrameBudget`) | smoothed inference time and the detection rate chosen from it |
| `sideSelector` (`SideSelector`) | which side is being tracked, and any pending challenge to it |
| `FIGURE_HEAD` (`WeakMap`, in `pose-core.js`) | head radius per figure, keyed by the figure object |

`trackPhase`, `readySince` and `latestResult` are each written from **three**
places including an async worker callback, which is the messiest corner of the
state.

### `pose-worker.js` module

| Name | Written by | Read by |
|---|---|---|
| `imageFilters`, `worldFilters` | `makeFilters()`, `resetFilters()` | `smooth()` |
| `landmarker` | `init()` | `handleFrame()` |
| `currentModel` | `init()` | error messages |
| `lastTimestamp` | `init()`, `handleFrame()` | `handleFrame()` |

Plus per-filter internal state (`LowPass.y`, `tPrev`, `xPrev`) — 33 landmarks ×
3 coords × 2 spaces × 2 low-passes = 396 stateful filter objects, reset only by
an explicit `{type:"reset"}` message or a model reload.

### Persisted state

One key: `yoga.audio` in `localStorage`, `"on"` or `"off"`. Every read and write
is wrapped, because `localStorage` throws outright in some privacy modes, and
the default when it does is on.

Nothing else survives a reload — not the model choice, the camera choice, or a
part-finished session.

---

## 5. What's fragile, duplicated, or confusing

### Fixed in Phase 1

Kept here because the reasoning is worth more than the fix, and because the
tests that hold each one down are named after it.

| was | now |
|---|---|
| The score was a cliff: `ok = diff <= tolerance`, moving the total in eighths and flipping the outline at frame rate on a boundary | Graded per joint on a smoothstep past the tolerance, with the red/green verdict latched so it needs a clear win to change colour |
| Every joint counted the same, so a straight elbow was worth a collapsed standing leg | Per-joint weights in the pose schema |
| Unscored joints left the denominator, so a half-visible body read 100%, and a fault that swung a limb out of frame *raised* the score | `coverage` alongside the score; "Perfect form" and the green glow are withheld below full coverage |
| Four of five poses were written for one side only, scoring the second half of a practice as entirely wrong | Both sides derived from one definition, and the side detected per frame with a margin and a hold |
| Every pose stated its shape twice, as a rig and again as eight target angles — forty numbers that were all just the derived value rounded | The rig is the only description; targets are computed from it |
| A two-element array meant `[theta, phi]` at the torso and "two segments" inside a limb, so no limb could leave the frontal plane | Limbs are objects with named segments; an array always means `[theta, phi]` |
| Nothing checked a pose definition, so a malformed one scored people against a broken shape | Validated at load, and a bad one stops the app naming the field |
| Camera angle was scored as bad form — a correct Triangle 80° off-axis lost 37 points | Joints reading off the depth axis are reported `uncertain` and the user is told to turn; 30° off-axis now scores identically to head-on |
| `calcAngle` added an epsilon to the *product* of the magnitudes, so a straight limb read 179.9° in pixels and 179.7° in metres | Floored divisor; exactly 180° in both |
| `VIS_THRESHOLD` declared in two files that could not import each other | One definition in `pose-core.js`, imported by both |
| 1926 lines in one HTML file, with the entire scoring core untestable | Pure half split into `pose-core.js` and `coach.js`; 125 tests under `./tests/run.sh` |
| The video was `object-fit: cover` and the canvas, having none, was stretched — so on any phone whose aspect ratio differed from the camera's, every landmark and arrow was drawn where the body was not | One rule for both, and a test that they stay one rule |
| All feedback was visual, so the app only worked if you broke the pose to read it | Spoken coaching, a hold timer with a chime, and a hands-free session queue |
| **The landmarker never started.** MediaPipe's wasm glue calls `importScripts`, which a module worker does not have — so detection had never once run | A synchronous-XHR shim, and `tests/smoke.sh` to notice if it ever stops working again |
| A worker path that returned without replying wedged the pump permanently, leaving a frozen skeleton scored as live | Exactly one reply per frame, tested; plus a watchdog and a staleness cut-off |
| Scoring carried on regardless of whether there was anyone to score | A `lost` phase that pauses and says which of three things went wrong |
| Detection ran flat out, so on a slow device it starved the render loop and the camera | A measured frame budget pacing detection at 30, 15 or 10 Hz |
| Nine to twenty-nine megabytes behind a spinner that could not tell slow from dead | A streamed download with real byte counts, and a retry on failure |
| The screen slept mid-hold | A wake lock, re-taken when the page comes back |
| A denied camera raised an `alert()` that said the same thing whatever had happened | Four distinct diagnoses in the overlay, with a retry |
| An app giving physical-form feedback said nothing about what it can see | A first-run notice, and a standing line under the pose list |
| `serve.py` gave a traceback for a taken port, a traceback for a missing `openssl`, reused an expired certificate forever, and served everything cacheable | All four fixed, and each tested by causing it |
| No licence, so nobody could legally use any of it | MIT |
| The precache list was host-absolute, so a subpath deploy cached nothing at all | Relative paths, verified at a root and at `/yoga_app/` |
| App shell and runtime shared a cache version, so any deploy re-downloaded the model | Versioned apart, both guarded by tests |
| `updateTrackingUI` called with the wrong arity, working by accident | Fixed |
| A stale doc comment stacked above `buildTargetFigure` | Removed |

### Still open

Three, none of them a correctness problem. Ordered by how much damage each does.

1. **Rear camera flips the anatomy, not just the pixels.** The flip handler
   swaps `scaleX(-1)` on both video and canvas, keeping the overlay registered
   to the image. But the rig's `perp` vector assumes the user faces the camera.
   Side detection now partly papers over this — a body filmed from behind
   matches the mirrored variant, so the *shape* is right — but the side it
   reports is then the wrong one, and the arrows still point the wrong way.

2. **`currentModel` exists in both modules** with different meanings, and the
   model picker markup is duplicated verbatim in two places, kept in sync by
   `renderModelToggles()` querying `[data-model-seg]` globally.

3. **Per-frame allocation in the hot loop.** `reliableLandmarks` builds a `Set`
   and several closures per tick, and the side work now runs `matchSinglePose`
   twice. Negligible next to inference, but it is garbage on every frame.

### `serve.py`

Nothing outstanding. The four failures listed here at Phase 0 — a traceback on
a taken port, a traceback on a missing `openssl`, an expired certificate reused
forever, and no cache headers — are fixed, and each was tested by causing it.

---

## Where the fragility concentrates

Nowhere in particular any more, which is a change. What is left is a short list,
and none of it is a correctness problem in the scoring, the pump or the schema.

Worth recording how the two worst bugs were actually found, because neither was
found by reading code:

- The overlay was mapped to the screen differently from the video. It had been
  shipped, and looked at, and not seen — a desktop window is close enough to
  16:9 that the two agree.
- The landmarker never started. In every session, for the app's entire history,
  while 145 pure-function tests stayed green.

Both turned up from putting the real thing in front of a real browser and
looking at what came back. The pure suite is 185 assertions now and still could
not find either of them; `tests/smoke.sh` exists because a suite that cannot see
the thing that is broken is worse company than none.
