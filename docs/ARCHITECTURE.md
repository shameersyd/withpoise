# Architecture — Yoga Pose Tracker

A survey of `yoga_app/` and `serve.py` as they stand today. Descriptive only:
nothing here is a proposal, and nothing was changed to write it.

> **State of the tree.** `yoga_app/pose-worker.js` is untracked and
> `yoga_app/index.html` / `yoga_app/sw.js` carry ~600 lines of uncommitted
> changes on top of the single commit `de30946`. This document describes the
> **working tree**, not `HEAD`. At `HEAD` there is no worker, no One Euro
> filter, and inference runs on the main thread.

Files:

| File | Lines | Role |
|---|---|---|
| `yoga_app/index.html` | 1926 | Everything: markup, CSS, and one inline `<script type="module">` holding pose data, scoring, drawing and UI |
| `yoga_app/pose-worker.js` | 259 | MediaPipe landmarker + One Euro smoothing, off the main thread |
| `yoga_app/sw.js` | 72 | Service worker: app shell + CDN/model caching |
| `yoga_app/manifest.json` | 17 | PWA manifest |
| `serve.py` | 93 | Local HTTPS dev server with a self-signed cert |

There is no build step, no package manager, no test runner, and no dependency
manifest. MediaPipe is pulled from jsdelivr as an ES module at runtime; the
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
                                     matchSinglePose(angles, pose.angles, reliable)
                                     buildTargetFigure(...)
                                     drawGhost / drawSkeleton / updateTrackingUI
```

### Camera in

`startCamera()` (`index.html:1293`) requests `facingMode` (`"user"` by default)
at an ideal 1280×720 and pipes the stream into `<video id="video">`. On failure
it fires a blocking `alert()`.

### Pump

`startTrackingLoop()` (`index.html:1792`) installs a `requestAnimationFrame`
loop. Each tick:

1. bails if `video.readyState < 2`;
2. resizes the canvas backing store to `video.videoWidth × videoHeight`
   (`index.html:1799`);
3. calls `sendFrameToWorker()`;
4. draws using whatever result last arrived.

`sendFrameToWorker()` (`index.html:1547`) is gated on `frameInFlight`, so
exactly one frame is in flight at a time. It grabs an `ImageBitmap` from the
video element and transfers it to the worker with a `performance.now()`
timestamp. There is no fixed detection rate: detection runs as fast as the
worker can turn frames around, and the render loop runs at display rate
regardless.

**The render loop and the detection stream are not synchronised.** A rAF tick
paints `latestResult` even if it corresponds to a frame several display frames
old, and the same result may be painted many times.

### Inference

`handleFrame()` (`pose-worker.js:196`) forces a strictly increasing timestamp,
runs `detectForVideo`, times it (`inference`, posted back but currently
unused by the UI), then closes the bitmap in a `finally`.

Two landmark arrays come back and **both are smoothed and both are posted**:

- `result.landmarks[0]` — 33 landmarks, `x`/`y` normalized to `[0,1]` in image
  space, `z` a relative depth in roughly the same scale as `x`, plus
  `visibility`.
- `result.worldLandmarks[0]` — 33 landmarks in **metres**, origin at the hip
  midpoint, independent of where the person is in frame.

`smooth()` (`pose-worker.js:122`) runs an independent One Euro filter per
landmark per coordinate (`TUNING` at `pose-worker.js:37`, separate constants
for image vs. world because the units differ by ~3 orders of magnitude). A
landmark whose `visibility` is below `VIS_THRESHOLD` (0.5) does **not** feed
the filter — the filter's last output is held and the landmark comes back
flagged `held: true`. World landmarks are gated on the *image* landmarks'
visibility scores, which is the only place visibility is published.

### Landmarks → score

Per live tick (`index.html:1861`):

- `reliableLandmarks(landmarks)` (`index.html:1049`) builds a `Set` of joint
  names that are trustworthy this frame: not `held`, `visibility ≥ 0.5`, and
  within `[-0.02, 1.02]` in normalized image coords. Uses the **image**
  landmarks, since world landmarks carry no framing information.
- `computeAngles(world, landmarks, w, h)` (`index.html:683`) produces the eight
  joint angles.
- `matchSinglePose(angles, pose.angles, reliable)` (`index.html:1067`) compares
  each angle to its target. A joint whose three constituent landmarks aren't
  all in `reliable` is pushed to `unscored` and skipped entirely. For the rest:

  ```js
  const diff = Math.abs(actual - target);
  const ok = diff <= tolerance;          // hard threshold
  const direction = actual - target;     // sign picks the correction phrasing
  ```

  `score = (correct / total) * 100`, where `total` counts only scored joints.

### Score → pixels

Three consumers, all in the same tick:

- **`buildTargetFigure()`** (`index.html:1705`) — rebuilds the pose's reference
  figure using the user's own measured limb lengths and translates it so its
  hip midpoint sits on the user's hip midpoint. Returned in canvas pixels;
  shared by the outline and the correction arrows so both agree.
- **`drawGhost()`** (`index.html:1725`) — dashed target outline, coloured
  segment-by-segment by `ghostSegColor()` (`index.html:1674`): red touching a
  failing joint, green touching a passing one, grey where a landmark is
  untrusted, all-green when every scored joint passes.
- **`drawSkeleton()`** (`index.html:1104`) — the user's actual skeleton from
  *image* landmarks scaled by `w`/`h`; green/red/grey per segment, plus yellow
  nudge arrows from each failing joint toward its position in the target figure
  (capped at 70 px, suppressed under 12 px).
- **`updateTrackingUI()`** (`index.html:1218`) — score ring, the status card
  (percentage, verdict string, "N of M joints aligned · K hidden"), the
  corrections list (max 5 phrases from `CORRECTION_TIPS`), and the green
  full-screen `perfect-glow` at ≥95% with nothing hidden.

### Session phase machine

`trackPhase` (`index.html:1564`) runs `loading → framing → countdown → live`.
`framing` waits for all four `TORSO` landmarks to be reliable, holds for 500 ms,
then counts down 3 s before scoring starts. Nothing is scored and no
corrections are shown outside `live`.

---

## 2. Pose definitions

All five poses live in the `YOGA_POSES` object literal at `index.html:714`,
inside the inline script. There is no separate data file. Related lookup
tables sit alongside: `CORRECTION_TIPS` (`index.html:864`), `ANGLE_JOINTS`
(`index.html:666`), `BODY_PARTS` (`index.html:943`), `SEG_DEFAULT`
(`index.html:878`).

### Schema (as actually used by the code)

```js
key: {
  name:        string,        // "Warrior II"
  sanskrit:    string,
  emoji:       string,
  description: string,        // pose-selection card copy

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
}
```

**The `rig` grammar is overloaded and undocumented in code.** `dirVec()`
(`index.html:889`) accepts `theta` or `[theta, phi]`, where `theta` is degrees
in the image plane (0° = right, 90° = up) and `phi` tilts the segment out of
the frontal plane away from the camera. But `buildReference()`
(`index.html:906`) destructures `rig.arm_left` as `[thUpper, thFore]` — two
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
There are **no per-joint weights** and no side flag.

---

## 3. Does scoring use `landmarks` or `worldLandmarks`?

**Scoring uses `worldLandmarks` — metric 3D — with a fallback to image
landmarks scaled to pixels when world landmarks are absent.**

The relevant code, `computeAngles()` at `index.html:683`:

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

called at `index.html:1862` as `computeAngles(world, landmarks, w, h)` with
`world = latestResult.world`, which the worker fills from
`result.worldLandmarks[0]` (`pose-worker.js:229`). The fallback branch fires
only if MediaPipe returns no world landmarks — it is effectively dead code on
current tasks-vision builds, but it exists and is not flagged in the UI when
taken.

`calcAngle()` (`index.html:654`) is a genuine 3D angle: it includes the `z`
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

| Name | Line | Written by | Read by |
|---|---|---|---|
| `selectedPoseKey` | 1328 | `showGuide()` | guide loop, tracking loop, ghost/target builders, recap sheet |
| `isTracking` | 1329 | begin/back handlers | `renderFrame()` guard |
| `animFrameId` | 1330 | `renderFrame()` | back handler (cancel) |
| `facingMode` | 1290 | flip handler | `startCamera()` |
| `cameraStream` | 1291 | `startCamera()`, `stopCamera()` | both |
| `poseWorker` | 1492 | `startWorker()` | `sendFrameToWorker()`, `resetTrackPhase()` |
| `workerReady` | 1493 | `startWorker()`, worker `status` msg | `sendFrameToWorker()`, `resetTrackPhase()` |
| `frameInFlight` | 1494 | `sendFrameToWorker()`, worker `result` msg, `onerror` | `sendFrameToWorker()` |
| `latestResult` | 1495 | worker `result` msg, `startWorker()`, `resetTrackPhase()` | `renderFrame()` |
| `currentModel` | 1496 | `startWorker()` | `setModel()`, `renderModelToggles()` |
| `modelStatus` | 1497 | `startWorker()`, worker `status` msg, `onerror` | `renderModelToggles()`, `renderFrame()` overlay |
| `trackPhase` | 1564 | `startWorker()`, worker `status` msg, `resetTrackPhase()`, `renderFrame()` | `renderFrame()`, worker `status` msg |
| `countdownStart` | 1565 | `renderFrame()` | `renderFrame()` |
| `readySince` | 1566 | `renderFrame()`, `resetTrackPhase()`, worker `status` msg | `renderFrame()` |
| `ghostOn` | 1567 | ghost button | `renderFrame()` |
| `overlayState` | 1587 | `setOverlay()`, `hideOverlay()`, `resetTrackPhase()` | `setOverlay()`, `hideOverlay()` timeout |
| `bodyLengths` | 1629 | `measureBody()`, `resetBodyLengths()` | `measureBody()`, `buildTargetFigure()` |
| `demoStep` | 1356 | `setDemoStep()` | demo loop, dots, step list |
| `demoRAF` | 1357 | `startDemoLoop()`, `stopDemoLoop()` | both |
| `demoStepStart` | 1358 | `setDemoStep()`, `startDemoLoop()` | demo loop |
| `REFERENCE` | 940 | built once at load from every pose's rig | demo drawing, ghost fallback |
| `FIGURE_HEAD` | 937 | `buildReference()`, `buildTargetFigure()` | `headRadius()` |
| `canvas.width/height` | 1799 | `renderFrame()` | all drawing |

`trackPhase`, `readySince` and `latestResult` are each written from **three**
places including an async worker callback, which is the messiest corner of the
state.

### `pose-worker.js` module

| Name | Line | Written by | Read by |
|---|---|---|---|
| `imageFilters`, `worldFilters` | 110–111 | `makeFilters()`, `resetFilters()` | `smooth()` |
| `landmarker` | 156 | `init()` | `handleFrame()` |
| `currentModel` | 157 | `init()` | error messages |
| `lastTimestamp` | 158 | `init()`, `handleFrame()` | `handleFrame()` |

Plus per-filter internal state (`LowPass.y`, `tPrev`, `xPrev`) — 33 landmarks ×
3 coords × 2 spaces × 2 low-passes = 396 stateful filter objects, reset only by
an explicit `{type:"reset"}` message or a model reload.

### Persisted state

**None.** No `localStorage`, no cookies, no IndexedDB. Model choice, camera
choice and everything else reset on reload.

---

## 5. What's fragile, duplicated, or confusing

Ordered roughly by how much damage each one does.

### Correctness

1. **The overlay canvas can be misaligned with the video image.**
   `#video` is `object-fit: cover` (`index.html:297`) while `#canvas` is sized
   `100%/100%` with a backing store of `videoWidth × videoHeight`
   (`index.html:1799`) and no `object-fit`, so it **stretches** where the video
   **crops**. Whenever the stream's aspect ratio differs from the viewport's —
   the normal case for a 1280×720 request on a portrait phone — the skeleton,
   the target outline and every correction arrow are drawn at systematically
   wrong screen positions. This is invisible in a square-ish window and glaring
   on a phone.

2. **A worker-side detect error deadlocks tracking silently.**
   `handleFrame()`'s `catch` (`pose-worker.js:211`) posts a `status` message and
   returns without posting a `result`, so `frameInFlight` on the main thread is
   never cleared (`index.html:1533`) and no further frames are ever sent. The
   render loop keeps painting `latestResult` — a frozen skeleton scored as if
   live. The `!landmarker` early return (`pose-worker.js:198`) has the same
   shape.

3. **The score is a cliff, and it lies when joints are hidden.**
   `ok = diff <= tolerance` (`index.html:1084`) means a joint sitting on its
   boundary flips the outline red/green frame to frame and moves the aggregate
   in 12.5% steps. Worse, `unscored` joints are excluded from the denominator
   (`index.html:1092`), so a user with one visible arm can read **100%**. Only
   `perfect-glow` guards on `hidden === 0`; the headline number does not.

4. **Asymmetric poses are defined for one side only.** Warrior I (left knee
   bent, `index.html:767`), Warrior II (left knee bent, left arm lead), Triangle
   (left hand down) and Tree (left leg standing) all hard-code one side. A user
   who mirrors the pose — the natural thing to do for the second half of a
   practice — is scored as badly wrong on every leg and hip joint. There is no
   side flag, no mirroring, and no detection of which foot is forward.

5. **Rear camera flips the anatomy, not just the pixels.** The flip handler
   (`index.html:1316`) swaps `scaleX(-1)` on both video and canvas, keeping the
   overlay registered to the image. But the target outline is built from a rig
   whose `perp` vector is documented as "points to the body's anatomical left"
   (`index.html:912`) under the assumption that the user faces the camera.
   Nothing re-derives that when the user is filmed from behind, so the ghost's
   left and the user's left part company.

6. **`updateTrackingUI` is called with the wrong arity.**
   `resetTrackPhase()` calls `updateTrackingUI("", 0, {}, false)`
   (`index.html:1620`) against a `(poseName, match, detected)` signature. It
   happens to hit the intended early-return because `match = 0` is falsy, but
   the third argument is `{}` where `false` was meant. It works by accident.

7. **No handling of "the body left frame" as an event.** Losing the torso only
   matters before `live` (`torsoVisible`, `index.html:1583`); once live, joints
   silently drop out of the denominator and the session carries on scoring what
   remains. There is no pause, no message, and no way back to `framing`.

### Duplication

8. **`VIS_THRESHOLD = 0.5` is declared twice** — `pose-worker.js:31` and
   `index.html:1043` — in two files that cannot import from each other. They
   must agree for `held` and `reliable` to mean the same thing; nothing
   enforces it.

9. **Target angles duplicate the rig by hand.** Every pose states the same
   shape twice, once as segment directions and once as joint angles, with a
   comment claiming the second is derived from the first. Neither is checked
   against the other.

10. **`currentModel` exists in both modules** with different meanings, and the
    model picker markup is duplicated verbatim in two places
    (`index.html:546` and `index.html:606`), kept in sync by
    `renderModelToggles()` querying `[data-model-seg]` globally.

11. **Two stacked JSDoc blocks on `buildTargetFigure`** (`index.html:1696`–
    `1704`): the first describes `drawGhost` and is left over from a move.

### Structure / testability

12. **1926 lines in one HTML file with no module boundaries.** `calcAngle`,
    `computeAngles`, `matchSinglePose`, `buildReference` and `measureBody` are
    pure, self-contained functions trapped inside an inline `<script>`. Nothing
    can import them, so **no unit test can be written against the scoring core
    without first extracting it.** This is the single biggest blocker to
    Phase 1e, and Phase 1's changes are exactly the ones that need a
    regression net.

13. **No test harness, no `package.json`, no fixtures.** There is not one
    recorded landmark array in the repo.

14. **`reliableLandmarks` and `matchSinglePose` re-derive the same joint
    dependency** from `ANGLE_JOINTS` per frame, allocating a `Set` and several
    closures per tick. Not a bottleneck next to inference, but it's per-frame
    garbage in the hot loop.

### UX / platform gaps (Phase 2–3 territory, listed for completeness)

15. **All feedback is visual.** No audio of any kind — no speech, no tones —
    which is the core usability problem the app has.
16. **`inference` is measured and posted, then discarded.** No frame budget, no
    throttling, no adaptive rate.
17. **GPU→CPU fallback exists** (`pose-worker.js:177`) and is correct, but the
    fallback is announced through the same transient `status` message and is
    invisible afterwards.
18. **Model download shows no progress.** `loadStatus` prints a static
    "Loading pose model (~13 MB)…"; a stalled download is indistinguishable
    from a slow one, and there is no retry.
19. **No wake lock**, so the screen sleeps mid-hold.
20. **No orientation handling.** Rotating the device changes the viewport but
    nothing re-derives the canvas mapping (see #1, which it makes worse).
21. **`alert()` on camera denial** (`index.html:1304`) blocks the page and can't
    be recovered from without a reload.
22. **Service worker paths are host-root-absolute** — `ASSETS = ["/",
    "/index.html", ...]` (`sw.js:3`) — so the app shell fails to precache under
    any subpath deploy, which is the common case for a static host. The
    `RUNTIME_CACHE` holding the 13–30 MB model has no eviction and no way to
    switch models without orphaning the old one.
23. **No safety disclaimer.** The app tells people how to move their spine.

### `serve.py`

24. Bind failure raises a raw `OSError` traceback (`serve.py:57`) — the common
    "port 8443 already in use" case gives no useful message and no retry.
25. `generate_cert()` returns early if the files merely **exist**
    (`serve.py:36`) — an expired cert is reused forever, and a missing
    `openssl` binary raises `FileNotFoundError` from `subprocess.run` with no
    explanation.
26. `SimpleHTTPRequestHandler` sends no cache headers, so an edited
    `index.html` needs a hard reload on the phone — and now that a service
    worker is registered, a stale precache compounds it.
27. `os.chdir(DIR)` mutates process CWD for the lifetime of the server; the
    cert paths are resolved before it, which is the only reason this works.

---

## Where the fragility concentrates

Three places account for most of it:

- **The image-space ↔ canvas-space mapping** (#1, #5, #20) — one incorrect
  assumption that everything drawn inherits.
- **`matchSinglePose`'s binary, unweighted, hidden-joint-blind score** (#3, #4)
  — the number the whole product is judged on.
- **The absence of any seam to test through** (#12, #13) — which is why the
  first two have gone unnoticed.
