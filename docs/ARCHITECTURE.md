# Architecture — Yoga Pose Tracker

A survey of `yoga_app/` and `serve.py` as they stand today. Descriptive only:
nothing here is a proposal, and nothing was changed to write it.

> **Currency.** Written at Phase 0 of `CLAUDE_CODE_BRIEF.md` and updated at the
> end of Phase 1. Sections 1–4 describe the code as it stands; section 5 marks
> what Phase 1 fixed and what is still open.

Files:

| File | Role |
|---|---|
| `yoga_app/index.html` | Markup, CSS, and one inline `<script type="module">`: the DOM, the canvas, the camera and all session state |
| `yoga_app/pose-core.js` | The pure half — angle math, reliability, camera geometry, scoring, mirroring, smoothing, latching. No DOM, no canvas, no worker |
| `yoga_app/poses.js` | The five pose definitions and the correction phrasings |
| `yoga_app/pose-worker.js` | MediaPipe landmarker and the detect loop, off the main thread |
| `yoga_app/sw.js` | Service worker: app shell + CDN/model caching |
| `yoga_app/manifest.json` | PWA manifest |
| `serve.py` | Local HTTPS dev server with a self-signed cert |
| `tests/` | Harness, fixtures and suites, run by `./tests/run.sh` |

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

`handleFrame()` (`pose-worker.js`) forces a strictly increasing timestamp,
runs `detectForVideo`, times it (`inference`, posted back but currently
unused by the UI), then closes the bitmap in a `finally`.

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

### Session phase machine

`trackPhase` (`index.html`) runs `loading → framing → countdown → live`.
`framing` waits for all four `TORSO` landmarks to be reliable, holds for 500 ms,
then counts down 3 s before scoring starts. Nothing is scored and no
corrections are shown outside `live`.

---

## 2. Pose definitions

All five poses live in the `YOGA_POSES` object literal at `index.html`,
inside the inline script. There is no separate data file. Related lookup
tables sit alongside: `CORRECTION_TIPS` (`index.html`), `ANGLE_JOINTS`
(`index.html`), `BODY_PARTS` (`index.html`), `SEG_DEFAULT`
(`index.html`).

### Schema (as actually used by the code)

```js
key: {
  name:        string,        // "Warrior II"
  sanskrit:    string,
  emoji:       string,
  description: string,        // pose-selection card copy

  symmetric:   true,          // or omitted, in which case:
  side:        "left",        // which mirror this definition is written for

  steps: [                    // drives the walkthrough + the animated demo
    { text: string,
      focus: Array<"torso"|"head"|"left_arm"|"right_arm"|"left_leg"|"right_leg"> }
  ],
  tips: [ { icon: string, text: string } ],

  rig: {                      // segment directions → the demo figure + outline
    torso:    theta | [theta, phi],
    arm_left: [thetaUpper, thetaFore],     // NOTE: 2 scalars, not [theta,phi]
    arm_right:[thetaUpper, thetaFore],
    leg_left: [thetaThigh, thetaShin],
    leg_right:[thetaThigh, thetaShin],
  },

  angles: {                   // the eight scored joints
    left_knee: [targetDeg, toleranceDeg], right_knee: [...],
    left_hip:  [...],  right_hip:  [...],
    left_shoulder: [...], right_shoulder: [...],
    left_elbow: [...], right_elbow: [...],
  },

  weights: {                  // how much of the pose each joint is
    left_knee: 3, ...         // relative within a pose; only ratios matter
  },
}
```

An asymmetric pose is stored once. `sidesOf(pose)` returns it and its mirror,
and `mirrorPose` derives the second from the first: the rig reflects across the
sagittal plane (θ → 180 − θ, φ untouched), targets and weights swap joints,
`focus` swaps body parts, and the words "left" and "right" swap in the
instruction text.

**The `rig` grammar is overloaded and undocumented in code.** `dirVec()`
(`index.html`) accepts `theta` or `[theta, phi]`, where `theta` is degrees
in the image plane (0° = right, 90° = up) and `phi` tilts the segment out of
the frontal plane away from the camera. But `buildReference()`
(`index.html`) destructures `rig.arm_left` as `[thUpper, thFore]` — two
*segment* directions, each then passed to `dirVec()` as a bare scalar. So the
same two-element array notation means "theta, phi" at one level and
"upper segment, lower segment" at another. Every pose in the file uses only
scalar directions inside the limb pairs, so no `phi` is currently expressible
for a limb — only for `torso`.

The comment above `YOGA_POSES` claims "each target is derived from the rig
above it". **No code does this.** `angles` are hand-entered constants that
happen to correspond to the rig. Nothing validates them against each other and
nothing would notice if they drifted.

The eight joints are fixed by `ANGLE_JOINTS` and cannot be extended per-pose.

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

**None.** No `localStorage`, no cookies, no IndexedDB. Model choice, camera
choice and everything else reset on reload.

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
| Camera angle was scored as bad form — a correct Triangle 80° off-axis lost 37 points | Joints reading off the depth axis are reported `uncertain` and the user is told to turn; 30° off-axis now scores identically to head-on |
| `calcAngle` added an epsilon to the *product* of the magnitudes, so a straight limb read 179.9° in pixels and 179.7° in metres | Floored divisor; exactly 180° in both |
| `VIS_THRESHOLD` declared in two files that could not import each other | One definition in `pose-core.js`, imported by both |
| 1926 lines in one HTML file, with the entire scoring core untestable | Pure half split into `pose-core.js`; 89 tests under `./tests/run.sh` |
| `updateTrackingUI` called with the wrong arity, working by accident | Fixed |
| A stale doc comment stacked above `buildTargetFigure` | Removed |

### Still open

Ordered roughly by how much damage each one does.

1. **The overlay canvas can be misaligned with the video image.**
   `#video` is `object-fit: cover` while `#canvas` is sized `100%/100%` with a
   backing store of `videoWidth × videoHeight` and no `object-fit`, so it
   **stretches** where the video **crops**. Whenever the stream's aspect ratio
   differs from the viewport's — the normal case for a 1280×720 request on a
   portrait phone — the skeleton, the target outline and every correction arrow
   are drawn at systematically wrong screen positions. Invisible in a squarish
   window and glaring on a phone. *Not in the brief; it undercuts all of Phase
   1's work on where the arrows point.*

2. **A worker-side detect error deadlocks tracking silently.**
   `handleFrame()`'s `catch` posts a `status` message and returns without
   posting a `result`, so `frameInFlight` is never cleared and no further frames
   are sent. The render loop keeps painting `latestResult` — a frozen skeleton,
   scored as live. The `!landmarker` early return has the same shape. *Phase 3.*

3. **No handling of "the body left frame" as an event.** Losing the torso only
   matters before `live`; once live, joints drop out of the denominator and the
   session carries on. Coverage now makes this visible in the UI, but there is
   still no pause and no way back to `framing`. *Phase 3.*

4. **Rear camera flips the anatomy, not just the pixels.** The flip handler
   swaps `scaleX(-1)` on both video and canvas, keeping the overlay registered
   to the image. But the rig's `perp` vector assumes the user faces the camera.
   Side detection now partly papers over this — a body filmed from behind
   matches the mirrored variant, so the *shape* is right — but the side it
   reports is then the wrong one, and the arrows still point the wrong way.

5. **Target angles duplicate the rig by hand.** Every pose states the same shape
   twice, once as segment directions and once as joint angles, with a comment
   claiming the second is derived from the first. Nothing derives it and nothing
   checks it. The fixtures now prove the two currently agree, which is what
   makes deriving them a safe change. *Phase 4.*

6. **The `rig` grammar is overloaded.** A two-element array means `[theta, phi]`
   at the torso and `[upperSegment, lowerSegment]` inside a limb. No limb can
   currently express a `phi` at all — which is why every pose in the file is
   planar. *Phase 4.*

7. **`currentModel` exists in both modules** with different meanings, and the
   model picker markup is duplicated verbatim in two places, kept in sync by
   `renderModelToggles()` querying `[data-model-seg]` globally.

8. **Per-frame allocation in the hot loop.** `reliableLandmarks` builds a `Set`
   and several closures per tick, and the side work now runs `matchSinglePose`
   twice. Negligible next to inference, but it is garbage on every frame.

9. **All feedback is visual.** No audio of any kind. The core usability problem:
   you cannot look at a phone while holding Triangle. *Phase 2.*

10. **`inference` is measured and posted, then discarded.** No frame budget, no
    throttling, no adaptive rate. *Phase 3.*

11. **Model download shows no progress.** A stalled download is
    indistinguishable from a slow one, and there is no retry. *Phase 3.*

12. **No wake lock**, so the screen sleeps mid-hold. *Phase 3.*

13. **No orientation handling.** Rotating the device changes the viewport but
    nothing re-derives the canvas mapping — see #1, which it makes worse.
    *Phase 3.*

14. **`alert()` on camera denial** blocks the page and cannot be recovered from
    without a reload.

15. **Service worker paths are host-root-absolute** — `ASSETS = ["/",
    "/index.html", ...]` — so the app shell fails to precache under any subpath
    deploy, the common case for a static host. `pose-core.js` and `poses.js` are
    also missing from the precache list and from the network-first `isAppCode`
    test, so they will be served stale after an edit. The `RUNTIME_CACHE`
    holding the 13–30 MB model has no eviction. *Phase 3.*

16. **No safety disclaimer.** The app tells people how to move their spine.
    *Phase 5.*

17. **The GPU→CPU fallback is announced through a transient `status` message**
    and is invisible afterwards, so a user on the slow path never learns why.

### `serve.py`

18. Bind failure raises a raw `OSError` traceback — the common "port 8443
    already in use" case gives no useful message and no retry.
19. `generate_cert()` returns early if the files merely **exist**, so an expired
    cert is reused forever, and a missing `openssl` binary raises
    `FileNotFoundError` from `subprocess.run` with no explanation.
20. `SimpleHTTPRequestHandler` sends no cache headers, so an edited file needs a
    hard reload on the phone — and with a service worker registered, a stale
    precache compounds it.
21. `os.chdir(DIR)` mutates process CWD for the lifetime of the server; the cert
    paths are resolved before it, which is the only reason this works.

---

## Where the fragility concentrates

Two places now account for most of it:

- **The image-space ↔ canvas-space mapping** (#1, #4, #13) — one incorrect
  assumption that everything drawn inherits, and the largest remaining
  correctness problem in the app.
- **The frame pump's error paths** (#2, #3, #10) — the loop is happy to keep
  painting a result that will never be replaced.

The scoring core is no longer on that list, and the reason is #12 in the fixed
table rather than any of the individual fixes above it.
