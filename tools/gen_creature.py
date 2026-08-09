#!/usr/bin/env python3
"""
Generate the creature geometry and its textures from a single shared spec.

The model has 41 boxes — horns, a hinged maw behind a pale cracked mask,
digitigrade legs, and hands whose fingers are longer than their palms.
Hand-packing that many UV rectangles onto a 128x128 sheet and then hand-painting
them in a separate file is a recipe for silent misalignment, so both come from
the definition below: the packer assigns every UV rect, and the painter is
handed those same rects along with a semantic material name.

Emits:
    packs/notice_RP/models/entity/watcher.geo.json
    packs/notice_RP/textures/entity/watcher.png     (the Watcher)
    packs/notice_RP/textures/entity/gaunt.png       (the Gaunt: same body, weathered)

    python3 tools/gen_creature.py
"""

import json
import math
import pathlib
import random
import struct
import zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
RP = ROOT / "packs" / "notice_RP"

TEX = 128

# ---------------------------------------------------------------------------
# The model
#
# Units are model units, 16 to a block. The figure stands about 53 units tall
# (3.3 blocks) and is scaled down to ~3.0 by minecraft:scale on the Watcher,
# and up to ~9.9 on the Gaunt. Same skeleton, same texture layout, wildly
# different silhouette against the sky.
#
# `mat` selects how the painter treats a box. Rotations are what make the legs
# read as digitigrade and the horns as curved rather than as spikes.
# ---------------------------------------------------------------------------

def mirror(spec, name_from, name_to):
    """Mirror a bone spec across X, for the limb on the other side."""
    out = json.loads(json.dumps(spec))
    out["name"] = out["name"].replace(name_from, name_to)
    if out.get("parent"):
        out["parent"] = out["parent"].replace(name_from, name_to)
    out["pivot"][0] = -out["pivot"][0]
    if "rot" in out:
        out["rot"][1] = -out["rot"][1]
        out["rot"][2] = -out["rot"][2]
    for cube in out["cubes"]:
        cube["origin"][0] = -(cube["origin"][0] + cube["size"][0])
        cube["id"] = cube["id"].replace(name_from, name_to)
    return out


def build_bones():
    bones = [
        {"name": "root", "parent": None, "pivot": [0, 0, 0], "cubes": []},

        # --- Core ------------------------------------------------------------
        {"name": "pelvis", "parent": "root", "pivot": [0, 30, 0], "cubes": [
            {"id": "pelvis", "origin": [-4, 27, -2.5], "size": [8, 6, 5], "mat": "hide"},
        ]},
        {"name": "torso", "parent": "pelvis", "pivot": [0, 33, 0], "rot": [-5, 0, 0], "cubes": [
            {"id": "torso", "origin": [-5, 33, -3], "size": [10, 13, 6], "mat": "ribs"},
        ]},

        # --- Skull and maw -----------------------------------------------------
        # The jaw pivots at the back of the skull so it swings down and back,
        # opening the whole face rather than dropping a chin.
        {"name": "head", "parent": "torso", "pivot": [0, 46, 0], "rot": [4, 0, 0], "cubes": [
            {"id": "skull", "origin": [-4, 46, -4], "size": [8, 7, 8], "mat": "skull"},
        ]},
        {"name": "jaw", "parent": "head", "pivot": [0, 47, 3], "cubes": [
            {"id": "jaw", "origin": [-3.5, 40, -4], "size": [7, 7, 7], "mat": "maw"},
        ]},

        # The face is a separate pale plate laid over the front of the skull,
        # split along the jaw hinge. Closed, the two halves line up into one
        # grin; when the maw opens, the grin tears in half and the throat is
        # what is behind it.
        {"name": "mask", "parent": "head", "pivot": [0, 49, -4], "cubes": [
            {"id": "mask", "origin": [-4, 45, -4.8], "size": [8, 8, 1], "mat": "mask"},
        ]},
        {"name": "grin", "parent": "jaw", "pivot": [0, 45, -4], "cubes": [
            {"id": "grin", "origin": [-3.5, 40, -4.8], "size": [7, 5, 1], "mat": "grin"},
        ]},

        # Lank hair over the cranium and down both sides of the face. Ragged
        # alpha along the bottom edge stops it reading as a helmet.
        {"name": "hairCap", "parent": "head", "pivot": [0, 52, 0], "cubes": [
            {"id": "hairCap", "origin": [-4.5, 51, -4.5], "size": [9, 3, 9], "mat": "hair"},
        ]},
    ]

    hair = [
        {"name": "hairL", "parent": "head", "pivot": [4, 52, 0], "rot": [0, 0, 3], "cubes": [
            {"id": "hairL", "origin": [4, 42, -4.5], "size": [1, 10, 8], "mat": "hair"}]},
    ]
    for b in hair:
        bones.append(b)
        bones.append(mirror(b, "L", "R"))

    # --- Horns: two curving outward, one small pair angled forward ----------
    # Each segment inherits the previous one's rotation, so three modest
    # rotations compound into a real curve.
    horn = [
        {"name": "hornL1", "parent": "head", "pivot": [3, 52, 0], "rot": [-10, 0, -32], "cubes": [
            {"id": "hornL1", "origin": [2, 52, -1], "size": [2, 8, 2], "mat": "horn"}]},
        {"name": "hornL2", "parent": "hornL1", "pivot": [3, 60, 0], "rot": [0, 0, -38], "cubes": [
            {"id": "hornL2", "origin": [2, 60, -1], "size": [2, 7, 2], "mat": "horn"}]},
        {"name": "hornL3", "parent": "hornL2", "pivot": [3, 67, 0], "rot": [0, 0, -44], "cubes": [
            {"id": "hornL3", "origin": [2, 67, -1], "size": [2, 6, 2], "mat": "horn"}]},
        {"name": "spurL", "parent": "head", "pivot": [2, 51, -2], "rot": [-38, 0, -14], "cubes": [
            {"id": "spurL", "origin": [1, 51, -3], "size": [2, 6, 2], "mat": "horn"}]},
    ]
    for b in horn:
        bones.append(b)
        bones.append(mirror(b, "L", "R"))

    # --- Arms: long, thin, ending in a hand longer than the forearm ---------
    arm = [
        {"name": "armL", "parent": "torso", "pivot": [5.5, 45, 0], "rot": [0, 0, -7], "cubes": [
            {"id": "armL", "origin": [4.5, 30, -1.5], "size": [3, 15, 3], "mat": "hide"}]},
        {"name": "foreL", "parent": "armL", "pivot": [6, 30, 0], "rot": [9, 0, 0], "cubes": [
            {"id": "foreL", "origin": [4.5, 15, -1.5], "size": [3, 15, 3], "mat": "hide"}]},
        {"name": "handL", "parent": "foreL", "pivot": [6, 15, 0], "rot": [6, 0, 0], "cubes": [
            {"id": "handL", "origin": [4.5, 11, -1.5], "size": [3, 4, 3], "mat": "claw"}]},
        # Three fingers, each longer than the palm, splayed slightly apart.
        {"name": "digitL1", "parent": "handL", "pivot": [5, 11, 0], "rot": [0, 0, 7], "cubes": [
            {"id": "digitL1", "origin": [4.5, 2, -1], "size": [1, 9, 1], "mat": "bone"}]},
        {"name": "digitL2", "parent": "handL", "pivot": [6, 11, 0], "rot": [3, 0, 0], "cubes": [
            {"id": "digitL2", "origin": [5.5, 1, -1], "size": [1, 10, 1], "mat": "bone"}]},
        {"name": "digitL3", "parent": "handL", "pivot": [7, 11, 0], "rot": [0, 0, -6], "cubes": [
            {"id": "digitL3", "origin": [6.5, 3, -1], "size": [1, 8, 1], "mat": "bone"}]},
        {"name": "shoulderSpikeL", "parent": "torso", "pivot": [5, 45, 0], "rot": [-24, 0, -30], "cubes": [
            {"id": "shoulderSpikeL", "origin": [4, 45, -1], "size": [2, 6, 2], "mat": "horn"}]},
        {"name": "elbowSpikeL", "parent": "armL", "pivot": [6, 30, 0], "rot": [-46, 0, -12], "cubes": [
            {"id": "elbowSpikeL", "origin": [5, 29, -1], "size": [2, 5, 2], "mat": "horn"}]},
    ]
    for b in arm:
        bones.append(b)
        bones.append(mirror(b, "L", "R"))

    # --- Digitigrade legs ---------------------------------------------------
    # Thigh forward, shin sharply back, then a long narrow hoof forward again.
    # The backward joint at mid-height is what makes the walk read as wrong.
    leg = [
        {"name": "thighL", "parent": "root", "pivot": [3, 29, 0], "rot": [11, 0, 0], "cubes": [
            {"id": "thighL", "origin": [1.5, 15, -1.5], "size": [3, 14, 3], "mat": "hide"}]},
        {"name": "shinL", "parent": "thighL", "pivot": [3, 15, 1], "rot": [-29, 0, 0], "cubes": [
            {"id": "shinL", "origin": [1.5, 3, -0.5], "size": [3, 12, 3], "mat": "hide"}]},
        {"name": "hoofL", "parent": "shinL", "pivot": [3, 3, 0], "rot": [19, 0, 0], "cubes": [
            {"id": "hoofL", "origin": [1.5, 0, -3], "size": [3, 3, 5], "mat": "claw"}]},
        {"name": "kneeSpikeL", "parent": "shinL", "pivot": [3, 14, 1], "rot": [42, 0, 0], "cubes": [
            {"id": "kneeSpikeL", "origin": [2, 13, 0], "size": [2, 5, 2], "mat": "horn"}]},
    ]
    for b in leg:
        bones.append(b)
        bones.append(mirror(b, "L", "R"))

    return bones


# ---------------------------------------------------------------------------
# UV packing
# ---------------------------------------------------------------------------

def footprint(size):
    """Bedrock's box unwrap occupies 2*(w+d) by (h+d)."""
    w, h, d = size
    return int(2 * (w + d)), int(h + d)


def pack(bones, sheet=TEX):
    """
    Shelf packer. Tallest first, left to right, wrap to a new shelf. The sheet
    is only about a third full, so there is no need for anything cleverer.
    """
    boxes = []
    for bone in bones:
        for cube in bone["cubes"]:
            fw, fh = footprint(cube["size"])
            boxes.append({"cube": cube, "w": fw, "h": fh})

    boxes.sort(key=lambda b: -b["h"])

    x = y = shelf_h = 0
    for b in boxes:
        if x + b["w"] > sheet:
            x = 0
            y += shelf_h + 1
            shelf_h = 0
        if y + b["h"] > sheet:
            raise SystemExit(f"UV sheet overflow: needs more than {sheet}x{sheet}")
        b["cube"]["uv"] = [x, y]
        shelf_h = max(shelf_h, b["h"])
        x += b["w"] + 1
    return boxes


# ---------------------------------------------------------------------------
# Geometry emission
# ---------------------------------------------------------------------------

def write_geometry(bones):
    out_bones = []
    for bone in bones:
        entry = {"name": bone["name"], "pivot": bone["pivot"]}
        if bone.get("parent"):
            entry["parent"] = bone["parent"]
        if bone.get("rot"):
            entry["rotation"] = bone["rot"]
        if bone["cubes"]:
            entry["cubes"] = [
                {"origin": c["origin"], "size": c["size"], "uv": c["uv"]}
                for c in bone["cubes"]
            ]
        out_bones.append(entry)

    doc = {
        "format_version": "1.12.0",
        "minecraft:geometry": [{
            "description": {
                "identifier": "geometry.nx_watcher",
                "texture_width": TEX,
                "texture_height": TEX,
                "visible_bounds_width": 4,
                "visible_bounds_height": 5,
                "visible_bounds_offset": [0, 2.2, 0],
            },
            "bones": out_bones,
        }],
    }
    path = RP / "models" / "entity" / "watcher.geo.json"
    path.write_text(json.dumps(doc, indent=2) + "\n")
    print(f"  {path.relative_to(ROOT)}  ({len(out_bones)} bones, "
          f"{sum(len(b.get('cubes', [])) for b in out_bones)} cubes)")


# ---------------------------------------------------------------------------
# Painting
# ---------------------------------------------------------------------------

def write_png(path, px):
    h = len(px)
    w = len(px[0])
    raw = bytearray()
    for row in px:
        raw.append(0)
        for r, g, b, a in row:
            raw += bytes((r & 255, g & 255, b & 255, a & 255))

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    print(f"  {path.relative_to(ROOT)}  {w}x{h}")


# Palettes. The Watcher lives underground and stays dark enough to read as a
# silhouette in fog; the Gaunt is seen against sky at 80 blocks, so it is paler
# and greyer or it would vanish into the treeline.
PALETTES = {
    "watcher": {
        "hide":  ((58, 56, 40), (92, 88, 64), (28, 27, 19)),
        "ribs":  ((62, 60, 44), (112, 106, 80), (24, 23, 16)),
        "skull": ((74, 70, 52), (118, 112, 84), (32, 30, 21)),
        "maw":   ((16, 12, 12), (150, 144, 118), (7, 5, 5)),
        "horn":  ((104, 96, 74), (146, 136, 108), (50, 46, 34)),
        "claw":  ((42, 38, 30), (78, 72, 56), (20, 18, 14)),
        "mask":  ((196, 189, 176), (232, 228, 218), (58, 54, 50)),
        "grin":  ((188, 181, 168), (236, 232, 222), (14, 11, 11)),
        "hair":  ((17, 15, 16), (38, 34, 36), (7, 6, 7)),
        "bone":  ((176, 170, 156), (216, 211, 198), (74, 70, 63)),
    },
    "gaunt": {
        "hide":  ((84, 86, 72), (120, 122, 104), (44, 46, 38)),
        "ribs":  ((90, 92, 78), (138, 140, 120), (40, 42, 34)),
        "skull": ((104, 104, 90), (144, 144, 126), (48, 48, 40)),
        "maw":   ((18, 16, 16), (168, 166, 146), (8, 7, 7)),
        "horn":  ((128, 124, 104), (166, 160, 138), (62, 60, 48)),
        "claw":  ((58, 58, 48), (92, 92, 78), (28, 28, 23)),
        "mask":  ((214, 210, 200), (242, 240, 234), (66, 64, 60)),
        "grin":  ((206, 202, 192), (244, 242, 236), (16, 14, 14)),
        "hair":  ((24, 23, 26), (48, 45, 50), (10, 9, 11)),
        "bone":  ((196, 192, 180), (228, 225, 214), (84, 81, 74)),
    },
}


def paint(boxes, palette, seed):
    rng = random.Random(seed)
    px = [[(0, 0, 0, 0) for _ in range(TEX)] for _ in range(TEX)]

    def put(x, y, colour):
        if 0 <= x < TEX and 0 <= y < TEX:
            px[y][x] = colour

    def grain(base, spread=6):
        r, g, b = base
        j = rng.randint(-spread, spread)
        return (max(0, min(255, r + j)), max(0, min(255, g + j)), max(0, min(255, b + j)), 255)

    for box in boxes:
        cube = box["cube"]
        u, v = cube["uv"]
        w, h, d = (int(n) for n in cube["size"])
        base, light, dark = palette[cube["mat"]]
        mat = cube["mat"]

        # Base fill across the whole unwrap footprint.
        for yy in range(box["h"]):
            for xx in range(box["w"]):
                put(u + xx, v + yy, grain(base))

        # Face rectangles within the unwrap, in Bedrock's box layout.
        faces = {
            "top":    (u + d,         v,     w, d),
            "bottom": (u + d + w,     v,     w, d),
            "east":   (u,             v + d, d, h),
            "north":  (u + d,         v + d, w, h),
            "west":   (u + d + w,     v + d, d, h),
            "south":  (u + d + w + d, v + d, w, h),
        }

        if mat == "ribs":
            # Horizontal rib bands across the chest, brightest at the sternum.
            fx, fy, fw, fh = faces["north"]
            for i in range(fh):
                if i % 2 == 0 and i < fh - 2:
                    for xx in range(fw):
                        taper = 1.0 - abs(xx - fw / 2) / (fw / 2 + 0.001)
                        c = light if taper > 0.35 else base
                        put(fx + xx, fy + i, grain(c, 4))
                else:
                    for xx in range(fw):
                        put(fx + xx, fy + i, grain(dark, 3))
            # A pale sternum ridge down the centre.
            for i in range(fh):
                put(fx + fw // 2, fy + i, grain(light, 5))

        elif mat == "maw":
            # The whole front of the jaw is throat, ringed with teeth.
            for key in ("north", "east", "west"):
                fx, fy, fw, fh = faces[key]
                for yy in range(fh):
                    for xx in range(fw):
                        put(fx + xx, fy + yy, grain((16, 12, 12), 4))
                for xx in range(fw):
                    if xx % 2 == 0:
                        length = 1 + (xx // 2) % 3
                        for t in range(length):
                            put(fx + xx, fy + t, grain(light, 10))
            fx, fy, fw, fh = faces["top"]
            for yy in range(fh):
                for xx in range(fw):
                    put(fx + xx, fy + yy, grain(dark, 3))

        elif mat == "mask":
            # The face. Eight texels across is not much, so the read has to be
            # carried by three shapes only: two huge round eyes, a crack, and
            # the upper half of a grin. Anything subtler is mush at this size.
            fx, fy, fw, fh = faces["north"]
            for yy in range(fh):
                for xx in range(fw):
                    put(fx + xx, fy + yy, grain(base, 7))

            # Hairline crazing, like old porcelain.
            for _ in range(9):
                cx, cy = rng.randrange(fw), rng.randrange(fh - 2)
                for step in range(rng.randint(2, 4)):
                    put(fx + min(fw - 1, cx + step), fy + min(fh - 1, cy + step), grain(dark, 8))

            # Sockets, then the whites, then a single pupil each. The pupils sit
            # a texel inboard so the stare converges slightly in front of you.
            for ex, px_ in ((1, 2), (fw - 3, fw - 3)):
                for yy in range(1, 5):
                    for xx in range(ex - 1, ex + 3):
                        put(fx + xx, fy + yy, grain((22, 19, 20), 4))
                for yy in range(2, 4):
                    for xx in range(ex, ex + 2):
                        put(fx + xx, fy + yy, grain(light, 5))
            put(fx + 2, fy + 3, (10, 9, 10, 255))
            put(fx + fw - 3, fy + 3, (10, 9, 10, 255))

            # Upper teeth along the bottom edge: the top half of the grin.
            for xx in range(fw):
                put(fx + xx, fy + fh - 1, grain(light if xx % 2 == 0 else (18, 15, 15), 6))

            # The plate is one texel thick; its edges read as the rim of a mask.
            for key in ("east", "west", "top", "bottom", "south"):
                ex_, ey_, ew_, eh_ = faces[key]
                for yy in range(eh_):
                    for xx in range(ew_):
                        put(ex_ + xx, ey_ + yy, grain(dark, 5))

        elif mat == "grin":
            # The lower half of the grin. When the jaw swings, this is the piece
            # that tears away from the face.
            fx, fy, fw, fh = faces["north"]
            for yy in range(fh):
                for xx in range(fw):
                    put(fx + xx, fy + yy, grain(base, 7))
            for xx in range(fw):
                put(fx + xx, fy, grain(light if xx % 2 == 1 else dark, 6))
                if xx % 3 == 0:
                    put(fx + xx, fy + 1, grain(light, 6))
            for key in ("east", "west", "top", "bottom", "south"):
                ex_, ey_, ew_, eh_ = faces[key]
                for yy in range(eh_):
                    for xx in range(ew_):
                        put(ex_ + xx, ey_ + yy, grain(dark, 5))

        elif mat == "hair":
            # Lank and ragged. The alpha holes along the bottom edge are what
            # keep it from reading as a helmet.
            for key, (fx, fy, fw, fh) in faces.items():
                for yy in range(fh):
                    for xx in range(fw):
                        strand = light if (xx * 3 + yy) % 7 == 0 else base
                        put(fx + xx, fy + yy, grain(strand, 4))
                # Only the vertical faces get chewed, and never more than a
                # quarter of their height — the cap must stay solid on top or
                # the skull shows through it.
                if key in ("top", "bottom"):
                    continue
                for xx in range(fw):
                    for yy in range(rng.randint(0, max(1, fh // 4))):
                        put(fx + xx, fy + fh - 1 - yy, (0, 0, 0, 0))

        elif mat == "bone":
            # Fingers: pale, and paler still toward the tip.
            for key, (fx, fy, fw, fh) in faces.items():
                for yy in range(fh):
                    t = 1 - yy / max(1, fh - 1)
                    c = tuple(int(base[i] + (light[i] - base[i]) * t) for i in range(3))
                    for xx in range(fw):
                        put(fx + xx, fy + yy, grain(c, 5))
                    if yy % 4 == 3:
                        put(fx, fy + yy, grain(dark, 4))  # knuckle shadow

        elif mat == "skull":
            # Dark sockets high on the face, but no eyes in them.
            # The cranium. Its front is covered by the mask plate, so this is
            # only ever seen from the sides and above.
            fx, fy, fw, fh = faces["north"]
            for yy in range(fh):
                for xx in range(fw):
                    put(fx + xx, fy + yy, grain(dark, 4))
            for key in ("east", "west", "top", "south"):
                ex_, ey_, ew_, eh_ = faces[key]
                for yy in range(eh_):
                    for xx in range(ew_):
                        shade = light if yy < 2 else base
                        put(ex_ + xx, ey_ + yy, grain(shade, 5))

        elif mat == "horn":
            # Growth rings, banded along the length.
            for key, (fx, fy, fw, fh) in faces.items():
                for yy in range(fh):
                    band = light if yy % 3 == 0 else (dark if yy % 3 == 1 else base)
                    for xx in range(fw):
                        put(fx + xx, fy + yy, grain(band, 4))

        elif mat == "claw":
            # Dark at the root, bone-pale at the tip.
            for key, (fx, fy, fw, fh) in faces.items():
                for yy in range(fh):
                    t = yy / max(1, fh - 1)
                    c = tuple(int(base[i] + (light[i] - base[i]) * (t ** 2)) for i in range(3))
                    for xx in range(fw):
                        put(fx + xx, fy + yy, grain(c, 4))

        else:  # hide
            # Taut skin over bone: a lengthwise highlight and sunken edges.
            for key, (fx, fy, fw, fh) in faces.items():
                for yy in range(fh):
                    for xx in range(fw):
                        edge = xx == 0 or xx == fw - 1
                        ridge = fw > 2 and xx == fw // 2 and (yy % 4) != 0
                        c = dark if edge else (light if ridge else base)
                        put(fx + xx, fy + yy, grain(c, 5))
                        if rng.random() < 0.03:
                            put(fx + xx, fy + yy, grain(dark, 6))

    return px


if __name__ == "__main__":
    print("generating creature:")
    bones = build_bones()
    boxes = pack(bones)
    write_geometry(bones)
    write_png(RP / "textures" / "entity" / "watcher.png", paint(boxes, PALETTES["watcher"], 11))
    write_png(RP / "textures" / "entity" / "gaunt.png", paint(boxes, PALETTES["gaunt"], 11))
    print("done.")
