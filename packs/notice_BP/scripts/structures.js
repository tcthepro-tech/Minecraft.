import { world, system } from "@minecraft/server";
import { STRUCTURE, NOTICE, PROP } from "./config.js";
import * as Notice from "./notice.js";
import {
  v3, dist, clamp, lerp, rand, randInt, safeBlock, isSolid, seesSky, chunkKey,
} from "./util.js";

/**
 * Apertures.
 *
 * A doorway, standing free in a sealed room, with nothing on the other side.
 * They are not dungeons and hold almost nothing worth taking — the reliquary
 * exists so that the player has to choose whether to open it, because opening
 * it is the single largest jump in notice the pack can produce.
 *
 * Generation is script-driven rather than a .mcstructure so that placement can
 * be gated on notice: apertures only cut into rock for players something is
 * already paying attention to. A fresh world contains none of them.
 */

const nextAttempt = new Map(); // playerId -> tick
const touchedChunks = new Set(); // per session; a reset only costs a little notice

const FRAME = "minecraft:polished_blackstone_bricks";
const PILLAR = "minecraft:chiseled_polished_blackstone";
const WALL = "minecraft:deepslate_tiles";
const WORN = "minecraft:cracked_deepslate_tiles";
const FLOOR = "minecraft:polished_blackstone";
const WEB = "minecraft:cobweb";

// ---------------------------------------------------------------------------
// World memory
// ---------------------------------------------------------------------------

function loadSites() {
  const raw = world.getDynamicProperty(PROP.APERTURES);
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveSites(sites) {
  const trimmed = sites.slice(-STRUCTURE.MEMORY);
  try {
    world.setDynamicProperty(PROP.APERTURES, JSON.stringify(trimmed));
  } catch {
    /* the world property is a nicety, not a requirement */
  }
}

function tooClose(sites, dimId, at) {
  for (const s of sites) {
    if (s.d !== dimId) continue;
    if (dist(v3(s.x, s.y, s.z), at) < 90) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Site selection
// ---------------------------------------------------------------------------

function setBlock(dimension, x, y, z, typeId) {
  try {
    dimension.getBlock({ x, y, z })?.setType(typeId);
    return true;
  } catch {
    return false;
  }
}

/**
 * A candidate site must be buried. Sampling the volume and demanding it be
 * almost entirely solid keeps apertures out of existing caves, mineshafts and
 * — importantly — anything a player has already dug or built.
 */
function isBuried(dimension, origin, halfW, halfH, halfD) {
  let solid = 0;
  let total = 0;
  for (let dx = -halfW; dx <= halfW; dx += 2) {
    for (let dy = -halfH; dy <= halfH; dy += 2) {
      for (let dz = -halfD; dz <= halfD; dz += 2) {
        const b = safeBlock(dimension, { x: origin.x + dx, y: origin.y + dy, z: origin.z + dz });
        if (!b) return false; // unloaded chunk — not our business
        total++;
        if (isSolid(b)) solid++;
        // Never carve through anything a player might have placed on purpose.
        if (
          b.typeId.includes("chest") ||
          b.typeId.includes("torch") ||
          b.typeId.includes("bed") ||
          b.typeId.includes("crafting") ||
          b.typeId.includes("furnace") ||
          b.typeId.includes("spawner") ||
          b.typeId.includes("portal") ||
          b.typeId.includes("door")
        ) {
          return false;
        }
      }
    }
  }
  return total > 0 && solid / total >= 0.9;
}

function findSite(player, halfW, halfH, halfD, maxY) {
  const dimension = player.dimension;
  const sites = loadSites();

  for (let attempt = 0; attempt < 8; attempt++) {
    const angle = rand(0, Math.PI * 2);
    const r = rand(STRUCTURE.PLACE_DISTANCE[0], STRUCTURE.PLACE_DISTANCE[1]);
    const x = Math.floor(player.location.x + Math.cos(angle) * r);
    const z = Math.floor(player.location.z + Math.sin(angle) * r);
    const y = Math.floor(clamp(player.location.y + rand(-8, 4), STRUCTURE.MIN_Y, maxY));

    const origin = v3(x, y, z);
    if (tooClose(sites, dimension.id, origin)) continue;
    if (!isBuried(dimension, origin, halfW, halfH, halfD)) continue;
    return origin;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Interior is 7 x 4 x 7 centred on `origin`, shelled in deepslate tile, with a
 * free-standing blackstone doorway on the centre line and a chest set into it.
 * The doorway leads nowhere. That is the entire idea of the room.
 */
function build(dimension, origin) {
  const { x: ox, y: oy, z: oz } = origin;
  const hw = 3;
  const hd = 3;
  const floorY = oy - 1;
  const ceilY = oy + 4;

  for (let x = -hw - 1; x <= hw + 1; x++) {
    for (let z = -hd - 1; z <= hd + 1; z++) {
      for (let y = floorY; y <= ceilY; y++) {
        const edge = Math.abs(x) > hw || Math.abs(z) > hd || y === floorY || y === ceilY;
        const bx = ox + x;
        const bz = oz + z;
        if (edge) {
          const worn = Math.random() < 0.22;
          setBlock(dimension, bx, y, bz, y === floorY ? FLOOR : worn ? WORN : WALL);
        } else {
          setBlock(dimension, bx, y, bz, "minecraft:air");
        }
      }
    }
  }

  // The aperture: a 3-wide, 3-tall frame standing free on the centre line.
  const fz = oz;
  for (let y = oy; y <= oy + 3; y++) {
    setBlock(dimension, ox - 1, y, fz, y === oy + 3 ? FRAME : PILLAR);
    setBlock(dimension, ox + 1, y, fz, y === oy + 3 ? FRAME : PILLAR);
  }
  setBlock(dimension, ox, oy + 3, fz, FRAME);
  for (let y = oy; y <= oy + 2; y++) setBlock(dimension, ox, y, fz, "minecraft:air");

  // The reliquary, seated in the mouth of the doorway.
  const chest = v3(ox, oy, fz);
  setBlock(dimension, chest.x, chest.y, chest.z, "minecraft:chest");

  for (let i = 0; i < 10; i++) {
    const wx = ox + Math.round(rand(-hw, hw));
    const wz = oz + Math.round(rand(-hd, hd));
    const wy = oy + Math.round(rand(0, 3));
    const b = safeBlock(dimension, { x: wx, y: wy, z: wz });
    if (b && b.isAir) setBlock(dimension, wx, wy, wz, WEB);
  }

  try {
    dimension.runCommand(
      `loot insert ${chest.x} ${chest.y} ${chest.z} loot "nx/aperture_reliquary"`
    );
  } catch {
    /* an empty reliquary is still a choice the player has to make */
  }

  return chest;
}

function record(player, kind, origin, chest) {
  const sites = loadSites();
  sites.push({
    k: kind,
    d: player.dimension.id,
    x: origin.x,
    y: origin.y,
    z: origin.z,
    cx: chest ? chest.x : undefined,
    cy: chest ? chest.y : undefined,
    cz: chest ? chest.z : undefined,
    open: false,
  });
  saveSites(sites);
}

/**
 * Pick and place one structure.
 *
 * Which one is decided by where the player is, not by a roll: apertures and
 * ossuaries cut into rock, effigies only stand under open sky. A player who
 * never goes underground will only ever meet effigies, and a player who never
 * surfaces will never see one.
 */
function attempt(player) {
  const notice = Notice.get(player);
  const now = system.currentTick;
  const due = nextAttempt.get(player.id) ?? now + STRUCTURE.PERIOD * 20;
  if (now < due) {
    nextAttempt.set(player.id, due);
    return;
  }
  nextAttempt.set(player.id, now + STRUCTURE.PERIOD * 20 * rand(0.8, 1.25));

  const y = player.location.y;
  const underground = y <= STRUCTURE.OSSUARY_MAX_Y;
  const t = clamp((notice - STRUCTURE.OSSUARY_MIN_NOTICE) /
    (NOTICE.MAX - STRUCTURE.OSSUARY_MIN_NOTICE), 0, 1);

  // Aperture: deepest, rarest, and the only one worth +22 notice.
  if (underground && notice >= STRUCTURE.MIN_NOTICE && y <= STRUCTURE.MAX_Y) {
    if (Math.random() <= lerp(STRUCTURE.CHANCE_MIN, STRUCTURE.CHANCE_MAX, t)) {
      const origin = findSite(player, 5, 4, 5, STRUCTURE.MAX_Y);
      if (origin) {
        record(player, "aperture", origin, build(player.dimension, origin));
        return;
      }
    }
  }

  // Ossuary: shallower, commoner, small payout.
  if (underground && notice >= STRUCTURE.OSSUARY_MIN_NOTICE) {
    if (Math.random() <= STRUCTURE.OSSUARY_CHANCE * (0.4 + t)) {
      const origin = findSite(player, 4, 3, 4, STRUCTURE.OSSUARY_MAX_Y);
      if (origin) {
        record(player, "ossuary", origin, buildOssuary(player.dimension, origin));
        return;
      }
    }
  }

  // Effigy: surface only, and only where the ground is open and untouched.
  if (notice >= STRUCTURE.EFFIGY_MIN_NOTICE && seesSky(player.dimension, player.location)) {
    if (Math.random() <= STRUCTURE.EFFIGY_CHANCE * (0.4 + t)) {
      const sites = loadSites();
      for (let a = 0; a < 6; a++) {
        const angle = rand(0, Math.PI * 2);
        const r = rand(STRUCTURE.PLACE_DISTANCE[0], STRUCTURE.PLACE_DISTANCE[1]);
        const ox = Math.floor(player.location.x + Math.cos(angle) * r);
        const oz = Math.floor(player.location.z + Math.sin(angle) * r);
        const origin = v3(ox, Math.floor(player.location.y), oz);
        if (tooClose(sites, player.dimension.id, origin)) continue;
        if (!effigySiteOk(player.dimension, origin)) continue;
        const centre = buildEffigy(player.dimension, origin);
        if (centre) record(player, "effigy", centre, undefined);
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The Ossuary — a bone-lined chamber
//
// Shallower and commoner than an Aperture, and worth much less. Its job is to
// make the deep feel occupied rather than empty: somebody stacked these.
// ---------------------------------------------------------------------------

const BONE = "minecraft:bone_block";

function buildOssuary(dimension, origin) {
  const { x: ox, y: oy, z: oz } = origin;
  const hw = 2;
  const hd = 2;
  const floorY = oy - 1;
  const ceilY = oy + 3;

  for (let x = -hw - 1; x <= hw + 1; x++) {
    for (let z = -hd - 1; z <= hd + 1; z++) {
      for (let y = floorY; y <= ceilY; y++) {
        const edge = Math.abs(x) > hw || Math.abs(z) > hd || y === floorY || y === ceilY;
        if (edge) {
          const worn = Math.random() < 0.35;
          setBlock(dimension, ox + x, y, oz + z, y === floorY ? BONE : worn ? WORN : WALL);
        } else {
          setBlock(dimension, ox + x, y, oz + z, "minecraft:air");
        }
      }
    }
  }

  // Stacked bone in the corners, floor to ceiling.
  for (const [cx, cz] of [[-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd]]) {
    for (let y = oy; y <= oy + 2; y++) {
      if (Math.random() < 0.8) setBlock(dimension, ox + cx, y, oz + cz, BONE);
    }
  }

  for (let i = 0; i < 8; i++) {
    const wx = ox + Math.round(rand(-hw, hw));
    const wz = oz + Math.round(rand(-hd, hd));
    const wy = oy + Math.round(rand(0, 2));
    const b = safeBlock(dimension, { x: wx, y: wy, z: wz });
    if (b && b.isAir) setBlock(dimension, wx, wy, wz, WEB);
  }

  const chest = v3(ox, oy, oz + hd - 1);
  setBlock(dimension, chest.x, chest.y, chest.z, "minecraft:chest");
  try {
    dimension.runCommand(
      `loot insert ${chest.x} ${chest.y} ${chest.z} loot "nx/ossuary"`
    );
  } catch {
    /* an empty chest is still a chest */
  }
  return chest;
}

// ---------------------------------------------------------------------------
// The Effigy — a ring of standing stones on the surface
//
// The only structure the pack puts where daylight can reach it. Someone built
// this above ground, in the open, and then left.
// ---------------------------------------------------------------------------

function buildEffigy(dimension, origin) {
  const { x: ox, y: oy, z: oz } = origin;
  const radius = 4;
  const count = 5;

  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + rand(-0.12, 0.12);
    const px = ox + Math.round(Math.cos(angle) * radius);
    const pz = oz + Math.round(Math.sin(angle) * radius);
    const base = surfaceY(dimension, px, pz, oy);
    if (base === undefined) continue;
    const height = randInt(3, 5);
    for (let h = 0; h < height; h++) {
      setBlock(dimension, px, base + h, pz, h === height - 1 ? PILLAR : "minecraft:polished_basalt");
    }
    if (Math.random() < 0.5) {
      setBlock(dimension, px, base + height, pz, "minecraft:chain");
    }
  }

  // The centre post, and whatever is on top of it.
  const centreBase = surfaceY(dimension, ox, oz, oy);
  if (centreBase === undefined) return undefined;
  for (let h = 0; h < 5; h++) {
    setBlock(dimension, ox, centreBase + h, oz, h % 2 === 0 ? PILLAR : FRAME);
  }
  setBlock(dimension, ox, centreBase + 5, oz, "minecraft:skeleton_skull");

  for (let i = 0; i < 10; i++) {
    const sx = ox + randInt(-radius, radius);
    const sz = oz + randInt(-radius, radius);
    const sy = surfaceY(dimension, sx, sz, oy);
    if (sy === undefined) continue;
    const under = safeBlock(dimension, { x: sx, y: sy - 1, z: sz });
    if (under && !under.isAir && Math.random() < 0.6) {
      setBlock(dimension, sx, sy - 1, sz, "minecraft:soul_soil");
    }
  }

  return v3(ox, centreBase, oz);
}

/** First open block above the surface at this column. */
function surfaceY(dimension, x, z, near) {
  try {
    const top = dimension.getTopmostBlock({ x, z });
    if (top && Math.abs(top.location.y - near) < 24) return top.location.y + 1;
  } catch {
    /* fall through */
  }
  for (let y = Math.floor(near) + 8; y > Math.floor(near) - 12; y--) {
    if (isSolid(safeBlock(dimension, { x, y: y - 1, z })) &&
        (safeBlock(dimension, { x, y, z })?.isAir ?? false)) {
      return y;
    }
  }
  return undefined;
}

/** An effigy needs open sky and reasonably flat ground. */
function effigySiteOk(dimension, origin) {
  let base;
  for (let dx = -5; dx <= 5; dx += 2) {
    for (let dz = -5; dz <= 5; dz += 2) {
      const y = surfaceY(dimension, origin.x + dx, origin.z + dz, origin.y);
      if (y === undefined) return false;
      if (base === undefined) base = y;
      if (Math.abs(y - base) > 3) return false;
      // Nothing man-made underfoot.
      const b = safeBlock(dimension, { x: origin.x + dx, y: y - 1, z: origin.z + dz });
      if (!b) return false;
      const t = b.typeId;
      if (t.includes("planks") || t.includes("chest") || t.includes("torch") ||
          t.includes("door") || t.includes("crafting") || t.includes("wool") ||
          t.includes("bricks") || t.includes("glass")) {
        return false;
      }
      const above = safeBlock(dimension, { x: origin.x + dx, y: y + 4, z: origin.z + dz });
      if (above && !above.isAir) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Trespass
// ---------------------------------------------------------------------------

/**
 * Two kinds of trespass, both event-driven.
 *
 * Virgin chunk: the first block you break in a chunk nobody has touched this
 * session, deep enough that it cannot be a surface build.
 *
 * Enclosed rock: a block with solid neighbours on all sides. You did not walk
 * into this space — you made it, and it had never been open before.
 */
export function onBreak(event) {
  const player = event.player;
  const block = event.block;
  if (!player || !block) return;
  if (block.location.y > NOTICE.TRESPASS_MAX_Y) return;

  const key = chunkKey(player.dimension, block.location);
  if (!touchedChunks.has(key)) {
    touchedChunks.add(key);
    if (touchedChunks.size > 4096) touchedChunks.clear();
    Notice.add(player, NOTICE.VIRGIN_CHUNK_GAIN);
    return;
  }

  const { x, y, z } = block.location;
  const neighbours = [
    { x: x + 1, y, z }, { x: x - 1, y, z },
    { x, y: y + 1, z }, { x, y: y - 1, z },
    { x, y, z: z + 1 }, { x, y, z: z - 1 },
  ];
  for (const n of neighbours) {
    if (!isSolid(safeBlock(player.dimension, n))) return;
  }
  Notice.add(player, NOTICE.TRESPASS_GAIN);
}

/** Opening a reliquary. Once per site, and it is never worth the loot. */
export function onInteract(event) {
  const player = event.player;
  const block = event.block;
  if (!player || !block || !block.typeId.includes("chest")) return;

  const sites = loadSites();
  let changed = false;
  for (const s of sites) {
    if (s.open) continue;
    if (s.d !== player.dimension.id) continue;
    if (s.cx !== block.location.x || s.cy !== block.location.y || s.cz !== block.location.z) continue;
    s.open = true;
    changed = true;
    Notice.add(player, s.k === "ossuary" ? STRUCTURE.OSSUARY_GAIN : NOTICE.APERTURE_GAIN);
    break;
  }
  if (changed) saveSites(sites);
}

export function tick(players) {
  for (const player of players) {
    try {
      attempt(player);
    } catch {
      /* generation is best-effort by design */
    }
  }
}

export function forget(playerId) {
  nextAttempt.delete(playerId);
}
