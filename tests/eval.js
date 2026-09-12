/**
 * The spatial evaluation table.
 *
 * Each pose is posed into each geometric fault at a range of severities and run
 * through the real scoring pipeline. The output is committed as
 * tests/eval-baseline.txt so that every later change to the scoring is a diff
 * somebody can read, rather than an assertion somebody has to believe.
 *
 * The faults are chosen to be invisible to joint angles. A run where they all
 * read 100.0 is not a bug in this script — it is the measurement that motivates
 * the work. See docs/LIMITS.md §1.
 *
 * Run via tests/eval.sh.
 */

import { say } from "./platform.js";
import { sidesOf, buildReference, reliableLandmarks, makeFilters, smooth, TUNING }
  from "../yoga_app/pose-core.js";
import { scoreObservation } from "../yoga_app/scoring.js";
import { YOGA_POSES, CORRECTION_TIPS } from "./poses.js";
import { observe, valgus, pelvisYaw, limbSwing, depthMirror } from "./synthetic.js";

// Valgus and limb swing need a side to act on. Left throughout: it is the front
// or standing leg in every asymmetric pose here, which is the leg a teacher
// watches, and the symmetric poses do not care.
const SIDE = "left";

const CASES = [
  { fault: "none", severities: [0], make: () => (P) => P },
  { fault: "valgus", severities: [15, 30, 45, 60],
    make: (deg) => (P) => valgus(P, SIDE, deg) },
  { fault: "pelvisYaw", severities: [15, 30, 45],
    make: (deg) => (P) => pelvisYaw(P, deg) },
  { fault: "armSwing", severities: [30, 45, 90],
    make: (deg) => (P) => limbSwing(P, `arm_${SIDE}`, deg) },
  { fault: "depthMirror", severities: [0], make: () => depthMirror },
  // Not a fault: a correctly held pose under the noise model, so the table also
  // shows what the scoring does to a body it is seeing imperfectly.
  { fault: "noise", severities: [0], make: () => (P) => P, noise: { seed: 7 } },
];

const variantsOf = (pose) => sidesOf(pose).map((p) => ({
  pose: p,
  reference: buildReference(p.rig, null, p.view),
}));

function run(pose, make, degrees, noise) {
  const fault = make(degrees);

  // A noisy case is run as a sequence through the One Euro smoothing the worker
  // applies, because that is the only kind of landmark the app has ever seen. A
  // single unsmoothed frame carries several times the direction noise and would
  // put a number in this table that nothing in the app can produce.
  const filters = makeFilters(TUNING.world);
  const frames = noise ? 70 : 1;
  let image = null, world = null;
  for (let i = 0; i < frames; i++) {
    const seen = observe(pose, { fault, noise: noise ? { seed: noise.seed + i * 17 } : undefined });
    image = seen.image;
    world = noise ? smooth(seen.world, filters, i / 30) : seen.world;
  }

  const { match } = scoreObservation({ landmarks: image, world }, {
    variants: variantsOf(pose),
    tips: CORRECTION_TIPS,
    reliable: reliableLandmarks(image),
  });
  return {
    score: match.score,
    coverage: match.coverage,
    top: match.corrections.length ? match.corrections[0].text : "—",
  };
}

const pad = (s, n) => String(s).padEnd(n);
const padStart = (s, n) => String(s).padStart(n);

say("");
say("  Spatial evaluation — synthetic bodies, exact by construction");
say("  Every fault below preserves all eight scored joint angles.");
say("");
say("  " + pad("pose", 10) + pad("fault", 13) + padStart("sev", 4) + "   " +
    padStart("score", 6) + "  " + padStart("cover", 6) + "  top correction");
say("  " + "─".repeat(78));

for (const key of Object.keys(YOGA_POSES)) {
  const pose = YOGA_POSES[key];
  for (const { fault, severities, make, noise } of CASES) {
    for (const deg of severities) {
      const r = run(pose, make, deg, noise);
      say("  " + pad(key, 10) + pad(fault, 13) +
          padStart(deg || "—", 4) + "   " +
          padStart(r.score.toFixed(1), 6) + "  " +
          padStart(`${Math.round(r.coverage * 100)}%`, 6) + "  " + r.top);
    }
  }
  say("");
}
