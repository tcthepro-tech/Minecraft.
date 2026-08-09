import { world, system } from "@minecraft/server";
import { WATCHER, NOTICE, PROP, SFX } from "./config.js";
import * as Notice from "./notice.js";
import {
  v3, dist, distXZ, clamp, rand, randInt,
  safeBlock, isSolid, isOpen, lineOfSight, coneDot, canSee, seesSky, playSafe,
} from "./util.js";

/**
 * The Watcher.
 *
 * One rule, enforced by every branch below: it is never seen moving. Every
 * other property of the entity — no pathfinding, no aggro, no sound on
 * arrival, no head tracking — exists to protect that rule, because the moment
 * a player catches it in motion it stops being a presence and becomes a mob.
 */

/** playerId -> state. In-memory only; rebuilt on load by sweep(). */
const states = new Map();

/**
 * Anchor selection is by far the most expensive thing the pack does — a few
 * hundred block reads and a few dozen raycasts, all inside one tick. Randomised
 * per-player cadence usually keeps those apart, but "usually" is not a
 * guarantee, and on a full server the collisions are exactly what a player
 * would feel as a stutter. So searches are rationed globally: one per tick,
 * everyone else waits a few ticks and tries again.
 */
const SEARCHES_PER_TICK = 1;
let searchBudget = 0;

function claimSearch() {
  if (searchBudget <= 0) return false;
  searchBudget--;
  return true;
}

function stateFor(player) {
  let s = states.get(player.id);
  if (!s) {
    s = {
      entityId: undefined,
      tier: 0,
      placedAt: 0,
      stareTicks: 0,
      lastStareCredit: 0,
      seen: false,
      readyToLeave: false,
      cooldownUntil: 0,
      nextCycle: 0,
    };
    states.set(player.id, s);
  }
  return s;
}

/** `isValid` is a method on older script API builds and a property on newer ones. */
function alive(entity) {
  if (!entity) return false;
  const v = entity.isValid;
  return typeof v === "function" ? v.call(entity) : v !== false;
}

function entityOf(state) {
  if (!state.entityId) return undefined;
  try {
    const e = world.getEntity(state.entityId);
    return alive(e) ? e : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Permitted distance — the mechanic the whole pack is built around
// ---------------------------------------------------------------------------

/**
 * notice does not decide whether the Watcher is hostile. It decides how close
 * the world is willing to let it stand. Stealth tier pushes that boundary back
 * out, which is why staring at it makes it *more* distant, not less.
 */
export function permittedRadius(player, tier) {
  const p = clamp(Notice.get(player) / NOTICE.MAX, 0, 1);
  const base = WATCHER.FAR - (WATCHER.FAR - WATCHER.NEAR) * Math.pow(p, WATCHER.CURVE);
  const withTier = base * (1 + WATCHER.TIER_RADIUS_BONUS * tier);
  return clamp(withTier, WATCHER.MIN_ABSOLUTE, WATCHER.FAR * 1.8);
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

/**
 * Sample the Watcher's silhouette rather than a single point. A head-only test
 * would let it slip behind a one-block lip while its body stayed on screen.
 */
function samplePoints(location) {
  return [
    v3(location.x, location.y + 2.5, location.z),
    v3(location.x, location.y + 1.4, location.z),
    v3(location.x, location.y + 0.3, location.z),
  ];
}

/**
 * Is any player currently looking at this position?
 *
 * This is the multiplayer-safe half of the entity: a second player standing
 * off to the side vetoes the teleport just as effectively as the tracked one,
 * so nobody can ever be positioned to catch it repositioning.
 */
export function observedByAnyone(dimension, location, players, ignoreId) {
  for (const p of players) {
    if (ignoreId && p.id === ignoreId) continue;
    if (p.dimension.id !== dimension.id) continue;
    if (dist(p.location, location) > 72) continue;
    for (const point of samplePoints(location)) {
      if (canSee(p, point, WATCHER.OBSERVE_DOT, 72)) return p;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Anchor selection
// ---------------------------------------------------------------------------

/**
 * Walk down from a candidate column to the first surface with head clearance.
 * Returns the standing position (feet), or undefined if nothing here will hold
 * a two-and-a-half block figure upright.
 */
function findGround(dimension, x, z, fromY) {
  const top = Math.floor(fromY + WATCHER.GROUND_UP);
  const bottom = Math.floor(fromY - WATCHER.GROUND_DOWN);
  for (let y = top; y >= bottom; y--) {
    const floor = safeBlock(dimension, { x, y: y - 1, z });
    if (!isSolid(floor)) continue;
    const feet = safeBlock(dimension, { x, y, z });
    const chest = safeBlock(dimension, { x, y: y + 1, z });
    const head = safeBlock(dimension, { x, y: y + 2, z });
    if (isOpen(feet) && isOpen(chest) && isOpen(head)) {
      return v3(x + 0.5, y, z + 0.5);
    }
  }
  return undefined;
}

/** Solid blocks flanking the head. A figure framed by a doorway reads as intentional. */
function framing(dimension, loc) {
  let count = 0;
  const offsets = [
    v3(1, 2, 0), v3(-1, 2, 0), v3(0, 2, 1), v3(0, 2, -1),
    v3(1, 1, 0), v3(-1, 1, 0), v3(0, 1, 1), v3(0, 1, -1),
  ];
  for (const o of offsets) {
    const b = safeBlock(dimension, {
      x: Math.floor(loc.x) + o.x,
      y: Math.floor(loc.y) + o.y,
      z: Math.floor(loc.z) + o.z,
    });
    if (isSolid(b)) count++;
  }
  return count;
}

/**
 * Score a candidate anchor, or return null to reject it.
 *
 * The ideal anchor is one the player cannot see *yet*: partially occluded, at
 * the edge of vision, so that a small turn of the head or one step forward is
 * what reveals it. Being revealed by the player's own movement is what makes
 * it feel like it was always there.
 */
function scoreAnchor(player, players, stand, targetRadius, tier, behindAllowed) {
  const dimension = player.dimension;
  const points = samplePoints(stand);
  const eye = player.getHeadLocation();

  // Cheap geometric rejections first. Roughly two thirds of sampled candidates
  // die on the cone test, and every one of those saves three raycasts per
  // nearby player — which is the difference between a comfortable budget and
  // a visible hitch on a busy server.
  const d = distXZ(stand, player.location);
  if (d < WATCHER.MIN_ABSOLUTE) return null;

  const cd = coneDot(player, points[0]);
  const behind = cd < 0.1;
  if (behind && !behindAllowed) return null;
  if (!behind && (cd < WATCHER.EDGE_DOT_MIN || cd > WATCHER.EDGE_DOT_MAX)) return null;

  // Only now pay for the raycasts. Nothing may be placed where anyone is
  // already looking.
  if (observedByAnyone(dimension, stand, players)) return null;

  const headClear = lineOfSight(dimension, eye, points[0], 80);
  const feetClear = lineOfSight(dimension, eye, points[2], 80);

  let score = 0;

  // Distance fidelity: the permitted radius is a promise, not a suggestion.
  score += 10 - Math.min(10, Math.abs(d - targetRadius) * 1.6);

  // Partial occlusion — head visible, body swallowed — is the money shot.
  if (headClear && !feetClear) score += 7;
  else if (!headClear && !feetClear) score += 3.5;

  // Higher tiers insist on cover.
  if (tier >= 2 && headClear && feetClear) return null;

  score += Math.min(4, framing(dimension, stand) * 0.9);

  // Standing in the dark beats standing in a field.
  if (!seesSky(dimension, stand)) score += 2.5;

  // At the edge of vision rather than the middle of it.
  if (!behind) score += (1 - Math.abs(cd - WATCHER.EDGE_DOT_MAX)) * 2;
  else score += 3 + tier * 0.5;

  return score;
}

function selectAnchor(player, players, tier) {
  const dimension = player.dimension;
  const targetRadius = permittedRadius(player, tier);
  const behindAllowed = Notice.get(player) >= WATCHER.BEHIND_THRESHOLD;
  const origin = player.location;

  let best = null;
  let bestScore = -Infinity;

  for (let i = 0; i < WATCHER.SAMPLES; i++) {
    const angle = rand(0, Math.PI * 2);
    const r = targetRadius + rand(-2, 2);
    const x = Math.floor(origin.x + Math.cos(angle) * r);
    const z = Math.floor(origin.z + Math.sin(angle) * r);

    const stand = findGround(dimension, x, z, origin.y);
    if (!stand) continue;

    const score = scoreAnchor(player, players, stand, targetRadius, tier, behindAllowed);
    if (score === null) continue;
    if (score > bestScore) {
      bestScore = score;
      best = stand;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Placement and removal
// ---------------------------------------------------------------------------

function place(player, players, state) {
  const anchor = selectAnchor(player, players, state.tier);
  if (!anchor) return false;

  let entity;
  try {
    entity = player.dimension.spawnEntity(WATCHER.ID, anchor);
  } catch {
    return false;
  }

  entity.setDynamicProperty(PROP.OWNER, player.id);
  entity.addTag("nx_watcher");
  faceOnce(entity, player);

  state.entityId = entity.id;
  state.placedAt = system.currentTick;
  state.stareTicks = 0;
  state.lastStareCredit = 0;
  state.seen = false;
  state.readyToLeave = false;
  return true;
}

/**
 * Turn to the player exactly once, at the moment of placement, and never
 * again. Continuous head tracking is the tell that separates "a thing that is
 * looking at you" from "a thing that is being animated at you".
 */
function faceOnce(entity, player) {
  try {
    const eye = player.getHeadLocation();
    entity.teleport(entity.location, {
      dimension: entity.dimension,
      facingLocation: v3(eye.x, entity.location.y + 2.4, eye.z),
      keepVelocity: false,
    });
  } catch {
    /* teleport can fail on an unloaded chunk; the pose simply stays as spawned */
  }
}

function vanish(state, entity, escalate) {
  try {
    entity?.remove();
  } catch {
    /* already gone */
  }
  const tier = escalate ? Math.min(state.tier + 1, WATCHER.MAX_STEALTH_TIER) : state.tier;
  state.entityId = undefined;
  state.tier = tier;
  state.stareTicks = 0;
  state.seen = false;
  state.readyToLeave = false;
  state.cooldownUntil = system.currentTick + WATCHER.COOLDOWN[tier];
}

// ---------------------------------------------------------------------------
// Relocation
// ---------------------------------------------------------------------------

function relocate(player, players, state, entity) {
  const anchor = selectAnchor(player, players, state.tier);
  if (!anchor) return false;

  // Last gate before motion: re-verify that the *current* position is unwatched.
  // selectAnchor proved the destination is safe; this proves the departure is.
  if (observedByAnyone(entity.dimension, entity.location, players)) return false;

  try {
    entity.teleport(anchor, { dimension: entity.dimension, keepVelocity: false });
  } catch {
    return false;
  }
  faceOnce(entity, player);
  state.placedAt = system.currentTick;
  return true;
}

// ---------------------------------------------------------------------------
// Per-player cycle
// ---------------------------------------------------------------------------

function cycle(player, players) {
  const state = stateFor(player);
  const now = system.currentTick;
  if (now < state.nextCycle) return;
  state.nextCycle = now + randInt(WATCHER.MIN_INTERVAL, WATCHER.MAX_INTERVAL);

  const notice = Notice.get(player);
  const entity = entityOf(state);

  if (!entity) {
    state.entityId = undefined;
    if (notice < WATCHER.THRESHOLD) return;
    if (now < state.cooldownUntil) return;
    if (!claimSearch()) {
      state.nextCycle = now + 5;
      return;
    }
    place(player, players, state);
    return;
  }

  // Fell out of the world, changed dimension, or drifted out of range.
  if (entity.dimension.id !== player.dimension.id || dist(entity.location, player.location) > 80) {
    if (!observedByAnyone(entity.dimension, entity.location, players)) vanish(state, entity, false);
    return;
  }

  const watcherObserved = observedByAnyone(entity.dimension, entity.location, players);
  const interval = WATCHER.MAX_INTERVAL;

  if (watcherObserved) {
    // Step 4 — freeze on sight. It does nothing. That is the whole behaviour.
    if (!state.seen) {
      state.seen = true;
      playSafe(watcherObserved, SFX.STARE, { location: entity.location, volume: 0.14, pitch: 0.55 });
    }
    try {
      entity.clearVelocity();
    } catch {
      /* clearVelocity is unavailable on some builds; physics is off anyway */
    }

    state.stareTicks += interval;

    // Step 5 — sustained observation feeds it.
    if (state.stareTicks - state.lastStareCredit >= WATCHER.STARE_PERIOD) {
      state.lastStareCredit = state.stareTicks;
      Notice.add(player, NOTICE.STARE_GAIN);
    }
    if (state.stareTicks >= WATCHER.STARE_LIMIT) state.readyToLeave = true;
    return;
  }

  // Unobserved frame. Everything that looks like movement happens here.
  state.seen = false;

  if (state.readyToLeave) {
    // You looked long enough. It has earned a better hiding place.
    vanish(state, entity, true);
    return;
  }

  const age = now - state.placedAt;
  if (age > WATCHER.LIFETIME[state.tier]) {
    vanish(state, entity, false);
    return;
  }

  if (notice < WATCHER.THRESHOLD * 0.6) {
    vanish(state, entity, false);
    return;
  }

  // Step 1-3 — pick an anchor at the permitted radius and teleport into it.
  if (!claimSearch()) {
    state.nextCycle = now + 5;
    return;
  }
  relocate(player, players, state, entity);
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

/**
 * Remove Watchers left behind by a reload or a crash. In-memory state does not
 * survive a world restart, so anything wearing the tag without a live owner in
 * `states` is an orphan.
 */
export function sweep() {
  const owned = new Set();
  for (const s of states.values()) if (s.entityId) owned.add(s.entityId);

  for (const dim of ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"]) {
    let found = [];
    try {
      found = world.getDimension(dim).getEntities({ type: WATCHER.ID });
    } catch {
      continue;
    }
    for (const e of found) {
      if (!owned.has(e.id)) {
        try {
          e.remove();
        } catch {
          /* nothing to do */
        }
      }
    }
  }
}

export function forget(playerId) {
  const state = states.get(playerId);
  if (state?.entityId) {
    try {
      world.getEntity(state.entityId)?.remove();
    } catch {
      /* nothing to do */
    }
  }
  states.delete(playerId);
}

export function stealthTier(player) {
  return states.get(player.id)?.tier ?? 0;
}

export function isPresent(player) {
  return Boolean(states.get(player.id)?.entityId);
}

export function isBeingSeen(player) {
  return Boolean(states.get(player.id)?.seen);
}

export function tick(players) {
  searchBudget = SEARCHES_PER_TICK;
  for (const player of players) {
    try {
      cycle(player, players);
    } catch {
      /* one player's bad tick must never stall the loop for everyone else */
    }
  }
}
