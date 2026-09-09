#!/bin/sh
# What does this pose definition actually describe?
#
#   tools/show-pose.sh downdog
#
# Prints validation problems, the joint angles the rig implies, and a sketch of
# the figure. See docs/ADDING_A_POSE.md.
set -e
cd "$(dirname "$0")/.."
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
exec "$JSC" -m tools/show-pose.js -- "${1:-}"
