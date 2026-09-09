/** Entry point: import every suite for its side effects, then run them. */
import { run } from "./harness.js";
import "./scoring.test.js";
import "./filter.test.js";

run();
