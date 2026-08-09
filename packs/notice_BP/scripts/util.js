import { world } from "@minecraft/server";

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

export const v3 = (x, y, z) => ({ x, y, z });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const len = (a) => Math.sqrt(dot(a, a));

export function norm(a) {
  const l = len(a);
  return l < 1e-6 ? v3(0, 0, 0) : scale(a, 1 / l);
}

export function dist(a, b) {
  return len(sub(a, b));
}

/** Horizontal-only distance. Depth is handled separately everywhere in this pack. */
export function distXZ(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

export const centre = (block) => v3(block.x + 0.5, block.y + 0.5, block.z + 0.5);

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

export const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);
export const lerp = (a, b, t) => a + (b - a) * clamp(t, 0, 1);
export const rand = (lo, hi) => lo + Math.random() * (hi - lo);
export const randInt = (lo, hi) => Math.floor(rand(lo, hi + 1));

export function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---------------------------------------------------------------------------
// World access
//
// Every one of these can throw when a chunk is not loaded, which happens
// constantly at the edges of a player's simulation distance. Swallowing the
// throw and returning undefined is correct: an unloaded chunk is a place the
// Watcher is not allowed to use anyway.
// ---------------------------------------------------------------------------

export function safeBlock(dimension, location) {
  try {
    return dimension.getBlock(location);
  } catch {
    return undefined;
  }
}

export function isSolid(block) {
  if (!block) return false;
  try {
    return block.isSolid && !block.isLiquid;
  } catch {
    return false;
  }
}

export function isOpen(block) {
  if (!block) return false;
  try {
    return block.isAir || (!block.isSolid && !block.isLiquid);
  } catch {
    return false;
  }
}

/**
 * True when nothing solid sits between `from` and `to`.
 *
 * getBlockFromRay reports the first block the ray strikes. If that block is
 * further away than the target, the target itself is what the viewer sees.
 * The half-block slack absorbs the fact that raycast hits are reported at
 * block coordinates rather than at the exact intersection point.
 */
export function lineOfSight(dimension, from, to, maxDistance = 64) {
  const delta = sub(to, from);
  const d = len(delta);
  if (d < 0.01) return true;
  if (d > maxDistance) return false;
  try {
    const hit = dimension.getBlockFromRay(from, scale(delta, 1 / d), {
      maxDistance: Math.ceil(d),
      includeLiquidBlocks: false,
      includePassableBlocks: false,
    });
    if (!hit) return true;
    return dist(centre(hit.block.location), from) >= d - 0.55;
  } catch {
    return false;
  }
}

/** True when `point` falls inside the player's view cone, occlusion ignored. */
export function inViewCone(player, point, minDot) {
  try {
    const eye = player.getHeadLocation();
    const toPoint = norm(sub(point, eye));
    return dot(toPoint, player.getViewDirection()) >= minDot;
  } catch {
    return false;
  }
}

/** Signed cone alignment: 1 is dead centre, 0 is perpendicular, -1 is directly behind. */
export function coneDot(player, point) {
  try {
    const eye = player.getHeadLocation();
    return dot(norm(sub(point, eye)), player.getViewDirection());
  } catch {
    return -1;
  }
}

/**
 * Can `player` actually see `point` right now?
 *
 * Deliberately biased toward "yes". A false positive costs nothing — the
 * Watcher simply declines to move this cycle. A false negative would let a
 * player watch it teleport, which is the one failure the entity cannot survive.
 */
export function canSee(player, point, minDot, maxDistance = 64) {
  if (!inViewCone(player, point, minDot)) return false;
  return lineOfSight(player.dimension, player.getHeadLocation(), point, maxDistance);
}

/** True when the location has an unobstructed column to the sky. */
export function seesSky(dimension, location) {
  try {
    const top = dimension.getTopmostBlock({ x: Math.floor(location.x), z: Math.floor(location.z) });
    if (!top) return true;
    return location.y >= top.location.y;
  } catch {
    return false;
  }
}

/** Bedrock daytime runs 0..24000; roughly 1000..12000 is usable daylight. */
export function isDaytime() {
  const t = world.getTimeOfDay();
  return t >= 700 && t <= 12300;
}

export const chunkKey = (dim, loc) =>
  `${dim.id}:${Math.floor(loc.x / 16)},${Math.floor(loc.z / 16)}`;

export function playSafe(target, id, options) {
  try {
    target.playSound(id, options);
  } catch {
    /* an unavailable sound event is never worth breaking a tick over */
  }
}

/**
 * Entity properties are the only channel from script to the client renderer.
 * They arrived later than the rest of the API surface this pack uses, so a
 * failure here degrades to "the animation never plays" rather than throwing.
 */
export function setProp(entity, name, value) {
  try {
    entity.setProperty(name, value);
    return true;
  } catch {
    return false;
  }
}

export function runSafe(entity, command) {
  try {
    entity.runCommand(command);
    return true;
  } catch {
    return false;
  }
}
