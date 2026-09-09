/**
 * The pose library as the app sees it: validated and compiled.
 *
 * Tests go through this rather than reading poses.js directly, so that every
 * run also exercises the validator and the target derivation. A malformed pose
 * fails the suite at import, which is the same thing the app does.
 */
import { YOGA_POSES as POSE_DATA, CORRECTION_TIPS } from "../yoga_app/poses.js";
import { compileAll } from "../yoga_app/pose-schema.js";

export const YOGA_POSES = compileAll(POSE_DATA);
export { POSE_DATA, CORRECTION_TIPS };
