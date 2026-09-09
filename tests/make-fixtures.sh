#!/bin/sh
# Regenerate tests/fixtures/*.json. Deterministic: rerunning with no source
# change produces byte-identical files.
set -e
cd "$(dirname "$0")/.."
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
"$JSC" -m tests/make-fixtures.js | python3 -c '
import json, sys
data = json.load(sys.stdin)
for key, fixture in data.items():
    with open("tests/fixtures/%s.json" % key, "w") as f:
        json.dump(fixture, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("  wrote tests/fixtures/%s.json" % key)
'
