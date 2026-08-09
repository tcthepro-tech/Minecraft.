#!/usr/bin/env python3
"""
Package the two packs into an installable .mcaddon (and the individual .mcpack
files, for anyone who wants to apply them separately).

    python3 tools/build.py

A .mcaddon is just a zip containing the pack folders at its root; Bedrock cares
about the folder layout inside, not the extension.
"""

import pathlib
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
PACKS = ROOT / "packs"
DIST = ROOT / "dist"

SKIP_SUFFIXES = {".pyc"}
SKIP_NAMES = {".DS_Store", "Thumbs.db"}


def files_in(pack: pathlib.Path):
    for path in sorted(pack.rglob("*")):
        if not path.is_file():
            continue
        if path.name in SKIP_NAMES or path.suffix in SKIP_SUFFIXES:
            continue
        if "__pycache__" in path.parts:
            continue
        yield path


def write_zip(target: pathlib.Path, members):
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path, arcname in members:
            zf.write(path, arcname)
    size = target.stat().st_size
    print(f"  {target.relative_to(ROOT)}  ({size / 1024:.1f} KiB, {len(members)} files)")


def main():
    packs = [p for p in sorted(PACKS.iterdir()) if p.is_dir()]
    if not packs:
        print("no packs found", file=sys.stderr)
        return 1

    print("building:")

    addon_members = []
    for pack in packs:
        pack_members = [(f, str(f.relative_to(pack))) for f in files_in(pack)]
        if not pack_members:
            print(f"  warning: {pack.name} is empty", file=sys.stderr)
            continue
        write_zip(DIST / f"{pack.name}.mcpack", pack_members)
        addon_members += [(f, f"{pack.name}/{f.relative_to(pack)}") for f in files_in(pack)]

    write_zip(DIST / "notice.mcaddon", addon_members)
    print("\nDouble-click notice.mcaddon to import both packs, then enable them")
    print("on a world with the Beta APIs experiment switched on.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
