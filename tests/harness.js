/**
 * A test harness for a machine with no Node.
 *
 * Node, deno and bun are all absent here, so vitest and node:test are not
 * options; these run under JavaScriptCore's `jsc` shell, which gives us ES
 * modules, `print` and `readFile` and little else. `quit(n)` does not set an
 * exit code, so a failing run ends by throwing — that jsc does propagate.
 */

const tests = [];
let currentFile = "";

export function suite(name) { currentFile = name; }
export function test(name, fn) { tests.push({ name, file: currentFile, fn }); }

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || "expected a truthy value");
}

export function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || "not equal"}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

export function assertClose(actual, expected, tol, msg) {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${msg || "not close"}\n      expected: ${expected} ±${tol}\n      actual:   ${actual}`);
  }
}

export function assertDeepEqual(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${msg || "not deep-equal"}\n      expected: ${b}\n      actual:   ${a}`);
  }
}

/** Set membership, order-independent, with a readable diff. */
export function assertSameSet(actual, expected, msg) {
  const a = [...actual].sort(), b = [...expected].sort();
  assertDeepEqual(a, b, msg);
}

export function run() {
  let passed = 0;
  const failures = [];
  let lastFile = null;

  for (const t of tests) {
    if (t.file !== lastFile) { print(`\n  ${t.file}`); lastFile = t.file; }
    try {
      t.fn();
      passed++;
      print(`    ✓ ${t.name}`);
    } catch (err) {
      failures.push({ ...t, err });
      print(`    ✗ ${t.name}`);
      print(`      ${err.message}`);
    }
  }

  print("");
  print(`  ${passed} passed, ${failures.length} failed, ${tests.length} total`);
  print("");
  if (failures.length) throw new Error(`${failures.length} test(s) failed`);
}
