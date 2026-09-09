/**
 * Print what a pose definition actually describes: whether it validates, the
 * joint angles its rig implies, and a sketch of the figure.
 *
 * Run through tools/show-pose.sh. See docs/ADDING_A_POSE.md.
 */
import { YOGA_POSES as POSE_DATA } from "../yoga_app/poses.js";
import { validatePose, compilePose } from "../yoga_app/pose-schema.js";
import { buildReference, SKELETON } from "../yoga_app/pose-core.js";

// jsc puts everything after `--` in the global `arguments` object, in module
// mode as well as classic.
const key = (typeof arguments !== "undefined" && arguments[0]) || "";
const pose = POSE_DATA[key];

if (!pose) {
  print(`Unknown pose "${key}". Known: ${Object.keys(POSE_DATA).join(", ")}`);
} else {
  const problems = validatePose(key, pose);
  print(`\n  ${pose.emoji || ""}  ${pose.name}  (${pose.view || "front"} view, ` +
        `${pose.symmetric ? "symmetric" : pose.side + " side"})\n`);

  if (problems.length) {
    print("  NOT VALID:");
    for (const p of problems) print("    · " + p);
    print("");
  } else {
    const compiled = compilePose(key, pose);
    print("  joint            target   tolerance   weight");
    print("  ─────────────────────────────────────────────");
    for (const [joint, [target, tolerance]] of Object.entries(compiled.angles)) {
      print(`  ${joint.padEnd(16)} ${target.toFixed(1).padStart(5)}°   ` +
            `±${String(tolerance).padStart(2)}°       ${compiled.weights[joint]}`);
    }
    sketch(buildReference(pose.rig, null, pose.view));
  }
}

/**
 * The figure as it would be drawn: x and y only, since dropping z is exactly
 * what the canvas does. A side-view pose shows one limb because both are there.
 */
function sketch(P) {
  const W = 48;
  const pts = Object.values(P);
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);

  // Terminal characters are about twice as tall as they are wide, so the
  // vertical scale is halved. Without that a wide pose reads as a tall one,
  // which rather defeats the purpose of drawing it.
  const xScale = (W - 4) / Math.max(x1 - x0, 1e-6);
  const yScale = xScale * 0.5;
  const H = Math.min(30, Math.max(5, Math.round((y1 - y0) * yScale) + 3));

  const at = (p) => [
    Math.round((p.x - x0) * xScale) + 2,
    Math.round((p.y - y0) * yScale) + 1,
  ];

  const grid = Array.from({ length: H }, () => Array(W).fill(" "));
  const plot = (cx, cy, ch) => {
    if (cy >= 0 && cy < H && cx >= 0 && cx < W) grid[cy][cx] = ch;
  };

  for (const [a, b] of [...SKELETON, ["nose", "left_shoulder"]]) {
    if (!P[a] || !P[b]) continue;
    const [ax, ay] = at(P[a]), [bx, by] = at(P[b]);
    const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay), 1);
    for (let i = 0; i <= steps; i++) {
      plot(Math.round(ax + (bx - ax) * i / steps),
           Math.round(ay + (by - ay) * i / steps), "·");
    }
  }
  for (const [name, p] of Object.entries(P)) {
    const [cx, cy] = at(p);
    plot(cx, cy, name === "nose" ? "O" : "+");
  }

  print("\n  as drawn (z dropped, exactly as the canvas does):\n");
  for (const row of grid) print("    " + row.join("").replace(/\s+$/, ""));
  print("");
}
