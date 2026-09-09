import { suite, test, assert, assertEqual, assertClose } from "./harness.js";
import { OneEuroFilter, TUNING, makeFilters, smooth, VIS_THRESHOLD } from "../yoga_app/pose-core.js";

suite("temporal smoothing");

const FRAME = 1 / 30;

/** Deterministic pseudo-noise, so a flaky test is impossible. */
function noise(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) - 0.5;
  };
}

const stdev = (xs) => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
};

test("a still signal converges onto its value", () => {
  const f = new OneEuroFilter(TUNING.image);
  let out = 0;
  for (let i = 0; i < 90; i++) out = f.filter(0.42, i * FRAME);
  assertClose(out, 0.42, 1e-6, "three seconds of stillness");
});

test("smoothing removes most of the jitter from a held joint", () => {
  const rand = noise(7);
  const f = new OneEuroFilter(TUNING.image);
  const raw = [], smoothed = [];
  for (let i = 0; i < 150; i++) {
    const x = 0.5 + rand() * 0.02;          // ±1% of frame, about what a still body gives
    raw.push(x);
    smoothed.push(f.filter(x, i * FRAME));
  }
  const before = stdev(raw.slice(50)), after = stdev(smoothed.slice(50));
  assert(after < before * 0.5, `jitter ${before.toFixed(5)} → ${after.toFixed(5)}`);
});

test("a fast move lags far less than fixed smoothing of the same strength", () => {
  // The defining claim of One Euro, and the reason the brief rules out a moving
  // average: the cutoff rises with speed, so it can be as steady at rest as a
  // fixed low-pass while trailing a moving joint by much less. beta = 0 turns
  // off exactly that adaptation and nothing else, which makes it the honest
  // control — identical at rest by construction.
  const euro = new OneEuroFilter(TUNING.image);
  const fixed = new OneEuroFilter({ ...TUNING.image, beta: 0 });

  let e = 0, f = 0;
  for (let i = 0; i < 15; i++) {
    const truth = 0.2 + i * 0.04;          // a wrist crossing the frame in half a second
    e = euro.filter(truth, i * FRAME);
    f = fixed.filter(truth, i * FRAME);
  }
  const truth = 0.2 + 14 * 0.04;
  const euroLag = Math.abs(truth - e), fixedLag = Math.abs(truth - f);
  assert(euroLag < fixedLag * 0.8,
    `one euro ${euroLag.toFixed(3)} vs fixed ${fixedLag.toFixed(3)}`);
  // Roughly three frames behind on a motion this violent; a held yoga pose
  // moves nothing like this fast.
  assert(euroLag < 0.15, `absolute lag ${euroLag.toFixed(3)} of the frame`);
});

test("smoothing is heavier when still than when moving", () => {
  // The defining property: the cutoff rises with speed, so the filter is both
  // steady at rest and responsive in motion.
  const still = new OneEuroFilter(TUNING.image);
  const moving = new OneEuroFilter(TUNING.image);
  for (let i = 0; i < 40; i++) {
    still.filter(0.5, i * FRAME);
    moving.filter(0.5 + i * 0.03, i * FRAME);
  }
  const t = 40 * FRAME;
  const stillJump = Math.abs(still.filter(0.6, t) - 0.5);
  const movingBase = moving.x.value;
  const movingJump = Math.abs(moving.filter(movingBase + 0.1, t) - movingBase);
  assert(movingJump > stillJump, `moving ${movingJump.toFixed(4)} vs still ${stillJump.toFixed(4)}`);
});

suite("smoothing a landmark array");

const frameOf = (x, visibility) =>
  Array.from({ length: 33 }, () => ({ x, y: 0.5, z: 0, visibility }));

test("a confidently seen landmark is smoothed and not flagged", () => {
  const filters = makeFilters(TUNING.image);
  let out;
  for (let i = 0; i < 60; i++) out = smooth(frameOf(0.3, 1), filters, i * FRAME);
  assertEqual(out.length, 33, "every landmark comes back");
  assertEqual(out[0].held, false, "not held");
  assertClose(out[0].x, 0.3, 1e-6, "converged");
});

test("a landmark that dims holds its last good position and says so", () => {
  const filters = makeFilters(TUNING.image);
  for (let i = 0; i < 60; i++) smooth(frameOf(0.3, 1), filters, i * FRAME);

  // The measurement leaps across the frame just as confidence collapses — the
  // shape of a real occlusion, and exactly what must not reach the score.
  const out = smooth(frameOf(0.9, 0.2), filters, 60 * FRAME);
  assertEqual(out[0].held, true, "flagged as held");
  assertClose(out[0].x, 0.3, 1e-3, "kept the smoothed history, ignored the leap");
});

test("the visibility threshold is inclusive", () => {
  const filters = makeFilters(TUNING.image);
  smooth(frameOf(0.3, 1), filters, 0);
  assertEqual(smooth(frameOf(0.3, VIS_THRESHOLD), filters, FRAME)[0].held, false, "at threshold");
  assertEqual(smooth(frameOf(0.3, VIS_THRESHOLD - 0.01), filters, 2 * FRAME)[0].held, true, "below it");
});

test("a landmark never yet seen falls back to the raw measurement", () => {
  const filters = makeFilters(TUNING.image);
  const out = smooth(frameOf(0.7, 0.1), filters, 0);
  assertEqual(out[0].held, true, "still flagged — there is no history to trust");
  assertClose(out[0].x, 0.7, 1e-9, "nothing better to report than the guess");
});

test("explicit visibilities override the ones on the points", () => {
  // The worker gates world landmarks on the *image* landmarks' visibility,
  // since world landmarks carry no framing information of their own.
  const filters = makeFilters(TUNING.world);
  const pts = frameOf(0.3, 1);
  const out = smooth(pts, filters, 0, pts.map(() => 0.1));
  assertEqual(out[0].held, true, "the passed-in visibility wins");
});
