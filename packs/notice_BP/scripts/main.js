import { world, system } from "@minecraft/server";
import { NOTICE } from "./config.js";
import * as Notice from "./notice.js";
import * as Watcher from "./watcher.js";
import * as Support from "./support.js";
import * as Atmosphere from "./atmosphere.js";
import * as Structures from "./structures.js";
import * as Counterplay from "./counterplay.js";

/**
 * Notice — wiring.
 *
 * Two loops. The slow one, once a second, is the model: it moves the number
 * and lets every subsystem read it. The fast one exists only so the heartbeat
 * can keep time, because a heartbeat quantised to one second sounds like a
 * metronome instead of a pulse.
 *
 * The Watcher runs on its own randomised 20-40 tick cadence per player, driven
 * from the slow loop but gated internally, so no two players ever share a
 * relocation frame.
 */

let booted = false;

function boot() {
  if (booted) return;
  booted = true;

  // Anything left over from a reload has no owner and must not persist.
  Watcher.sweep();
  Support.sweep();

  for (const player of world.getAllPlayers()) Notice.ensure(player);
}

system.run(boot);

// --- Slow loop: the model ---------------------------------------------------

system.runInterval(() => {
  const players = world.getAllPlayers();
  if (players.length === 0) return;

  for (const player of players) {
    try {
      Notice.ensure(player);
      const env = Notice.evaluate(player, players);
      Atmosphere.tick(player, env);
    } catch {
      /* a single player's failed evaluation must not stop the world */
    }
  }

  Watcher.tick(players);
  Support.tick(players);
  Structures.tick(players);
}, NOTICE.EVAL_INTERVAL);

// --- Fast loop: perception only ---------------------------------------------

system.runInterval(() => {
  const players = world.getAllPlayers();
  if (players.length > 0) Atmosphere.fastTick(players);
}, 1);

// --- Events -----------------------------------------------------------------

world.afterEvents.playerSpawn.subscribe((event) => {
  Notice.ensure(event.player);
  if (!event.initialSpawn) {
    // Respawning after death: the charge releases, the floor does not.
    Notice.onDeath(event.player);
  }
});

world.afterEvents.playerLeave.subscribe((event) => {
  Notice.forgetLightScan(event.playerId);
  Watcher.forget(event.playerId);
  Support.forget(event.playerId);
  Structures.forget(event.playerId);
  Atmosphere.forget(event.playerId);
});

world.afterEvents.playerBreakBlock.subscribe((event) => {
  try {
    Structures.onBreak(event);
  } catch {
    /* ignore */
  }
});

world.afterEvents.playerInteractWithBlock.subscribe((event) => {
  try {
    Structures.onInteract(event);
  } catch {
    /* ignore */
  }
});

world.afterEvents.itemUse.subscribe((event) => {
  try {
    Counterplay.onItemUse(event);
  } catch {
    /* ignore */
  }
});

system.afterEvents.scriptEventReceive.subscribe((event) => {
  try {
    Counterplay.onScriptEvent(event);
  } catch {
    /* ignore */
  }
});
