#!/usr/bin/env bash
#
# Validate, simulate, and package. Run this before shipping anything.
set -euo pipefail

cd "$(dirname "$0")"

echo "==> regenerating creature (geometry + textures)"
python3 tools/gen_creature.py

echo
echo "==> regenerating other textures"
python3 tools/gen_textures.py

echo
echo "==> regenerating sounds"
# Skips cleanly if numpy/scipy/soundfile are absent; the committed .ogg files
# are what ship, so a contributor without the audio toolchain can still build.
python3 tools/gen_sounds.py || echo "   (skipped: pip install numpy scipy soundfile)"

echo
echo "==> validating pack structure"
python3 tools/validate.py

echo
echo "==> simulating the Watcher"
node --import ./tools/harness/hook.mjs tools/harness/sim.mjs

echo
echo "==> packaging"
python3 tools/build.py
