import { suite, test, assert, assertEqual, assertClose, assertDeepEqual } from "./harness.js";
import { HoldTimer, Session, Coach, rankCorrections, SPEECH, FRAMING_GRACE_MS } from "../yoga_app/coach.js";

suite("hold timer");

/** Feed the timer a run of frames at 30fps. */
function run(timer, frames, startAt = 0) {
  const events = [];
  let t = startAt;
  for (const correct of frames) {
    events.push({ t, ...timer.update(correct, t) });
    t += 1000 / 30;
  }
  return events;
}

const steady = (seconds, correct = true) =>
  Array.from({ length: Math.round(seconds * 30) }, () => correct);

test("a pose held long enough completes, once", () => {
  const timer = new HoldTimer({ seconds: 3 });
  const events = run(timer, steady(4));
  const completions = events.filter(e => e.justCompleted);
  assertEqual(completions.length, 1, "exactly one completion");
  assertClose(completions[0].t / 1000, 3, 0.1, "at three seconds");
  assertEqual(events[events.length - 1].state, "complete");
});

test("the clock does not start until the pose is right", () => {
  const timer = new HoldTimer({ seconds: 3 });
  const events = run(timer, [...steady(2, false), ...steady(3.2, true)]);
  assertEqual(events.filter(e => e.justStarted).length, 1);
  const done = events.find(e => e.justCompleted);
  assertClose(done.t / 1000, 5, 0.15, "three seconds after it became right");
});

test("a brief wobble pauses the clock instead of resetting it", () => {
  // A landmark dipping below its visibility threshold for a few frames must not
  // throw away a nine-second hold. The user would have no idea why.
  const timer = new HoldTimer({ seconds: 3, graceMs: 900 });
  const events = run(timer, [
    ...steady(2, true),
    ...steady(0.5, false),     // inside the grace
    ...steady(1.2, true),
  ]);
  assertEqual(events.filter(e => e.justLost).length, 0, "not lost");
  assertEqual(events.filter(e => e.justStarted).length, 1, "and not restarted");
  assert(events.some(e => e.justCompleted), "it still completes");
  const done = events.find(e => e.justCompleted);
  assertClose(done.t / 1000, 3.5, 0.2, "half a second later than an unbroken hold");
});

test("a real break starts the hold over", () => {
  const timer = new HoldTimer({ seconds: 3, graceMs: 900 });
  const events = run(timer, [
    ...steady(2, true),
    ...steady(1.5, false),     // past the grace
    ...steady(2, true),
  ]);
  assertEqual(events.filter(e => e.justLost).length, 1, "lost once");
  assertEqual(events.filter(e => e.justStarted).length, 2, "and started again");
  assertEqual(events.filter(e => e.justCompleted).length, 0,
    "two seconds is not three, however they are added up");
});

test("the last seconds are counted, each exactly once", () => {
  const timer = new HoldTimer({ seconds: 5, countFrom: 3 });
  const ticks = run(timer, steady(6)).filter(e => e.tick != null).map(e => e.tick);
  assertDeepEqual(ticks, [3, 2, 1], "counted down, no repeats");
});

test("completion does not also emit a tick", () => {
  const timer = new HoldTimer({ seconds: 2, countFrom: 5 });
  const done = run(timer, steady(3)).find(e => e.justCompleted);
  assertEqual(done.tick, null, "the chime is the signal, not another number");
});

test("a completed hold clears when the user comes out of the pose", () => {
  const timer = new HoldTimer({ seconds: 2 });
  const events = run(timer, [...steady(2.5, true), ...steady(1, false), ...steady(2.5, true)]);
  assertEqual(events.filter(e => e.justCompleted).length, 2, "and can be held again");
});

test("remaining never goes negative", () => {
  const timer = new HoldTimer({ seconds: 2 });
  for (const e of run(timer, steady(6))) assert(e.remaining >= 0, `${e.remaining}`);
});

suite("session");

const sided = (keys, symmetric = []) =>
  Object.fromEntries(keys.map(k => [k, !symmetric.includes(k)]));

test("a symmetric pose is one hold", () => {
  const s = new Session(["mountain"], sided(["mountain"], ["mountain"]));
  assertDeepEqual(s.remainingSides(), [null]);
  const r = s.complete(null);
  assert(r.counted && r.advanced && r.finished);
});

test("an asymmetric pose needs both sides, in either order", () => {
  for (const first of ["left", "right"]) {
    const s = new Session(["warrior1"], sided(["warrior1"]));
    const one = s.complete(first);
    assert(one.counted, "counted");
    assert(!one.advanced, "not done yet");
    assert(one.otherSide, "and it says so");
    assertDeepEqual(s.remainingSides(), [first === "left" ? "right" : "left"]);

    const two = s.complete(first === "left" ? "right" : "left");
    assert(two.counted && two.advanced && two.finished, `starting on the ${first}`);
  }
});

test("holding the same side twice does not count twice", () => {
  const s = new Session(["triangle"], sided(["triangle"]));
  s.complete("left");
  const again = s.complete("left");
  assertEqual(again.counted, false, "not counted");
  assertEqual(again.advanced, false, "and it does not move on");
  assertEqual(again.otherSide, true, "the other side is still owed");
});

test("the queue runs in order and reports where it is", () => {
  const keys = ["mountain", "warrior1", "tree"];
  const s = new Session(keys, sided(keys, ["mountain"]));
  assertEqual(s.length, 3);
  assertEqual(s.position, 1);
  assertEqual(s.current.key, "mountain");

  s.complete(null);
  assertEqual(s.current.key, "warrior1");
  assertEqual(s.position, 2);

  s.complete("left");
  assertEqual(s.current.key, "warrior1", "still, until both sides are done");
  s.complete("right");
  assertEqual(s.current.key, "tree");

  s.complete("left");
  s.complete("right");
  assert(s.finished, "and then it is over");
  assertEqual(s.current, null);
  assertDeepEqual(s.remainingSides(), []);
});

test("completing a finished session is harmless", () => {
  const s = new Session(["mountain"], sided(["mountain"], ["mountain"]));
  s.complete(null);
  const after = s.complete(null);
  assertEqual(after.finished, true);
  assertEqual(after.counted, false);
});

suite("coaching policy");

const CORRECTIONS = [
  { joint: "left_elbow", text: "Straighten your left arm" },
  { joint: "left_knee", text: "Straighten your left knee" },
];
const RESULTS = {
  left_elbow: { weight: 1, quality: 0.2 },
  left_knee: { weight: 3, quality: 0.1 },
};

const liveState = (over = {}) => ({
  phase: "live", detected: true, correct: false,
  corrections: CORRECTIONS, results: RESULTS,
  needsTurn: false, tooLittleVisible: false,
  hold: { state: "idle", remaining: 10, tick: null,
          justStarted: false, justCompleted: false, justLost: false },
  ...over,
});

test("the worst fault is the one spoken", () => {
  // Severity is weight × how wrong, so the knee outranks the elbow even though
  // the elbow is listed first and is nearly as far out.
  const ranked = rankCorrections(CORRECTIONS, RESULTS);
  assertEqual(ranked[0].joint, "left_knee");
  assertClose(ranked[0].severity, 2.7, 1e-9);
  assertEqual(new Coach().update(liveState(), 100000).text, "Straighten your left knee.");
});

test("an unranked correction still ranks", () => {
  const ranked = rankCorrections([{ joint: "x", text: "t" }], {});
  assertEqual(ranked[0].severity, 1, "a missing weight is one, a missing quality is zero");
});

test("the count-in names the pose once, then counts", () => {
  const coach = new Coach();
  const said = [];
  for (const [t, n] of [[0, 3], [100, 3], [1000, 2], [2000, 1], [2100, 1]]) {
    const u = coach.update({ phase: "countdown", poseLabel: "Warrior One", countdown: n }, t);
    if (u) said.push(u.text);
  }
  assertDeepEqual(said, ["Warrior One", "3", "2", "1"]);
});

test("the count-in says where you are in the session", () => {
  const u = new Coach().update(
    { phase: "countdown", poseLabel: "Tree Pose", sessionNote: "2 of 5", countdown: 3 }, 0);
  assertEqual(u.text, "2 of 5. Tree Pose");
});

test("nothing is said before the count-in", () => {
  const coach = new Coach();
  assertEqual(coach.update({ phase: "framing", detected: true }, 0), null);
  assertEqual(coach.update({ phase: "loading" }, 1000), null);
});

test("corrections are throttled hard", () => {
  const coach = new Coach();
  const said = [];
  // Two solid minutes of a badly held pose, at thirty frames a second.
  for (let f = 0; f < 60 * 30 * 2; f++) {
    const u = coach.update(liveState(), f * (1000 / 30));
    if (u) said.push({ t: f * (1000 / 30), text: u.text });
  }
  assert(said.length <= 12, `two minutes produced ${said.length} utterances`);
  for (let i = 1; i < said.length; i++) {
    assert(said[i].t - said[i - 1].t >= SPEECH.minGapMs - 1,
      `only ${said[i].t - said[i - 1].t}ms between utterances`);
  }
});

test("the same instruction is not repeated inside its window", () => {
  const coach = new Coach();
  const only = [{ joint: "left_knee", text: "Straighten your left knee" }];
  const state = liveState({ corrections: only });
  assertEqual(coach.update(state, 0).text, "Straighten your left knee.");
  assertEqual(coach.update(state, SPEECH.minGapMs + 1), null, "too soon to say it again");
  assert(coach.update(state, SPEECH.repeatGapMs + 1), "but eventually, yes");
});

test("the pose going right is announced, once", () => {
  const coach = new Coach();
  const holding = liveState({
    correct: true,
    hold: { state: "holding", remaining: 9.8, tick: null,
            justStarted: true, justCompleted: false, justLost: false },
  });
  assertEqual(coach.update(holding, 0).text, "That's it. Hold for 10 seconds.");
  assertEqual(coach.update({ ...holding, hold: { ...holding.hold, justStarted: false } }, 100),
    null, "and then it is quiet");
});

test("a held pose is left in peace", () => {
  const coach = new Coach();
  coach.update(liveState({ correct: true,
    hold: { state: "holding", remaining: 9, tick: null, justStarted: true } }), 0);
  let spoken = 0;
  for (let f = 1; f < 300; f++) {
    if (coach.update(liveState({ correct: true,
      hold: { state: "holding", remaining: 9 - f / 30, tick: null } }), f * 33)) spoken++;
  }
  assertEqual(spoken, 0, "ten seconds of a correct hold, nothing said");
});

test("the countdown and the completion are spoken over anything else", () => {
  const coach = new Coach();
  const tick = coach.update(liveState({ correct: true,
    hold: { state: "holding", remaining: 3.02, tick: 3 } }), 0);
  assertEqual(tick.text, "3");
  assert(tick.interrupt, "a countdown two seconds late is worse than none");

  const done = coach.update(liveState({ correct: true,
    hold: { state: "complete", remaining: 0, justCompleted: true } }), 100);
  assertEqual(done.text, "Nice. Come out of it.");
});

test("framing beats form, because no correction can fix it", () => {
  const coach = new Coach();
  assertEqual(coach.update(liveState({ needsTurn: true }), 0).text,
    "Turn to face the camera.");
  assertEqual(coach.update(liveState({ tooLittleVisible: true }), 100000).text,
    "Step back so I can see all of you.");
});

test("framing advice is rarer than corrections", () => {
  const coach = new Coach();
  const state = liveState({ needsTurn: true });
  coach.update(state, 0);
  assertEqual(coach.update(state, SPEECH.minGapMs + 1), null, "not yet");
  assert(coach.update(state, SPEECH.framingGapMs + 1), "now");
});

test("nothing is said about a body that is not there", () => {
  assertEqual(new Coach().update(liveState({ detected: false }), 100000), null);
});

test("moving to the next pose forgets the last one's throttle", () => {
  const coach = new Coach();
  assert(coach.update(liveState(), 0), "said something");
  coach.nextPose();
  const u = coach.update({ phase: "countdown", poseLabel: "Tree Pose", countdown: 3 }, 10);
  assertEqual(u.text, "Tree Pose", "the new pose is announced immediately");
});

test("a whole silent minute of good practice says almost nothing", () => {
  // The shape of a real hold: get into it, hold it out, come out. Anything more
  // than a handful of utterances here and the user mutes the app, and a muted
  // app coaches nobody.
  const coach = new Coach();
  const timer = new HoldTimer({ seconds: 10 });
  const said = [];
  for (let f = 0; f < 60 * 30; f++) {
    const t = f * (1000 / 30);
    const correct = f > 90 && f < 90 + 10 * 30 + 5;
    const hold = timer.update(correct, t);
    const u = coach.update(liveState({ correct, hold, corrections: correct ? [] : CORRECTIONS }), t);
    if (u) said.push(u.text);
  }
  assert(said.length <= 12, `a minute produced ${said.length}: ${said.join(" / ")}`);
  assert(said.includes("Nice. Come out of it."), "but it did say the hold was done");
  assertDeepEqual(said.filter(x => x === "5" || x === "1"), ["5", "1"],
    "and counted the last seconds exactly once each");
});

test("one instruction at a time, until it is acted on", () => {
  // The knee is the worst fault and the elbow is also wrong. Telling the user
  // about the elbow while they are still working on the knee is how a throttle
  // of "one every few seconds" becomes a running commentary again.
  const coach = new Coach();
  const state = liveState();
  assertEqual(coach.update(state, 0).text, "Straighten your left knee.");

  let spoken = 0;
  for (let t = 100; t < SPEECH.repeatGapMs; t += 100) {
    if (coach.update(state, t)) spoken++;
  }
  assertEqual(spoken, 0, "nothing else is said while the knee is still wrong");
  assertEqual(coach.update(state, SPEECH.repeatGapMs + 1).text,
    "Straighten your left knee.", "and the reminder is the same instruction");
});

test("fixing the fault moves the coaching straight on to the next", () => {
  const coach = new Coach();
  assertEqual(coach.update(liveState(), 0).text, "Straighten your left knee.");

  // Knee sorted; only the elbow is left. That is new information, so it does
  // not have to wait out the repeat window — just the floor between utterances.
  const kneeFixed = liveState({
    corrections: [{ joint: "left_elbow", text: "Straighten your left arm" }],
  });
  assertEqual(coach.update(kneeFixed, SPEECH.minGapMs - 100), null, "but not instantly");
  assertEqual(coach.update(kneeFixed, SPEECH.minGapMs + 1).text, "Straighten your left arm.");
});

test("a pose coming good goes quiet rather than congratulating itself twice", () => {
  const coach = new Coach();
  const done = coach.update(liveState({ correct: true,
    hold: { state: "complete", remaining: 0, justCompleted: true } }), 0);
  assertEqual(done.text, "Nice. Come out of it.");
  for (let t = 100; t < 4000; t += 100) {
    assertEqual(coach.update(liveState({ correct: true,
      hold: { state: "complete", remaining: 0, tick: null } }), t), null,
      `still quiet at ${t}ms`);
  }
});

test("getting into frame is spoken too, after a moment", () => {
  // Between poses in a session nobody is looking at the phone, so the framing
  // prompt has to be audible. But not the instant Begin is tapped, when the
  // user is still holding the thing.
  const coach = new Coach();
  assertEqual(coach.update({ phase: "framing", detected: false }, 0), null, "not immediately");
  assertEqual(coach.update({ phase: "framing", detected: false }, FRAMING_GRACE_MS - 1), null);
  assertEqual(coach.update({ phase: "framing", detected: false }, FRAMING_GRACE_MS + 1).text,
    "Step into the frame.");
  assertEqual(coach.update({ phase: "framing", detected: false }, FRAMING_GRACE_MS + 2000), null,
    "and then it waits");
});

test("a body in shot but side-on is told what is actually wrong", () => {
  const coach = new Coach();
  coach.update({ phase: "framing", detected: true }, 0);   // starts the grace
  assertEqual(coach.update({ phase: "framing", detected: true }, FRAMING_GRACE_MS + 1).text,
    "Turn so I can see your shoulders and hips.");
});

test("the framing grace restarts for each pose in a session", () => {
  const coach = new Coach();
  coach.update({ phase: "framing", detected: false }, 0);
  coach.update({ phase: "live", detected: true, hold: { state: "idle" } }, 100);
  assertEqual(coach.update({ phase: "framing", detected: false }, 200), null,
    "leaving framing resets the grace, so the next pose gets the same quiet start");
});
