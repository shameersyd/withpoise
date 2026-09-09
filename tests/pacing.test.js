import { suite, test, assert, assertEqual, assertClose } from "./harness.js";
import { FrameBudget, DETECT_RATES, HEADROOM } from "../yoga_app/pacing.js";

suite("frame budget");

const settle = (budget, inferenceMs, n = 60) => {
  for (let i = 0; i < n; i++) budget.record(inferenceMs);
  return budget.hz;
};

test("a device that can keep up is left alone at full rate", () => {
  assertEqual(settle(new FrameBudget(), 8), 30);
});

test("a device that cannot keep up is paced, not starved", () => {
  // 30ms of inference cannot sustain a 33ms period whatever you do to it. The
  // choice is between a stable 15Hz and an unstable something-under-30 that
  // takes the render loop down with it.
  assertEqual(settle(new FrameBudget(), 30), 15);
  assertEqual(settle(new FrameBudget(), 70), 10);
  assertEqual(settle(new FrameBudget(), 250), 10, "and 10Hz is the floor");
});

test("the first samples are not trusted", () => {
  // The first inference of a session includes warm-up and is not evidence.
  const budget = new FrameBudget();
  budget.record(400);
  assertEqual(budget.hz, 30, "still optimistic");
  budget.record(400); budget.record(400);
  assert(budget.hz < 30, "but not indefinitely");
});

test("a rate near a boundary does not oscillate", () => {
  // Right on the edge between 30Hz and 15Hz. Without a step-up margin this
  // flips every few frames, and every flip changes the sampling interval that
  // the smoothing filter and the hold timer are working from.
  const budget = new FrameBudget();
  const edge = (1000 / 30) * HEADROOM;        // exactly affordable at 30Hz
  settle(budget, edge + 1);
  const settled = budget.hz;
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    budget.record(edge + (i % 2 ? 1.5 : -1.5));
    seen.add(budget.hz);
  }
  assertEqual(seen.size, 1, `rate wobbled between ${[...seen].join(" and ")}`);
  assertEqual(budget.hz, settled);
});

test("it steps down at once and back up only when clearly affordable", () => {
  const budget = new FrameBudget();
  settle(budget, 5);
  assertEqual(budget.hz, 30);

  // A sudden slowdown — another app woke up, or the phone throttled.
  settle(budget, 60);
  assertEqual(budget.hz, 10, "dropped");

  // Recovery has to be convincing before the rate climbs again.
  settle(budget, 26, 200);
  assertEqual(budget.hz, 15, "part way back");
  settle(budget, 4, 200);
  assertEqual(budget.hz, 30, "all the way back");
});

test("pacing is independent of how often it is asked", () => {
  // The render loop runs at display rate and asks every frame; detection must
  // come out at the chosen rate regardless.
  const budget = new FrameBudget();
  settle(budget, 30);
  assertEqual(budget.hz, 15);

  const at = [];
  for (let t = 0; t < 10000; t += 1000 / 120) {   // asked at 120Hz for ten seconds
    if (budget.due(t)) { budget.markSent(t); at.push(t); }
  }

  // Never faster than the chosen rate is the invariant that matters — the
  // budget exists to stop detection eating the device. Slightly slower is
  // expected and harmless: the send lands on the next poll after the interval
  // elapses, so it can only ever slip late, never early.
  for (let i = 1; i < at.length; i++) {
    assert(at[i] - at[i - 1] >= budget.intervalMs - 1e-9,
      `${(at[i] - at[i - 1]).toFixed(2)}ms apart, faster than the ${budget.intervalMs.toFixed(2)}ms budget`);
  }
  assert(at.length <= 151, `${at.length} detections in ten seconds is over budget`);
  assert(at.length >= 135, `${at.length} detections is more slippage than expected`);
});

test("the very first frame is due immediately", () => {
  assert(new FrameBudget().due(0), "nothing should wait for the clock to start");
});

test("a nonsense measurement is ignored", () => {
  const budget = new FrameBudget();
  settle(budget, 8);
  budget.record(NaN);
  budget.record(-1);
  budget.record(undefined);
  assertEqual(budget.hz, 30, "and does not drag the average anywhere");
});

test("resetting forgets the device it was measuring", () => {
  const budget = new FrameBudget();
  settle(budget, 200);
  assertEqual(budget.hz, 10);
  budget.reset();
  assertEqual(budget.hz, DETECT_RATES[0], "a model swap starts optimistic again");
});
