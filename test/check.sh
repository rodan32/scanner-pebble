#!/bin/sh
# Pre-flight checks that need no Pebble SDK, no watch and no network.
#
# Builds happen in CloudPebble, which means every mistake normally costs a
# push -> Pull from GitHub -> Run build -> Install round trip. This catches the
# cheap class of mistake (C syntax/type errors, JS syntax errors, a broken field
# mapping) before you spend one. It is NOT a build: test/stub/pebble.h is a
# hand-written stand-in for the SDK header, so a clean run proves the code
# parses and type-checks, not that it behaves on-device.
#
#   sh test/check.sh
set -e
cd "$(dirname "$0")/.."

echo "== C: type-check main.c (color + B&W) =="
# emery/basalt/chalk define PBL_COLOR; diorite does not, and the color paths are
# #ifdef'd out there — so check both or a B&W-only break goes unnoticed.
gcc -fsyntax-only -DPBL_COLOR -Itest/stub src/c/main.c
gcc -fsyntax-only -Itest/stub src/c/main.c
echo "   ok"

echo "== JS: syntax =="
for f in src/pkjs/index.js src/pkjs/config.js test/harness.js; do
  node --check "$f"
done
echo "   ok"

echo "== JS: bridge against canned feed payloads =="
node test/harness.js home --offline

echo "
all checks passed"
