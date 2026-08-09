import { world, system } from "@minecraft/server";
import { HOLLOW, KINDLER, NOTICE, PROP, SFX } from "./config.js";
import * as Notice from "./notice.js";
import {
  v3, dist, clamp, lerp, rand, randInt, pick,
  safeBlock, isSolid, isOpen, coneDot, playSafe,
} from "./util.js";
import { observedByAnyone } from "./watcher.js";

/**
 * The supporting pair.
 *
 * Neither of them is a monster and neither of them has its own escalation
 * curve — both read `notice` and nothing else. The Hollow applies pressure by
 * making the world sound occupied; the Kindler is the release valve. A horror
 * mechanic with no valve stops being frightening and becomes weather.
 */

const hollowNext = new Map(); // playerId -> tick
const kindlerNext = new Map(); // playerId -> tick
const kindlers = new Map(); // playerId -> { entityId, born, lastDist }

// ---------------------------------------------------------------------------
// The Hollow — occupied space
// ---------------------------------------------------------------------------

/**
 * An invisible, collisionless marker that exists for three and a half seconds,
 * makes one small sound from a position you are not looking at, and deletes
 * itself. There is nothing to find when you turn around, which is the point:
 * the player supplies the figure.
 */
function hollowPeriod(player) {
  const p = Notice.pressure(player);
  return lerp(HOLLOW.BASE_PERIOD, HOLLOW.MIN_PERIOD, p) * 20;
}

function findFootingBehind(player) {
  const origin = player.location;
  for (let attempt = 0; attempt < 10; attempt++) {
    const angle = rand(0, Math.PI * 2);
    const r = rand(HOLLOW.DISTANCE[0], HOLLOW.DISTANCE[1]);
    const x = Math.floor(origin.x + Math.cos(angle) * r);
    const z = Math.floor(origin.z + Math.sin(angle) * r);

    for (let dy = 2; dy >= -3; dy--) {
      const y = Math.floor(origin.y) + dy;
      const floor = safeBlock(player.dimension, { x, y: y - 1, z });
      const feet = safeBlock(player.dimension, { x, y, z });
      const head = safeBlock(player.dimension, { x, y: y + 1, z });
      if (!isSolid(floor) || !isOpen(feet) || !isOpen(head)) continue;

      const spot = v3(x + 0.5, y, z + 0.5);
      // Strictly behind, and strictly unwatched — by anyone.
      if (coneDot(player, v3(spot.x, spot.y + 1.6, spot.z)) > -0.25) continue;
      return spot;
    }
  }
  return undefined;
}

function tickHollow(player, players) {
  const notice = Notice.get(player);
  if (notice < HOLLOW.THRESHOLD) return;

  const now = system.currentTick;
  const due = hollowNext.get(player.id) ?? now + randInt(200, 600);
  if (now < due) {
    hollowNext.set(player.id, due);
    return;
  }
  hollowNext.set(player.id, now + hollowPeriod(player) * rand(0.7, 1.35));

  const spot = findFootingBehind(player);
  if (!spot) return;
  if (observedByAnyone(player.dimension, spot, players)) return;

  let entity;
  try {
    entity = player.dimension.spawnEntity(HOLLOW.ID, spot);
  } catch {
    return;
  }
  entity.addTag("nx_hollow");

  const pressure = Notice.pressure(player);
  const sound = pick([SFX.STEP, SFX.SETTLE, SFX.DOOR, SFX.STEP]);
  playSafe(player, sound, {
    location: spot,
    volume: clamp(0.25 + pressure * 0.5, 0.2, 0.8),
    pitch: rand(0.55, 0.8),
  });

  // A second, quieter beat a moment later reads as a stride rather than a knock.
  if (Math.random() < 0.45 + pressure * 0.3) {
    system.runTimeout(() => {
      playSafe(player, SFX.STEP, {
        location: spot,
        volume: clamp(0.2 + pressure * 0.4, 0.15, 0.7),
        pitch: rand(0.5, 0.75),
      });
    }, randInt(9, 16));
  }

  system.runTimeout(() => {
    try {
      entity.remove();
    } catch {
      /* already unloaded */
    }
  }, HOLLOW.LIFETIME);
}

// ---------------------------------------------------------------------------
// The Kindler — the valve
// ---------------------------------------------------------------------------

/**
 * A small, still flame on a figure that never approaches and never speaks.
 * Standing near it burns notice off far faster than daylight does, so at high
 * pressure it is the only practical way down — but it guts out if you rush it,
 * which turns relief into something you have to approach carefully.
 */
function findKindlerSpot(player) {
  const origin = player.location;
  for (let attempt = 0; attempt < 14; attempt++) {
    const angle = rand(0, Math.PI * 2);
    const r = rand(KINDLER.SPAWN_DISTANCE[0], KINDLER.SPAWN_DISTANCE[1]);
    const x = Math.floor(origin.x + Math.cos(angle) * r);
    const z = Math.floor(origin.z + Math.sin(angle) * r);

    for (let dy = 4; dy >= -6; dy--) {
      const y = Math.floor(origin.y) + dy;
      const floor = safeBlock(player.dimension, { x, y: y - 1, z });
      const feet = safeBlock(player.dimension, { x, y, z });
      const head = safeBlock(player.dimension, { x, y: y + 1, z });
      if (isSolid(floor) && isOpen(feet) && isOpen(head)) return v3(x + 0.5, y, z + 0.5);
    }
  }
  return undefined;
}

function spawnKindler(player) {
  const spot = findKindlerSpot(player);
  if (!spot) return;

  let entity;
  try {
    entity = player.dimension.spawnEntity(KINDLER.ID, spot);
  } catch {
    return;
  }
  entity.setDynamicProperty(PROP.OWNER, player.id);
  entity.addTag("nx_kindler");

  kindlers.set(player.id, {
    entityId: entity.id,
    born: system.currentTick,
    lastDist: dist(player.location, spot),
  });

  playSafe(player, SFX.KINDLE, { location: spot, volume: 0.5, pitch: 1.4 });
}

function gutter(player, record, entity) {
  playSafe(player, SFX.GUTTER, {
    location: entity?.location ?? player.location,
    volume: 0.7,
    pitch: 0.9,
  });
  try {
    entity?.remove();
  } catch {
    /* already gone */
  }
  kindlers.delete(player.id);
  // Losing the light costs you a little of the ground you just gained.
  Notice.add(player, 2.5);
}

function tickKindler(player) {
  const now = system.currentTick;
  const record = kindlers.get(player.id);

  if (record) {
    let entity;
    try {
      entity = world.getEntity(record.entityId);
    } catch {
      entity = undefined;
    }
    if (!entity) {
      kindlers.delete(player.id);
      return;
    }

    if (now - record.born > KINDLER.LIFETIME || entity.dimension.id !== player.dimension.id) {
      try {
        entity.remove();
      } catch {
        /* already gone */
      }
      kindlers.delete(player.id);
      return;
    }

    const d = dist(player.location, entity.location);
    const closing = (record.lastDist - d) * (20 / NOTICE.EVAL_INTERVAL);
    record.lastDist = d;

    if (d <= KINDLER.COMFORT_RADIUS) {
      if (closing > KINDLER.STARTLE_SPEED) {
        gutter(player, record, entity);
        return;
      }
      // The valve. Deliberately stronger than daylight.
      const before = Notice.get(player);
      const floor = Notice.getFloor(player);
      const eased = Math.max(floor, before - KINDLER.COMFORT_DECAY);
      Notice.add(player, eased - before);

      if (Math.random() < 0.12) {
        playSafe(player, SFX.KINDLE, { location: entity.location, volume: 0.3, pitch: 1.7 });
      }
    }
    return;
  }

  if (Notice.get(player) < KINDLER.THRESHOLD) return;
  const due = kindlerNext.get(player.id) ?? now + KINDLER.PERIOD * 20;
  if (now < due) {
    kindlerNext.set(player.id, due);
    return;
  }
  kindlerNext.set(player.id, now + KINDLER.PERIOD * 20 * rand(0.75, 1.3));
  spawnKindler(player);
}

// ---------------------------------------------------------------------------

export function tick(players) {
  for (const player of players) {
    try {
      tickHollow(player, players);
      tickKindler(player);
    } catch {
      /* never let a support entity break the notice loop */
    }
  }
}

export function forget(playerId) {
  const record = kindlers.get(playerId);
  if (record) {
    try {
      world.getEntity(record.entityId)?.remove();
    } catch {
      /* already gone */
    }
  }
  kindlers.delete(playerId);
  hollowNext.delete(playerId);
  kindlerNext.delete(playerId);
}

/** Clear support entities orphaned by a reload. */
export function sweep() {
  for (const dim of ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"]) {
    for (const id of [HOLLOW.ID, KINDLER.ID]) {
      try {
        for (const e of world.getDimension(dim).getEntities({ type: id })) e.remove();
      } catch {
        /* dimension not loaded */
      }
    }
  }
}
