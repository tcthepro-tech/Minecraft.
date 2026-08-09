#!/usr/bin/env python3
"""
Generate every PNG the pack ships.

There is no image library in this toolchain, so the PNG encoder below is hand
rolled on top of zlib. That constraint suits the art direction: the Watcher is
meant to be a near-black silhouette that the player's eye keeps trying and
failing to resolve, which is exactly what procedural noise around RGB 8 gives
you. Re-run this script to regenerate the textures; nothing else depends on it
at runtime.

    python3 tools/gen_textures.py
"""

import math
import pathlib
import random
import struct
import zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
RP = ROOT / "packs" / "notice_RP"
BP = ROOT / "packs" / "notice_BP"

random.seed(7)  # deterministic output, so regenerating never churns the diff

TRANSPARENT = (0, 0, 0, 0)


def write_png(path, pixels):
    """pixels: list of rows, each row a list of (r, g, b, a) tuples."""
    height = len(pixels)
    width = len(pixels[0])
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filter type 0 (None) for every scanline
        for r, g, b, a in row:
            raw += bytes((r & 255, g & 255, b & 255, a & 255))

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)
    print(f"  {path.relative_to(ROOT)}  {width}x{height}")


def blank(width, height, fill=TRANSPARENT):
    return [[fill for _ in range(width)] for _ in range(height)]


def fill_rect(px, x0, y0, w, h, fn):
    for y in range(y0, y0 + h):
        for x in range(x0, x0 + w):
            if 0 <= y < len(px) and 0 <= x < len(px[0]):
                px[y][x] = fn(x, y)


def jitter(base, spread):
    return max(0, min(255, base + random.randint(-spread, spread)))


# ---------------------------------------------------------------------------
# The Watcher
# ---------------------------------------------------------------------------

def watcher():
    """
    Almost pure black. The only features are two eyes barely a shade above the
    surrounding value — enough that a player who stares will convince themselves
    they resolved a face, and never enough to be certain.
    """
    px = blank(64, 64)

    def skin(x, y):
        # A slow vertical gradient plus grain reads as cloth rather than plastic.
        v = 7 + int(2.5 * math.sin(y * 0.31)) + int(1.5 * math.cos(x * 0.47))
        return (jitter(v, 3), jitter(v, 3), jitter(v + 2, 3), 255)

    # Box UV footprints, matching watcher.geo.json exactly.
    #            x,  y,   w,  h
    regions = [
        (0, 0, 28, 14),    # head   7x7x7 @ (0,0)
        (28, 0, 24, 20),   # body   8x16x4 @ (28,0)
        (0, 16, 12, 27),   # arm R  3x24x3 @ (0,16)
        (14, 16, 12, 27),  # arm L  3x24x3 @ (14,16)
        (28, 22, 12, 23),  # leg R  3x20x3 @ (28,22)
        (42, 22, 12, 23),  # leg L  3x20x3 @ (42,22)
    ]
    for x, y, w, h in regions:
        fill_rect(px, x, y, w, h, skin)

    # Vertical striation down the body's front face (u 32..40, v 4..20).
    for x in range(32, 40, 2):
        for y in range(4, 20):
            r, g, b, a = px[y][x]
            px[y][x] = (max(0, r - 3), max(0, g - 3), max(0, b - 3), a)

    # Eyes. The head's north (front) face occupies u 7..14, v 7..14.
    for x in (8, 9, 11, 12):
        for y in (10,):
            px[y][x] = (jitter(54, 6), jitter(54, 6), jitter(60, 6), 255)
    # A single dimmer pixel under each eye keeps them from reading as a smiley.
    for x in (8, 12):
        px[11][x] = (22, 22, 26, 255)

    write_png(RP / "textures" / "entity" / "watcher.png", px)


# ---------------------------------------------------------------------------
# The Kindler
# ---------------------------------------------------------------------------

def kindler():
    """
    Rendered with `entity_emissive_alpha`: fully opaque texels light normally,
    partially transparent ones glow. Only the flame is given partial alpha, so
    the figure itself stays as dark as the Watcher — you have to get close
    enough to tell which one you found.
    """
    px = blank(64, 64)

    def cloth(x, y):
        v = 19 + int(4 * math.sin(y * 0.22 + x * 0.11))
        return (jitter(v, 4), jitter(v - 2, 4), jitter(v - 4, 4), 255)

    def hood(x, y):
        v = 12 + int(3 * math.cos(y * 0.4))
        return (jitter(v, 3), jitter(v - 1, 3), jitter(v - 2, 3), 255)

    fill_rect(px, 0, 0, 36, 30, cloth)     # cloak 10x22x8 @ (0,0)
    fill_rect(px, 0, 32, 30, 14, hood)     # hood   8x7x7  @ (0,32)

    def fire(x, y):
        # Alpha below 255 is the emissive channel for this material.
        t = (y - 0) / 8.0
        r = int(255 - 30 * t)
        g = int(180 - 90 * t)
        b = int(70 - 55 * t)
        return (r, max(0, g), max(0, b), 176)

    fill_rect(px, 40, 0, 8, 8, fire)       # flame 2x3x2 @ (40,0)

    # A weak spill of firelight onto the front of the hood.
    for y in range(34, 40):
        for x in range(7, 15):
            r, g, b, a = px[y][x]
            k = 1.0 - (y - 34) / 7.0
            px[y][x] = (
                min(255, r + int(46 * k)),
                min(255, g + int(26 * k)),
                min(255, b + int(8 * k)),
                a,
            )

    write_png(RP / "textures" / "entity" / "kindler.png", px)


# ---------------------------------------------------------------------------
# The Hollow — nothing at all
# ---------------------------------------------------------------------------

def void():
    write_png(RP / "textures" / "entity" / "void.png", blank(16, 16))


# ---------------------------------------------------------------------------
# Tallow candle
# ---------------------------------------------------------------------------

def candle():
    px = blank(16, 16)

    # Wax column.
    for y in range(6, 15):
        for x in range(6, 10):
            shade = 214 - (x - 6) * 12 + random.randint(-5, 5)
            px[y][x] = (shade, shade - 12, shade - 34, 255)
    # Wick.
    px[5][7] = (38, 34, 30, 255)
    px[5][8] = (38, 34, 30, 255)
    # Flame.
    flame = [(7, 2), (8, 2), (7, 3), (8, 3), (7, 4), (8, 4), (6, 3), (9, 3)]
    for x, y in flame:
        core = (x in (7, 8)) and y >= 3
        px[y][x] = (255, 232, 150, 255) if core else (240, 158, 52, 255)
    # Base rim.
    for x in range(5, 11):
        px[15][x] = (168, 150, 118, 255)

    write_png(RP / "textures" / "items" / "tallow_candle.png", px)


# ---------------------------------------------------------------------------
# Pack icons
# ---------------------------------------------------------------------------

def pack_icon(path, lit):
    """A doorway with nothing behind it — the shape the whole pack is about."""
    px = blank(64, 64)
    for y in range(64):
        for x in range(64):
            v = jitter(11 + int(6 * (y / 64.0)), 3)
            px[y][x] = (v, v, v + 3, 255)

    # Frame.
    for y in range(14, 56):
        for x in range(20, 44):
            edge = x < 24 or x > 39 or y < 18
            if edge:
                v = jitter(46 if lit else 34, 5)
                px[y][x] = (v, v - 3, v - 6, 255)
            else:
                px[y][x] = (3, 3, 5, 255)

    if lit:
        # A pale suggestion standing in the opening, two-thirds of the way back.
        for y in range(26, 52):
            for x in range(29, 35):
                v = jitter(24, 4)
                px[y][x] = (v, v, v + 2, 255)
        for x in (30, 33):
            px[30][x] = (96, 96, 104, 255)

    write_png(path, px)


if __name__ == "__main__":
    print("generating textures:")
    watcher()
    kindler()
    void()
    candle()
    pack_icon(BP / "pack_icon.png", lit=True)
    pack_icon(RP / "pack_icon.png", lit=False)
    print("done.")
