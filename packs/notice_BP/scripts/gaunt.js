import { world, system } from "@minecraft/server";
import { GAUNT, SFX } from "./config.js";
import * as Notice from "./notice.js";
import {
  v3, distXZ, norm, sub, rand,
  safeBlock, isSolid, isOpen, canSee, seesSky, playSafe, setProp,
} from "./util.js";

/**
 * The Gaunt.
 *
 * The Watcher's geometry at three times the scale — ten blocks of the same
 * species, walking the horizon. It is the payoff for surviving to the top of
 * the curve, and the one thing in the pack that is unambiguously animated.
 *
 * It never approaches. Its heading is always tangential to the player, and the
 * distance floor is enforced every tick, so the shape you are watching cross
 * the treeline is a shape that cannot arrive. That is what makes it bearable
 * to look at, and what makes it worse.
 *
 * If you keep watching, it stops walking and turns to face you.
 */

const state = new Map(); // playerId -> record
const nextTry = new Map(); // playerId -> tick

function alive(entity) {
  if (!entity) return false;
  const v = entity.isValid;
  return typeof v === "function" ? v.call(entity) : v !== false;
}

function entityOf(record) {
  if (!record?.entityId) return undefined;
  try {
    const e = world.getEntity(record.entityId);
    return alive(e) ? e : undefined;
  } catch {
    return undefined;
  }
}

/** Surface height at a column, or undefined if nothing will hold it up. */
function groundAt(dimension, x, z, near) {
  try {
    const top = dimension.getTopmostBlock({ x, z });
    if (top && Math.abs(top.location.y - near) < 40) return top.location.y + 1;
  } catch {
    /* fall through to the manual scan */
  }
  for (let y = Math.floor(near) + 14; y > Math.floor(near) - 20; y--) {
    if (isSolid(safeBlock(dimension, { x, y: y - 1, z })) && isOpen(safeBlock(dimension, { x, y, z }))) {
      return y;
    }
  }
  return undefined;
}

function findSpawn(player) {
  const origin = player.location;
  for (let attempt = 0; attempt < 12; attempt++) {
    const angle = rand(0, Math.PI * 2);
    const r = rand(GAUNT.SPAWN_DISTANCE[0], GAUNT.SPAWN_DISTANCE[1]);
    const x = Math.floor(origin.x + Math.cos(angle) * r);
    const z = Math.floor(origin.z + Math.sin(angle) * r);
    const y = groundAt(player.dimension, x, z, origin.y);
    if (y === undefined) continue;
    // It has to be standing in the open, or it is just a shape inside a hill.
    if (!seesSky(player.dimension, v3(x + 0.5, y + 6, z + 0.5))) continue;
    return v3(x + 0.5, y, z + 0.5);
  }
  return undefined;
}

function spawn(player) {
  const spot = findSpawn(player);
  if (!spot) return;

  let entity;
  try {
    entity = player.dimension.spawnEntity(GAUNT.ID, spot);
  } catch {
    return;
  }
  entity.addTag("nx_gaunt");
  setProp(entity, "nx:walking", true);

  // Heading perpendicular to the player: it crosses your view, never closes.
  const away = norm(sub(spot, player.location));
  const sign = Math.random() < 0.5 ? 1 : -1;
  const heading = { x: -away.z * sign, y: 0, z: away.x * sign };

  state.set(player.id, {
    entityId: entity.id,
    born: system.currentTick,
    heading,
    stareTicks: 0,
    halted: false,
    lastStep: system.currentTick,
  });

  // One enormous, distant call. Nothing else in the pack reaches this low.
  playSafe(player, SFX.FAR, { location: spot, volume: 1.0, pitch: 1.0 });
}

/**
 * Advance one step. Called every tick so the walk reads as motion rather than
 * as a series of jumps — at this scale, teleporting a tenth of a block per
 * tick is indistinguishable from walking.
 */
function stride(player, record, entity) {
  const here = entity.location;
  const speed = GAUNT.SPEED / 20;

  let next = {
    x: here.x + record.heading.x * speed,
    y: here.y,
    z: here.z + record.heading.z * speed,
  };

  // Hard distance floor. If the stride would close on the player, curve away.
  const closing = distXZ(next, player.location) < GAUNT.MIN_DISTANCE;
  if (closing) {
    const away = norm(sub(here, player.location));
    record.heading = norm({
      x: record.heading.x * 0.55 + away.x * 0.75,
      y: 0,
      z: record.heading.z * 0.55 + away.z * 0.75,
    });
    next = {
      x: here.x + record.heading.x * speed,
      y: here.y,
      z: here.z + record.heading.z * speed,
    };
  }

  // Follow the terrain, but only over gentle ground — it should not climb
  // cliffs or wade into a ravine.
  const ground = groundAt(entity.dimension, Math.floor(next.x), Math.floor(next.z), here.y);
  if (ground === undefined || Math.abs(ground - here.y) > 3) {
    // Turn rather than scramble.
    const turn = rand(0.6, 1.4) * (Math.random() < 0.5 ? 1 : -1);
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    record.heading = {
      x: record.heading.x * cos - record.heading.z * sin,
      y: 0,
      z: record.heading.x * sin + record.heading.z * cos,
    };
    return;
  }
  next.y = ground;

  // A footfall every half stride. The walk animation is 3.6 seconds a cycle,
  // so 36 ticks puts the sound under each hoof as it lands.
  if (system.currentTick - record.lastStep >= 36) {
    record.lastStep = system.currentTick;
    playSafe(player, SFX.FAR_STEP, {
      location: here, volume: 0.9, pitch: rand(0.94, 1.06),
    });
  }

  try {
    entity.teleport(next, {
      dimension: entity.dimension,
      facingLocation: {
        x: next.x + record.heading.x * 10,
        y: next.y + 6,
        z: next.z + record.heading.z * 10,
      },
      keepVelocity: false,
    });
  } catch {
    /* unloaded chunk; it will try again next tick */
  }
}

/** It stops, and turns, and that is all it ever does about you. */
function halt(player, record, entity) {
  record.halted = true;
  setProp(entity, "nx:walking", false);
  try {
    const eye = player.getHeadLocation();
    entity.teleport(entity.location, {
      dimension: entity.dimension,
      facingLocation: v3(eye.x, entity.location.y + 8, eye.z),
      keepVelocity: false,
    });
  } catch {
    /* pose stays as it was */
  }
  playSafe(player, SFX.FAR, { location: entity.location, volume: 0.85, pitch: 0.85 });
  Notice.add(player, GAUNT.STARE_GAIN);
}

function despawn(player, record, entity) {
  try {
    entity?.remove();
  } catch {
    /* already gone */
  }
  state.delete(player.id);
  nextTry.set(player.id, system.currentTick + GAUNT.COOLDOWN);
}

function update(player) {
  const record = state.get(player.id);
  const now = system.currentTick;

  if (!record) {
    if (Notice.get(player) < GAUNT.THRESHOLD) return;
    if (!seesSky(player.dimension, player.location)) return;
    const due = nextTry.get(player.id) ?? now + GAUNT.PERIOD;
    if (now < due) {
      nextTry.set(player.id, due);
      return;
    }
    nextTry.set(player.id, now + GAUNT.PERIOD * rand(0.7, 1.4));
    if (Math.random() < GAUNT.CHANCE) spawn(player);
    return;
  }

  const entity = entityOf(record);
  if (!entity) {
    state.delete(player.id);
    return;
  }

  if (
    now - record.born > GAUNT.LIFETIME ||
    entity.dimension.id !== player.dimension.id ||
    distXZ(entity.location, player.location) > GAUNT.DESPAWN_DISTANCE
  ) {
    despawn(player, record, entity);
    return;
  }

  const watched = canSee(player, v3(entity.location.x, entity.location.y + 14, entity.location.z),
    GAUNT.OBSERVE_DOT, GAUNT.DESPAWN_DISTANCE);

  if (record.halted) {
    // Once halted it is finished. It leaves the moment nobody is looking.
    if (!watched) despawn(player, record, entity);
    return;
  }

  if (watched) {
    record.stareTicks++;
    if (record.stareTicks >= GAUNT.STARE_LIMIT) {
      halt(player, record, entity);
      return;
    }
  } else {
    record.stareTicks = Math.max(0, record.stareTicks - 1);
  }

  stride(player, record, entity);
}

export function tick(players) {
  for (const player of players) {
    try {
      update(player);
    } catch {
      /* the Gaunt is scenery; never let it break the model */
    }
  }
}

export function forget(playerId) {
  const record = state.get(playerId);
  if (record) {
    try {
      world.getEntity(record.entityId)?.remove();
    } catch {
      /* already gone */
    }
  }
  state.delete(playerId);
  nextTry.delete(playerId);
}

export function sweep() {
  for (const dim of ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"]) {
    try {
      for (const e of world.getDimension(dim).getEntities({ type: GAUNT.ID })) e.remove();
    } catch {
      /* dimension not loaded */
    }
  }
}

/** Diagnostic entry point: spawn one immediately, bypassing every gate. */
export function summonNear(player) {
  spawn(player);
  const record = state.get(player.id);
  if (!record) return undefined;
  const entity = entityOf(record);
  return entity ? entity.location : undefined;
}

export function isPresent(player) {
  return Boolean(state.get(player.id));
}
