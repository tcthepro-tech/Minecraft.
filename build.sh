#!/usr/bin/env bash
#
# Validate, simulate, and package. Run this before shipping anything.
set -euo pipefail

cd "$(dirname "$0")"

echo "==> regenerating textures"
python3 tools/gen_textures.py

echo
echo "==> validating pack structure"
python3 tools/validate.py

echo
echo "==> simulating the Watcher"
node --import ./tools/harness/hook.mjs tools/harness/sim.mjs

echo
echo "==> packaging"
python3 tools/build.py
