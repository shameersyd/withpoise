#!/bin/sh
# Browser smoke test: does pose detection actually run?
#
# The jsc suite covers the pure logic and is blind to everything this touches —
# the module worker, the MediaPipe runtime, WebGL, the model download. The
# landmarker failed to start on every run for the app's entire history and that
# suite stayed green throughout. This is the test that would have said so.
#
# Downloads ~9 MB the first time and needs a network. Takes about a minute.
set -e
cd "$(dirname "$0")/.."

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT=8897
LOG=$(mktemp)
PROFILE=$(mktemp -d)

if [ ! -x "$CHROME" ]; then
  echo "Chrome not found at $CHROME — this test needs a real browser engine." >&2
  exit 127
fi

python3 -m http.server "$PORT" > "$LOG" 2>&1 &
SERVER=$!
cleanup() {
  pkill -f "remote-debugging-port=9399" 2>/dev/null || true
  kill "$SERVER" 2>/dev/null || true
  # Chrome keeps writing to its profile for a moment after being asked to go,
  # and a failed rm here must not become the verdict of the test.
  sleep 1
  rm -rf "$PROFILE" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
sleep 1

# Software GL, so this runs the same on a machine with no usable GPU — a real
# device uses its own. Remote debugging is only here to stop headless Chrome
# exiting the moment the page loads.
"$CHROME" --headless=new \
  --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader \
  --remote-debugging-port=9399 --user-data-dir="$PROFILE" \
  "http://localhost:$PORT/tests/smoke.html" > /dev/null 2>&1 &

echo "  running pose detection in a browser (downloads ~9 MB on a cold cache)…"
for _ in $(seq 1 75); do
  if grep -q '__smoke?' "$LOG" 2>/dev/null; then break; fi
  sleep 1
done

RESULT=$(grep -o '__smoke?[^ ]*' "$LOG" | head -1 || true)
if [ -z "$RESULT" ]; then
  echo "  ✗ the page never reported back — Chrome or the network is unhappy" >&2
  exit 1
fi

set +e
echo "$RESULT" | python3 -c '
import sys, urllib.parse
raw = urllib.parse.unquote(sys.stdin.read().split("?", 1)[1])
verdict, failures, log = (raw.split("||") + ["", ""])[:3]
for line in log.split(" ~~ "):
    if line: print("    · " + line)
print()
if verdict == "OK":
    print("  ✓ pose detection runs")
else:
    print("  ✗ " + failures)
sys.exit(0 if verdict == "OK" else 1)
'
STATUS=$?
exit $STATUS
