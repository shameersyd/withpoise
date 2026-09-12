#!/bin/sh
# Run the test suite.
#
# Under Node if it is here, JavaScriptCore's `jsc` otherwise — the machine this
# was written on has no Node, and jsc ships with macOS. The suite itself does
# not care; see tests/platform.js for the three things that differ.
set -e
cd "$(dirname "$0")/.."

if command -v node > /dev/null 2>&1; then
  node tests/run.js
else
  JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
  if [ ! -x "$JSC" ]; then
    echo "Need either node on the PATH or jsc at $JSC." >&2
    exit 127
  fi
  "$JSC" -m tests/run.js
fi

# The suite above never loads MediaPipe, never creates a Worker and never
# touches WebGL, so it cannot see whether pose detection actually runs — and
# for the app's whole history it did not, while this stayed green.
echo "  For what this cannot see, run ./tests/smoke.sh (Chrome + network, ~1 min)."
echo
