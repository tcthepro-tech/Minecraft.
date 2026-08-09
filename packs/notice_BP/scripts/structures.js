import { world, system } from "@minecraft/server";
import { STRUCTURE, NOTICE, PROP } from "./config.js";
import * as Notice from "./notice.js";
import { v3, dist, clamp, lerp, rand, safeBlock, isSolid, chunkKey } from "./util.js";

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

function findSite(player) {
  const dimension = player.dimension;
  const sites = loadSites();

  for (let attempt = 0; attempt < 8; attempt++) {
    const angle = rand(0, Math.PI * 2);
    const r = rand(STRUCTURE.PLACE_DISTANCE[0], STRUCTURE.PLACE_DISTANCE[1]);
    const x = Math.floor(player.location.x + Math.cos(angle) * r);
    const z = Math.floor(player.location.z + Math.sin(angle) * r);
    const y = Math.floor(clamp(player.location.y + rand(-8, 4), STRUCTURE.MIN_Y, STRUCTURE.MAX_Y));

    const origin = v3(x, y, z);
    if (tooClose(sites, dimension.id, origin)) continue;
    if (!isBuried(dimension, origin, 5, 4, 5)) continue;
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

function attempt(player) {
  const notice = Notice.get(player);
  if (notice < STRUCTURE.MIN_NOTICE) return;
  if (player.location.y > STRUCTURE.MAX_Y) return;

  const now = system.currentTick;
  const due = nextAttempt.get(player.id) ?? now + STRUCTURE.PERIOD * 20;
  if (now < due) {
    nextAttempt.set(player.id, due);
    return;
  }
  nextAttempt.set(player.id, now + STRUCTURE.PERIOD * 20 * rand(0.8, 1.25));

  const t = (notice - STRUCTURE.MIN_NOTICE) / (NOTICE.MAX - STRUCTURE.MIN_NOTICE);
  if (Math.random() > lerp(STRUCTURE.CHANCE_MIN, STRUCTURE.CHANCE_MAX, clamp(t, 0, 1))) return;

  const origin = findSite(player);
  if (!origin) return;

  const chest = build(player.dimension, origin);

  const sites = loadSites();
  sites.push({
    d: player.dimension.id,
    x: origin.x,
    y: origin.y,
    z: origin.z,
    cx: chest.x,
    cy: chest.y,
    cz: chest.z,
    open: false,
  });
  saveSites(sites);
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
    Notice.add(player, NOTICE.APERTURE_GAIN);
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
