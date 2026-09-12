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
  correctionsFor, reliableLandmarks, segmentDirections, matchSegments,
  recogniseFaults, facingWrongWay, SEGMENT_NAMES,
} from "./pose-core.js";
import { rankCorrections } from "./coach.js";

/**
 * Fold a segment match into a joint match, so one score covers both.
 *
 * The aggregate is recomputed rather than blended: a weighted mean of two
 * weighted means is not a weighted mean of the union unless the weights happen
 * to balance, and quietly getting that wrong would make every number here a
 * little bit false.
 */
function addSegments(match, segments) {
  match.segments = segments.results;
  match.segmentsUnscored = segments.unscored;
  match.segmentsUncertain = segments.uncertain;

  let earned = 0, judged = 0;
  for (const result of Object.values(match.results)) {
    earned += result.quality * result.weight;
    judged += result.weight;
  }
  let total = match.totalWeight;

  for (const result of Object.values(segments.results)) {
    earned += result.quality * result.weight;
    judged += result.weight;
    total += result.weight;
  }
  // Set aside but still part of the pose: they belong in the denominator of
  // coverage, which is what coverage is for.
  for (const name of [...segments.unscored, ...segments.uncertain]) {
    const spec = (match.segmentSpecs && match.segmentSpecs[name]) || {};
    total += spec.weight ?? 1;
  }

  match.score = judged > 0 ? (earned / judged) * 100 : 0;
  match.judgedWeight = judged;
  match.totalWeight = total;
  match.coverage = total > 0 ? judged / total : 0;
  match.uncertain = [...match.uncertain, ...segments.uncertain];
  match.unscored = [...match.unscored, ...segments.unscored];
}

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

  // Where each segment points, in the body's own frame. Nothing here is
  // comparable without that frame: it turns with the user, which is what keeps
  // a correctly held pose scoring the same at 30° off-axis as head-on.
  const directions = world && frame ? segmentDirections(world, frame) : null;

  // Score every side of the pose and keep the one the body is closest to.
  const scored = variants.map((variant, i) => {
    const match = matchSinglePose(angles, variant.pose.angles,
      { reliable, measurability, weights: variant.pose.weights });

    // Directions are additive to angles, not a replacement. An angle says how
    // bent a limb is; a direction says where it points. Neither answers the
    // other's question, and only the pair describes a pose.
    //
    // But only while the body frame is worth trusting. Every direction here is
    // expressed in a frame built from the user's own hips and shoulders, and
    // when they are standing the wrong way round for the pose that frame is
    // being read through a badly compressed depth axis. Measured on Downward
    // Dog seen 30° off its view, the frame alone puts 22° into every leg
    // segment with no noise present. Scoring that would be reporting the
    // viewing angle as bad form, which is the one thing this must not do — so
    // the directions go to "can't tell" and the user is told to turn.
    const misfacing = frame && facingWrongWay(variant.pose.view, frame.turnDegrees);
    if (misfacing) {
      addSegments(match, { results: {}, unscored: [], uncertain: [...SEGMENT_NAMES] });
    } else if (directions && variant.pose.segmentTargets) {
      addSegments(match, matchSegments(directions, variant.pose.segmentTargets, frame, {
        specs: variant.pose.segmentSpecs,
        margin: variant.pose.directionMargin,
        reliable,
      }));
    }
    return { key: i, variant, match };
  });

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
  // with the same thing the voice would say. Segment corrections carry their
  // own phrasing, derived from which way the limb has to travel.
  const segmentResults = match.segments || {};
  const named = directions
    ? recogniseFaults(segmentResults, directions, chosen.variant.pose.segmentTargets)
    : [];
  const explained = new Set(named.flatMap(n => n.explains));

  const fromSegments = Object.entries(segmentResults)
    .filter(([name, r]) => !r.ok && r.correction && !explained.has(name))
    .map(([name, r]) => ({ joint: name, text: r.correction, weight: r.weight, quality: r.quality }));

  match.corrections = rankCorrections(
    [...correctionsFor(shown, tips), ...named, ...fromSegments],
    { ...shown, ...segmentResults });

  return { chosen, match, shown, judged, reliable, frame };
}
