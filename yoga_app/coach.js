/**
 * Coaching policy: what to say, and when to shut up.
 *
 * All of it pure. The browser half — speechSynthesis, the completion tone, the
 * remembered on/off switch — is in voice.js, and this module never touches it.
 * Timing is passed in as `now` so the whole policy can be run at a thousand
 * frames a second in a test.
 *
 * The governing constraint is that you cannot look at a phone while holding
 * Triangle, and you cannot listen to a running commentary either. A voice that
 * talks constantly gets muted, and a muted voice is worth nothing. So: one
 * thing at a time, a hard floor between utterances, and silence as the default
 * rather than the exception.
 */

// ─────────────────────────────────────────────────────────────
// Hold timer
// ─────────────────────────────────────────────────────────────
/**
 * How long the pose has been held correctly.
 *
 * "Continuously" cannot mean "without a single bad frame" — a landmark dipping
 * below its visibility threshold for two frames would reset a nine-second hold,
 * and the user would have no idea why. So a lapse pauses the clock rather than
 * clearing it, and only a lapse that outlasts the grace period starts it over.
 */
export class HoldTimer {
  constructor({ seconds = 10, graceMs = 900, countFrom = 5 } = {}) {
    this.seconds = seconds;
    this.graceMs = graceMs;
    this.countFrom = countFrom;
    this.reset();
  }

  reset() {
    this.heldMs = 0;
    this.lastNow = null;
    this.lapsedSince = null;
    this.state = "idle";        // idle | holding | complete
    this.spokenTick = null;
  }

  get remaining() {
    return Math.max(0, this.seconds - this.heldMs / 1000);
  }

  /**
   * Returns what changed this frame:
   *   { state, remaining, justStarted, justCompleted, justLost, tick }
   * `tick` is the whole second to count aloud, or null.
   */
  update(correct, now) {
    const dt = this.lastNow === null ? 0 : Math.max(0, now - this.lastNow);
    this.lastNow = now;

    const out = { justStarted: false, justCompleted: false, justLost: false, tick: null };

    if (this.state === "complete") {
      if (!correct) this.reset();
      return { ...out, state: this.state, remaining: this.remaining };
    }

    if (correct) {
      if (this.state === "idle") {
        this.state = "holding";
        this.heldMs = 0;
        this.spokenTick = null;
        out.justStarted = true;
      }
      this.lapsedSince = null;
      this.heldMs += dt;

      // Count the last few seconds down, each whole second once.
      const left = Math.ceil(this.remaining);
      if (left <= this.countFrom && left >= 1 && left !== this.spokenTick) {
        this.spokenTick = left;
        out.tick = left;
      }

      if (this.heldMs >= this.seconds * 1000) {
        this.state = "complete";
        out.justCompleted = true;
        out.tick = null;
      }
    } else if (this.state === "holding") {
      // The clock stops but does not rewind, until the lapse outlasts its grace.
      if (this.lapsedSince === null) this.lapsedSince = now;
      if (now - this.lapsedSince > this.graceMs) {
        this.reset();
        out.justLost = true;
      }
    }

    return { ...out, state: this.state, remaining: this.remaining };
  }
}

// ─────────────────────────────────────────────────────────────
// Session
// ─────────────────────────────────────────────────────────────
/**
 * A queue of poses to work through without touching the phone.
 *
 * An asymmetric pose is not finished until both sides have been held. Which
 * side you do first is yours to choose — the tracker detects it — so a step
 * holds the set of sides still owed rather than a fixed order.
 */
export class Session {
  constructor(poseKeys, sidedness = {}) {
    this.steps = poseKeys.map((key) => ({
      key,
      needed: sidedness[key] === false ? new Set([null]) : new Set(["left", "right"]),
      done: new Set(),
    }));
    this.index = 0;
  }

  get current() { return this.steps[this.index] || null; }
  get finished() { return this.index >= this.steps.length; }
  get length() { return this.steps.length; }
  /** 1-based, for "3 of 5". */
  get position() { return Math.min(this.index + 1, this.steps.length); }

  /** Sides of the current pose still to do. */
  remainingSides() {
    const step = this.current;
    return step ? [...step.needed].filter(s => !step.done.has(s)) : [];
  }

  /**
   * Record a completed hold. `side` is the side that was detected, or null for
   * a symmetric pose. Returns what it means for the session.
   */
  complete(side) {
    const step = this.current;
    if (!step) return { counted: false, advanced: false, finished: true, otherSide: false };

    const key = step.needed.has(side) ? side : (step.needed.has(null) ? null : side);
    if (!step.needed.has(key) || step.done.has(key)) {
      // A side already held. Not an error — the user simply repeated one — but
      // it does not move the session on.
      return { counted: false, advanced: false, finished: this.finished,
               otherSide: this.remainingSides().length > 0 };
    }

    step.done.add(key);
    const left = this.remainingSides();
    if (left.length === 0) {
      this.index++;
      return { counted: true, advanced: true, finished: this.finished, otherSide: false };
    }
    return { counted: true, advanced: false, finished: false, otherSide: true };
  }
}

// ─────────────────────────────────────────────────────────────
// What to say
// ─────────────────────────────────────────────────────────────

// A correction is worth saying in proportion to how much of the pose it is and
// how wrong it is. Speaking the worst one and nothing else is the whole policy:
// a person can act on one instruction at a time.
export function rankCorrections(corrections, results) {
  return [...corrections]
    .map((c) => {
      // A correction may carry its own weight and quality — a named fault
      // spanning several segments has no single entry in `results` to look up.
      const r = (results && results[c.joint]) || {};
      const weight = c.weight ?? r.weight ?? 1;
      const quality = c.quality ?? r.quality ?? 0;
      return { ...c, severity: weight * (1 - quality) };
    })
    .sort((a, b) => b.severity - a.severity);
}

// How long to let someone walk away from the phone before saying anything.
export const FRAMING_GRACE_MS = 2500;

// Said when tracking has already started and the body is then lost. Each names
// the thing to do, not the thing that happened: "step back in" is actionable,
// "tracking paused" is not.
// Lost for a reason that means the same thing whichever way the pose is held.
// The third reason, "framing", is a turn, and which turn depends on the pose —
// see turnAdvice.
export const LOST_MESSAGES = {
  gone: "I've lost you. Step back in front of the camera.",
  coverage: "Step back — I can only see part of you.",
};

/**
 * Which way to turn, which is not the same question for every pose.
 *
 * Most poses are held facing the camera and go wrong by turning away from it.
 * A pose whose shape lives in the sagittal plane — Downward Dog — is the exact
 * reverse: facing the camera is what makes it unreadable.
 */
/**
 * Talking someone through the calibration, which they cannot watch while doing.
 *
 * Said once per step rather than throttled, because each is an instruction to
 * act on immediately and there are only three of them.
 */
export const CALIBRATION_PROMPTS = {
  front: "Stand facing the camera, arms at your sides, and hold still.",
  turn: "Now turn side-on to the camera.",
  side: "Hold it there.",
};

export const turnAdvice = (view) =>
  view === "side"
    ? "Turn side-on to the camera."
    : "Turn to face the camera.";

export const SPEECH = {
  minGapMs: 4500,        // never two corrections closer than this
  repeatGapMs: 15000,    // and never the same one again inside this
  framingGapMs: 8000,    // "step back" and friends are rarer still
};

/**
 * Turns a stream of per-frame state into a trickle of things to say.
 *
 * `update` returns at most one utterance per frame:
 *   { kind, text, interrupt }
 * `interrupt` means it matters more than whatever is still being spoken —
 * a countdown number is worthless if it arrives two seconds late.
 */
export class Coach {
  constructor(opts = {}) {
    this.cfg = { ...SPEECH, ...opts };
    this.reset();
  }

  reset() {
    this.lastSpokeAt = -Infinity;
    this.lastFramingAt = -Infinity;
    this.spokenAt = new Map();     // correction text → when it was last said
    this.wasCorrect = false;
    this.announced = null;         // pose label already announced
    this.lastCountdown = null;
    this.focusJoint = null;        // the one thing currently being asked for
    this.framingSince = null;
    this.lastPhase = null;
    this.calibrationStep = null;
  }

  /** Forget only what is specific to one pose, keeping the throttle honest. */
  nextPose() {
    this.spokenAt.clear();
    this.wasCorrect = false;
    this.announced = null;
    this.lastCountdown = null;
    this.focusJoint = null;
    this.framingSince = null;
    this.lastPhase = null;
    this.calibrationStep = null;
  }

  say(kind, text, now, { interrupt = false, throttled = true } = {}) {
    if (throttled) this.lastSpokeAt = now;
    return { kind, text, interrupt };
  }

  /**
   * state: {
   *   phase, detected, poseLabel, sessionNote,
   *   score, coverage, correct, corrections, results,
   *   needsTurn, tooLittleVisible, hold
   * }
   */
  update(state, now) {
    const { phase, hold } = state;
    if (phase !== "framing") this.framingSince = null;

    // Losing someone mid-pose is worth saying at once. They have already had a
    // grace period of silence before the app decided they were gone, and they
    // are by definition not looking at the screen.
    if (phase !== this.lastPhase) {
      if (phase === "lost") this.lastFramingAt = -Infinity;
      this.lastPhase = phase;
    }

    // ── lost mid-pose ──
    if (phase === "lost") {
      if (now - this.lastFramingAt < this.cfg.framingGapMs) return null;
      this.lastFramingAt = now;
      this.wasCorrect = false;
      const message = state.reason === "framing"
        ? turnAdvice(state.view)
        : LOST_MESSAGES[state.reason] || LOST_MESSAGES.gone;
      return this.say("lost", message, now, { interrupt: true });
    }

    // ── getting into shot ──
    //
    // Spoken, because between poses in a session the user is not looking at the
    // phone — that is the entire point of a session. Held back for a couple of
    // seconds first: the moment after tapping Begin they are still holding the
    // thing, and being told to step into frame before the camera has opened is
    // just noise.
    if (phase === "framing") {
      if (this.framingSince === null) this.framingSince = now;
      if (now - this.framingSince < FRAMING_GRACE_MS) return null;
      if (now - this.lastFramingAt < this.cfg.framingGapMs) return null;
      this.lastFramingAt = now;
      return this.say("framing", !state.detected
        ? "Step into the frame."
        : state.view === "side"
          ? "Stand side-on to the camera for this one."
          : "Turn so I can see your shoulders and hips.", now, { interrupt: true });
    }

    // ── measuring the user ──
    if (phase === "calibrating") {
      if (state.calibrationStep === this.calibrationStep) return null;
      this.calibrationStep = state.calibrationStep;
      const line = CALIBRATION_PROMPTS[state.calibrationStep];
      return line ? this.say("calibrating", line, now, { interrupt: true }) : null;
    }

    // ── the count-in ──
    if (phase === "countdown") {
      if (state.poseLabel && this.announced !== state.poseLabel) {
        this.announced = state.poseLabel;
        return this.say("pose", state.sessionNote
          ? `${state.sessionNote}. ${state.poseLabel}`
          : state.poseLabel, now, { interrupt: true });
      }
      if (state.countdown != null && state.countdown !== this.lastCountdown) {
        this.lastCountdown = state.countdown;
        return this.say("countdown", String(state.countdown), now,
          { interrupt: true, throttled: false });
      }
      return null;
    }

    if (phase !== "live") return null;

    // ── the hold, which outranks everything ──
    if (hold) {
      if (hold.justCompleted) {
        this.wasCorrect = false;
        return this.say("complete", "Nice. Come out of it.", now, { interrupt: true });
      }
      if (hold.tick != null) {
        return this.say("countdown", String(hold.tick), now,
          { interrupt: true, throttled: false });
      }
      // The hold is banked and the user is on their way out of the pose.
      // Congratulating them again, or starting to coach a pose they are
      // leaving, is worse than saying nothing.
      if (hold.state === "complete") return null;
    }

    if (!state.detected) return null;

    // ── the pose coming good, said once ──
    // This is both "announce when the pose goes fully correct" and the start of
    // the hold: they are the same instant, and saying so twice would be worse
    // than saying it once.
    if (state.correct && !this.wasCorrect) {
      this.wasCorrect = true;
      const left = hold && hold.state === "holding" ? Math.round(hold.remaining) : null;
      return this.say("good",
        left ? `That's it. Hold for ${left} seconds.` : "That's it — hold it.",
        now, { interrupt: true });
    }
    if (!state.correct) this.wasCorrect = false;

    // Mid-hold there is nothing to add. Interrupting a held pose to comment on
    // it is exactly the running commentary this is meant to avoid.
    if (hold && hold.state === "holding") return null;

    // ── framing, which no correction can fix ──
    if (state.needsTurn || state.tooLittleVisible) {
      if (now - this.lastFramingAt < this.cfg.framingGapMs) return null;
      this.lastFramingAt = now;
      return this.say("framing", state.needsTurn
        ? turnAdvice(state.view)
        : "Step back so I can see all of you.", now, { interrupt: true });
    }

    // ── one correction, rarely ──
    if (now - this.lastSpokeAt < this.cfg.minGapMs) return null;

    const ranked = rankCorrections(state.corrections || [], state.results);
    if (!ranked.length) { this.focusJoint = null; return null; }

    // Stay on one instruction until it has been acted on. Cycling through every
    // fault in turn is how "at most one correction every few seconds" turns
    // back into a running commentary: the user is still working on the knee
    // when they are told about the elbow, and they end up fixing neither.
    const focus = ranked.find(c => c.joint === this.focusJoint);
    const pick = focus || ranked[0];

    const last = this.spokenAt.get(pick.text);
    if (last != null && now - last < this.cfg.repeatGapMs) return null;

    this.focusJoint = pick.joint;
    this.spokenAt.set(pick.text, now);
    return this.say("correction", `${pick.text}.`, now);
  }
}
