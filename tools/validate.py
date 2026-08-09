#!/usr/bin/env python3
"""
Pre-flight checks for the Notice packs.

Bedrock fails silently on most of these — a mistyped geometry identifier gives
you an invisible entity with no error anywhere — so it is worth catching them
here rather than in game.

    python3 tools/validate.py
"""

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
BP = ROOT / "packs" / "notice_BP"
RP = ROOT / "packs" / "notice_RP"

problems = []
checks = 0


def fail(msg):
    problems.append(msg)


def load(path):
    global checks
    checks += 1
    try:
        return json.loads(path.read_text())
    except Exception as exc:  # noqa: BLE001 - report and continue
        fail(f"{path.relative_to(ROOT)}: not valid JSON ({exc})")
        return None


def main():
    global checks

    # Every JSON file in both packs must parse.
    docs = {}
    for pack in (BP, RP):
        for path in sorted(pack.rglob("*.json")):
            docs[path] = load(path)

    # --- manifests -----------------------------------------------------------
    bp = docs.get(BP / "manifest.json")
    rp = docs.get(RP / "manifest.json")
    if not bp or not rp:
        fail("a manifest is missing or unparseable")
        return report()

    uuids = []
    for name, man in (("BP", bp), ("RP", rp)):
        uuids.append(man["header"]["uuid"])
        for mod in man["modules"]:
            uuids.append(mod["uuid"])
    checks += 1
    if len(set(uuids)) != len(uuids):
        fail(f"duplicate UUIDs across manifests: {uuids}")

    checks += 1
    deps = [d.get("uuid") for d in bp.get("dependencies", [])]
    if rp["header"]["uuid"] not in deps:
        fail("the behaviour pack does not declare the resource pack as a dependency")

    checks += 1
    script_mods = [m for m in bp["modules"] if m["type"] == "script"]
    if len(script_mods) != 1:
        fail("expected exactly one script module in the behaviour manifest")
    else:
        entry = BP / script_mods[0]["entry"]
        if not entry.exists():
            fail(f"script entry point does not exist: {script_mods[0]['entry']}")

    checks += 1
    if not any(d.get("module_name") == "@minecraft/server" for d in bp.get("dependencies", [])):
        fail("the behaviour manifest does not depend on @minecraft/server")

    # --- entities: BP identifier must have an RP counterpart -----------------
    bp_ids = set()
    for path in sorted((BP / "entities").glob("*.json")):
        doc = docs.get(path)
        if not doc:
            continue
        bp_ids.add(doc["minecraft:entity"]["description"]["identifier"])

    rp_ids = {}
    for path in sorted((RP / "entity").glob("*.json")):
        doc = docs.get(path)
        if not doc:
            continue
        desc = doc["minecraft:client_entity"]["description"]
        rp_ids[desc["identifier"]] = desc

    checks += 1
    for ident in bp_ids:
        if ident not in rp_ids:
            fail(f"entity {ident} has no client entity definition")

    # --- geometry, texture and render controller references resolve ----------
    geometries = set()
    for path in sorted((RP / "models").rglob("*.geo.json")):
        doc = docs.get(path)
        if not doc:
            continue
        for geo in doc["minecraft:geometry"]:
            geometries.add(geo["description"]["identifier"])

    controllers = set()
    for path in sorted((RP / "render_controllers").glob("*.json")):
        doc = docs.get(path)
        if not doc:
            continue
        controllers.update(doc["render_controllers"].keys())

    animations = set()
    for path in sorted((RP / "animations").glob("*.json")):
        doc = docs.get(path)
        if not doc:
            continue
        animations.update(doc.get("animations", {}).keys())

    # Animation controllers live in their own folder but are referenced from
    # the same `animations` map on a client entity, so they belong in the same
    # namespace as far as reference checking is concerned.
    controller_anims = {}
    for path in sorted((RP / "animation_controllers").glob("*.json")):
        doc = docs.get(path)
        if not doc:
            continue
        controller_anims.update(doc.get("animation_controllers", {}))
    animations.update(controller_anims.keys())

    for ident, desc in rp_ids.items():
        for key, geo in desc.get("geometry", {}).items():
            checks += 1
            if geo not in geometries:
                fail(f"{ident}: geometry '{geo}' is not defined by any .geo.json")
        for key, tex in desc.get("textures", {}).items():
            checks += 1
            if not (RP / f"{tex}.png").exists():
                fail(f"{ident}: texture '{tex}.png' is missing")
        for ctrl in desc.get("render_controllers", []):
            checks += 1
            name = ctrl if isinstance(ctrl, str) else next(iter(ctrl))
            if name not in controllers:
                fail(f"{ident}: render controller '{name}' is not defined")
        for key, anim in desc.get("animations", {}).items():
            checks += 1
            if anim not in animations:
                fail(f"{ident}: animation '{anim}' is not defined")

        # Anything named in scripts.animate has to resolve through the entity's
        # own animations map, or it silently never plays.
        for entry in desc.get("scripts", {}).get("animate", []):
            checks += 1
            key = entry if isinstance(entry, str) else next(iter(entry))
            if key not in desc.get("animations", {}):
                fail(f"{ident}: scripts.animate references '{key}', which is not "
                     f"in its animations map")

    # Every state a controller can transition to must exist, and every
    # animation short name it plays must be one the entity actually declares.
    for name, controller in controller_anims.items():
        users = [d for d in rp_ids.values() if name in d.get("animations", {}).values()]
        states = controller.get("states", {})
        checks += 1
        if controller.get("initial_state", "default") not in states:
            fail(f"{name}: initial_state is not one of its states")
        for state_name, state in states.items():
            for transition in state.get("transitions", []):
                for target in transition:
                    checks += 1
                    if target not in states:
                        fail(f"{name}: state '{state_name}' transitions to "
                             f"undefined state '{target}'")
            for anim in state.get("animations", []):
                short = anim if isinstance(anim, str) else next(iter(anim))
                for desc in users:
                    checks += 1
                    if short not in desc.get("animations", {}):
                        fail(f"{name}: state '{state_name}' plays '{short}', which "
                             f"{desc['identifier']} does not declare")

    # --- geometry UV boxes stay inside the texture ---------------------------
    for path in sorted((RP / "models").rglob("*.geo.json")):
        doc = docs.get(path)
        if not doc:
            continue
        for geo in doc["minecraft:geometry"]:
            tw = geo["description"]["texture_width"]
            th = geo["description"]["texture_height"]
            for bone in geo["bones"]:
                for cube in bone.get("cubes", []):
                    checks += 1
                    u, v = cube["uv"]
                    w, h, d = cube["size"]
                    if u + 2 * (w + d) > tw or v + h + d > th:
                        fail(
                            f"{path.name}: cube in bone '{bone['name']}' unwraps past the "
                            f"{tw}x{th} texture (uv {u},{v} size {w},{h},{d})"
                        )

    # --- fog ids referenced by the script all exist --------------------------
    config = (BP / "scripts" / "config.js").read_text()
    fog_ids = set(re.findall(r'"(nx:dread_\d)"', config))
    defined = set()
    for path in sorted((RP / "fogs").glob("*.json")):
        doc = docs.get(path)
        if doc:
            defined.add(doc["minecraft:fog_settings"]["description"]["identifier"])
    checks += 1
    missing = fog_ids - defined
    if missing:
        fail(f"config.js references undefined fog settings: {sorted(missing)}")

    # --- the item's icon key is registered in the atlas ----------------------
    atlas = docs.get(RP / "textures" / "item_texture.json") or {}
    item = docs.get(BP / "items" / "tallow_candle.json")
    if item:
        checks += 1
        key = item["minecraft:item"]["components"]["minecraft:icon"]["texture"]
        if key not in atlas.get("texture_data", {}):
            fail(f"item icon key '{key}' is not in item_texture.json")
        else:
            checks += 1
            tex = atlas["texture_data"][key]["textures"]
            if not (RP / f"{tex}.png").exists():
                fail(f"item texture '{tex}.png' is missing")

    # --- loot tables the behaviour pack points at exist ----------------------
    checks += 1
    if not (BP / "loot_tables" / "nx" / "aperture_reliquary.json").exists():
        fail("the aperture reliquary loot table is missing")
    checks += 1
    if not (BP / "loot_tables" / "empty.json").exists():
        fail("loot_tables/empty.json is missing (entities reference it)")

    # --- pack icons ----------------------------------------------------------
    for pack in (BP, RP):
        checks += 1
        if not (pack / "pack_icon.png").exists():
            fail(f"{pack.name} has no pack_icon.png")

    return report()


def report():
    if problems:
        print(f"FAILED — {len(problems)} problem(s) across {checks} checks:\n")
        for p in problems:
            print(f"  - {p}")
        return 1
    print(f"OK — {checks} checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
