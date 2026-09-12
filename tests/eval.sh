#!/bin/sh
# Print the spatial evaluation table.
#
#   tests/eval.sh                  # print it
#   tests/eval.sh --save           # overwrite the committed baseline
#
# The baseline is committed so that a change to the scoring shows up as a diff.
set -e
cd "$(dirname "$0")/.."

if command -v node > /dev/null 2>&1; then
  RUN="node tests/eval.js"
else
  RUN="/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m tests/eval.js"
fi

if [ "$1" = "--save" ]; then
  $RUN > tests/eval-baseline.txt
  echo "  wrote tests/eval-baseline.txt"
else
  $RUN
fi
