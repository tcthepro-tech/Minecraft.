import { world, system } from "@minecraft/server";
import { EVENTS, WATCHER, SFX } from "./config.js";
import * as Notice from "./notice.js";
import * as Watcher from "./watcher.js";
import {
  v3, clamp, lerp, rand, randInt, safeBlock, isSolid, isOpen,
  coneDot, playSafe, runSafe,
} from "./util.js";

/**
 * One-shot incidents.
 *
 * Everything else in the pack is a continuous curve. This is the layer that
 * punctuates it — rare, short, and never repeated twice running. Three rules
 * they all obey:
 *
 *   Nothing here damages the player. Not one of them.
 *   Nothing here is destructive; no event places or breaks a block.
 *   Nothing here announces the Watcher. An event that reliably preceded an
 *   appearance would teach the player to read the tells, and the moment the
 *   player can predict it, it stops working.
 *
 * Each event declares the notice band it lives in, so the incident vocabulary
 * grows as the curve does instead of everything being available at once.
 */

const nextEvent = new Map(); // playerId -> tick
const recent = new Map(); // playerId -> [event names]

function remember(playerId, name) {
  const list = recent.get(playerId) ?? [];
  list.push(name);
  while (list.length > EVENTS.NO_REPEAT) list.shift();
  recent.set(playerId, list);
}

/** A standable, currently unwatched spot near the player. */
function spotNear(player, min, max, behindOnly) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const angle = rand(0, Math.PI * 2);
    const r = rand(min, max);
    const x = Math.floor(player.location.x + Math.cos(angle) * r);
    const z = Math.floor(player.location.z + Math.sin(angle) * r);
    for (let dy = 2; dy >= -3; dy--) {
      const y = Math.floor(player.location.y) + dy;
      if (!isSolid(safeBlock(player.dimension, { x, y: y - 1, z }))) continue;
      if (!isOpen(safeBlock(player.dimension, { x, y, z }))) continue;
      const spot = v3(x + 0.5, y, z + 0.5);
      if (behindOnly && coneDot(player, v3(spot.x, spot.y + 1.6, spot.z)) > -0.2) continue;
      return spot;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The incidents
//
// Each returns true if it actually fired. Returning false puts the timer back
// on a short retry rather than burning the slot.
// ---------------------------------------------------------------------------

const INCIDENTS = [
  {
    name: "settle",
    min: 12,
    weight: 10,
    /** The cave shifts. The oldest trick there is, and it still works. */
    run(player) {
      const spot = spotNear(player, 6, 16, false) ?? player.location;
      const beats = randInt(2, 4);
      for (let i = 0; i < beats; i++) {
        system.runTimeout(() => {
          playSafe(player, SFX.SETTLE, {
            location: spot, volume: rand(0.3, 0.6), pitch: rand(0.35, 0.55),
          });
        }, i * randInt(4, 11));
      }
      return true;
    },
  },
  {
    name: "doorway",
    min: 20,
    weight: 8,
    /** A door opens and closes somewhere you have not built a door. */
    run(player) {
      const spot = spotNear(player, 8, 20, false) ?? player.location;
      playSafe(player, SFX.DOOR_OPEN, { location: spot, volume: 0.55, pitch: 0.7 });
      system.runTimeout(() => {
        playSafe(player, SFX.DOOR, { location: spot, volume: 0.6, pitch: 0.65 });
      }, randInt(26, 46));
      return true;
    },
  },
  {
    name: "rummage",
    min: 26,
    weight: 7,
    /** Something opens a container. There is no container. */
    run(player) {
      const spot = spotNear(player, 5, 13, true);
      if (!spot) return false;
      playSafe(player, SFX.CHEST_OPEN, { location: spot, volume: 0.5, pitch: 0.75 });
      system.runTimeout(() => {
        playSafe(player, SFX.CHEST_CLOSE, { location: spot, volume: 0.45, pitch: 0.7 });
      }, randInt(30, 55));
      return true;
    },
  },
  {
    name: "hush",
    min: 30,
    weight: 9,
    /**
     * The ambient bed cuts out completely for eight seconds. Silence is the
     * only effect in the pack that costs nothing to produce and works on
     * everybody.
     */
    run(player) {
      hushUntil.set(player.id, system.currentTick + 160);
      system.runTimeout(() => {
        playSafe(player, SFX.SETTLE, {
          location: player.location, volume: 0.75, pitch: 0.3,
        });
      }, 150);
      return true;
    },
  },
  {
    name: "breath",
    min: 36,
    weight: 8,
    /** Close, behind, and at the wrong pitch to be anything you know. */
    run(player) {
      const spot = spotNear(player, 2, 5, true);
      if (!spot) return false;
      playSafe(player, SFX.BREATH, { location: spot, volume: 0.7, pitch: rand(0.3, 0.45) });
      return true;
    },
  },
  {
    name: "shudder",
    min: 42,
    weight: 6,
    /** A tremor with no source. Vanilla camerashake, kept well under a jolt. */
    run(player) {
      runSafe(player, "camerashake add @s 0.055 1.4 positional");
      playSafe(player, SFX.SETTLE, { location: player.location, volume: 0.5, pitch: 0.28 });
      return true;
    },
  },
  {
    name: "guttering",
    min: 48,
    weight: 7,
    /**
     * Every light in the world goes out for three seconds. It does not
     * actually touch a single block — the Darkness effect does the whole job,
     * and the torches are still burning when it lifts.
     */
    run(player) {
      try {
        player.addEffect("darkness", 70, { amplifier: 0, showParticles: false });
      } catch {
        return false;
      }
      playSafe(player, SFX.GUTTER, { location: player.location, volume: 0.55, pitch: 0.8 });
      return true;
    },
  },
  {
    name: "namecall",
    min: 55,
    weight: 5,
    /** Your own name, in the colour the pack uses for things it will not explain. */
    run(player) {
      try {
        player.onScreenDisplay.setActionBar(`§8${player.name}`);
      } catch {
        return false;
      }
      playSafe(player, SFX.LISTEN, { location: player.location, volume: 0.3, pitch: 0.5 });
      return true;
    },
  },
  {
    name: "closer",
    min: 60,
    weight: 6,
    /**
     * The Watcher is permitted, for this one cycle, to stand at the very floor
     * of its range. It still may not be seen arriving — the relocation goes
     * through the same unobserved check as every other one.
     */
    run(player) {
      if (!Watcher.isPresent(player)) return false;
      return Watcher.forceClose(player);
    },
  },
  {
    name: "gape",
    min: 72,
    weight: 5,
    /** If it is in front of you right now, it opens its mouth. Silently. */
    run(player) {
      if (!Watcher.isBeingSeen(player)) return false;
      return Watcher.forceMaw(player);
    },
  },
  {
    name: "chorus",
    min: 84,
    weight: 4,
    /**
     * Three more, placed in a ring, all unobserved, all gone inside eight
     * seconds. The player is not meant to see them arrive or leave — only to
     * turn around at the wrong moment and understand that the count was never
     * one.
     */
    run(player) {
      const spots = [];
      for (let i = 0; i < 3; i++) {
        const spot = spotNear(player, 9, 18, true);
        if (spot) spots.push(spot);
      }
      if (spots.length === 0) return false;

      const spawned = [];
      for (const spot of spots) {
        if (Watcher.observedByAnyone(player.dimension, spot, world.getAllPlayers())) continue;
        try {
          const e = player.dimension.spawnEntity(WATCHER.ID, spot);
          e.addTag("nx_chorus");
          spawned.push(e);
        } catch {
          /* skip this one */
        }
      }
      if (spawned.length === 0) return false;

      system.runTimeout(() => {
        for (const e of spawned) {
          try {
            e.remove();
          } catch {
            /* already gone */
          }
        }
      }, randInt(120, 200));
      return true;
    },
  },
];

/** Players whose ambient bed is currently suppressed by a `hush`. */
export const hushUntil = new Map();

export function isHushed(player) {
  const until = hushUntil.get(player.id);
  return typeof until === "number" && until > system.currentTick;
}

// ---------------------------------------------------------------------------

function choose(player) {
  const notice = Notice.get(player);
  const skip = recent.get(player.id) ?? [];
  const pool = INCIDENTS.filter((i) => notice >= i.min && !skip.includes(i.name));
  if (pool.length === 0) return undefined;

  const total = pool.reduce((sum, i) => sum + i.weight, 0);
  let roll = Math.random() * total;
  for (const incident of pool) {
    roll -= incident.weight;
    if (roll <= 0) return incident;
  }
  return pool[pool.length - 1];
}

function update(player) {
  const notice = Notice.get(player);
  if (notice < EVENTS.THRESHOLD) return;

  const now = system.currentTick;
  const due = nextEvent.get(player.id) ?? now + randInt(600, 1800);
  if (now < due) {
    nextEvent.set(player.id, due);
    return;
  }

  const pressure = clamp(notice / 100, 0, 1);
  const period = lerp(EVENTS.MAX_PERIOD, EVENTS.MIN_PERIOD, pressure) * 20;

  const incident = choose(player);
  if (!incident || !incident.run(player)) {
    // Nothing suitable; retry soon rather than burning the whole interval.
    nextEvent.set(player.id, now + randInt(100, 300));
    return;
  }

  remember(player.id, incident.name);
  nextEvent.set(player.id, now + period * rand(0.65, 1.5));
}

export function tick(players) {
  for (const player of players) {
    try {
      update(player);
    } catch {
      /* an incident that throws is simply an incident that did not happen */
    }
  }
}

export function forget(playerId) {
  nextEvent.delete(playerId);
  recent.delete(playerId);
  hushUntil.delete(playerId);
}

/** Clear chorus Watchers orphaned by a reload. */
export function sweep() {
  for (const dim of ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"]) {
    try {
      for (const e of world.getDimension(dim).getEntities({ tags: ["nx_chorus"] })) e.remove();
    } catch {
      /* dimension not loaded */
    }
  }
}
