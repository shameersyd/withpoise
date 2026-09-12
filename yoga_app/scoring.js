/**
 * The scoring pipeline: landmarks in, a judged pose out.
 *
 * This used to live inside index.html as `evaluate()`, with the tests carrying
 * their own copy of the same sequence. Two copies of a pipeline is two
 * pipelines, and the tests were measuring the one nobody runs. There is one
 * now, and the app and the suite both call it.
 *
 * Layering: pose-core.js holds the primitives, this composes them, index.html
 * supplies the session state and draws the result.
 */

import {
  computeAngles, bodyFrame, jointMeasurability, matchSinglePose,
  correctionsFor, reliableLandmarks,
} from "./pose-core.js";
import { rankCorrections } from "./coach.js";

/**
 * observation: { landmarks, world }  — image and world landmark arrays
 * options: {
 *   variants     [{ pose, reference }] — every side of the pose being held
 *   tips         correction phrasings, keyed by joint
 *   reliable     Set of trustworthy landmark names; computed if omitted
 *   sideSelector optional SideSelector, for stickiness between frames
 *   verdicts     optional VerdictLatch, for red/green hysteresis
 *   now          timestamp, only needed when sideSelector is given
 *   width,height frame size, only used by the no-world-landmarks fallback
 * }
 *
 * Returns { chosen, match, shown, judged, reliable }.
 */
export function scoreObservation(observation, options) {
  const { landmarks, world } = observation;
  const {
    variants, tips = {}, sideSelector = null, verdicts = null,
    now = 0, width = 1, height = 1,
  } = options;

  const reliable = options.reliable || reliableLandmarks(landmarks);
  const angles = computeAngles(world, landmarks, width, height);

  // How square the user is to the lens, and which joints that leaves
  // unmeasurable. Both need world landmarks; without them every joint is scored
  // as before rather than the whole body being marked uncertain.
  const frame = world ? bodyFrame(world) : null;
  const measurability = world ? jointMeasurability(world, frame) : null;

  // Score every side of the pose and keep the one the body is closest to.
  const scored = variants.map((variant, i) => ({
    key: i,
    variant,
    match: matchSinglePose(angles, variant.pose.angles,
      { reliable, measurability, weights: variant.pose.weights }),
  }));

  const winner = sideSelector
    ? sideSelector.pick(scored.map(c => ({ key: c.key, score: c.match.score })), now)
    : scored.reduce((a, b) => (b.match.score > a.match.score ? b : a)).key;
  const chosen = scored[winner];

  const match = chosen.match;
  match.turnDegrees = frame ? frame.turnDegrees : 0;
  match.view = chosen.variant.pose.view;

  // Colours and corrections run off the latched verdicts where a latch is
  // given, so a joint resting on its tolerance holds its colour instead of
  // strobing. The score underneath stays graded and continuous either way.
  const shown = verdicts ? verdicts.apply(match.results) : match.results;
  match.aligned = Object.values(shown).filter(r => r.ok).length;

  // A joint we cannot measure is drawn like one we cannot see: greyed and
  // dashed, never red. Being told to fix a joint the camera can't judge is
  // worse than being told nothing.
  const judged = new Set(reliable);
  for (const joint of match.uncertain) judged.delete(joint);

  // Ranked by how much of the pose each fault actually is, so the panel leads
  // with the same thing the voice would say.
  match.corrections = rankCorrections(correctionsFor(shown, tips), shown);

  return { chosen, match, shown, judged, reliable, frame };
}
