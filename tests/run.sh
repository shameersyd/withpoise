#!/bin/sh
# Run the test suite.
#
# There is no Node on this machine, so this uses JavaScriptCore's jsc shell.
# jsc's quit() does not set an exit code, so the harness throws on failure —
# that jsc does propagate, as exit 3.
set -e
cd "$(dirname "$0")/.."
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
if [ ! -x "$JSC" ]; then
  echo "jsc not found at $JSC — it ships with macOS inside the JavaScriptCore framework." >&2
  exit 127
fi
"$JSC" -m tests/run.js

# The suite above never loads MediaPipe, never creates a Worker and never
# touches WebGL, so it cannot see whether pose detection actually runs — and
# for the app's whole history it did not, while this stayed green.
echo "  For what this cannot see, run ./tests/smoke.sh (Chrome + network, ~1 min)."
echo
