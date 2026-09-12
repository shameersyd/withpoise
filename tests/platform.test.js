import { suite, test, assertEqual, assert } from "./harness.js";
import { detectRuntime, RUNTIME, readTextFile, say } from "./platform.js";

suite("runtime");

test("the runtime is identified by the globals it has, not by guessing", () => {
  // Pure, so both branches are checkable from whichever one is actually
  // running. The jsc shell is the only place `print` and `readFile` exist.
  assertEqual(detectRuntime({ print: () => {}, readFile: () => {} }), "jsc");
  assertEqual(detectRuntime({}), "node", "no shell globals means Node");
  assertEqual(detectRuntime({ print: () => {} }), "node", "print alone is not jsc");
  assertEqual(detectRuntime({ readFile: () => {} }), "node", "nor readFile alone");
  assertEqual(detectRuntime({ print: 1, readFile: 2 }), "node",
    "they have to be callable");
});

test("whichever runtime this is, it can read and print", () => {
  assert(RUNTIME === "jsc" || RUNTIME === "node", `unknown runtime ${RUNTIME}`);
  assert(typeof say === "function");
  const text = readTextFile("tests/platform.js");
  assert(text.includes("detectRuntime"), "reads a file relative to the repo root");
});
