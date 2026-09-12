/** Entry point: import every suite for its side effects, then run them. */
import { run } from "./harness.js";
import "./platform.test.js";
import "./scoring.test.js";
import "./filter.test.js";
import "./coach.test.js";
import "./pacing.test.js";
import "./schema.test.js";
import "./spatial.test.js";

run();
