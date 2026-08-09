import { system } from "@minecraft/server";
import { NOTICE, WATCHER, GAUNT, SFX } from "./config.js";
import * as Notice from "./notice.js";
import * as Watcher from "./watcher.js";
import * as Gaunt from "./gaunt.js";
import { v3, norm, add, scale, safeBlock, isSolid, isOpen, playSafe, setProp } from "./util.js";

/**
 * In-game commands, all through `/scriptevent nx:<name>`.
 *
 * These exist because of a real failure. The pack is a slow burn — first
 * contact is minutes of unbroken dark solitude — and a player who installs it,
 * spawns in daylight and looks around sees precisely nothing. That is
 * indistinguishable from a pack that failed to load, and "did it install?" is
 * not a question the player should have to answer by waiting five minutes in a
 * hole.
 *
 * So: a summon that puts the thing in front of you immediately, an audio test
 * that proves the resource pack is attached, and a readout of the hidden
 * number. None of them are needed to play. All of them are needed to debug.
 */

const HELP = [
  "§7--- §fNotice§7 ---",
  "§f/scriptevent nx:here §7- put the Watcher in front of you, now",
  "§f/scriptevent nx:gaunt §7- summon the Gaunt (needs open sky)",
  "§f/scriptevent nx:sounds §7- play every custom sound in order",
  "§f/scriptevent nx:state §7- show the hidden number",
  "§f/scriptevent nx:set 70 §7- force notice to a value",
  "§f/scriptevent nx:intensity 3 §7- accrual multiplier (default 1.6)",
  "§f/scriptevent nx:clear §7- remove everything the pack has spawned",
];

/** Find somewhere in front of the player that a three-block figure can stand. */
function spotInFront(player, distance) {
  const eye = player.getHeadLocation();
  const dir = player.getViewDirection();
  const flat = norm(v3(dir.x, 0, dir.z));

  for (const d of [distance, distance - 2, distance + 3, distance - 4, 5]) {
    if (d < 3) continue;
    const target = add(eye, scale(flat, d));
    const x = Math.floor(target.x);
    const z = Math.floor(target.z);
    for (let dy = 3; dy >= -4; dy--) {
      const y = Math.floor(player.location.y) + dy;
      if (!isSolid(safeBlock(player.dimension, { x, y: y - 1, z }))) continue;
      if (!isOpen(safeBlock(player.dimension, { x, y, z }))) continue;
      if (!isOpen(safeBlock(player.dimension, { x, y: y + 1, z }))) continue;
      if (!isOpen(safeBlock(player.dimension, { x, y: y + 2, z }))) continue;
      return v3(x + 0.5, y, z + 0.5);
    }
  }
  return undefined;
}

function summonWatcher(player) {
  // Clear the player's existing instance first — one per player still holds.
  Watcher.forget(player.id);

  const spot = spotInFront(player, 9);
  if (!spot) {
    player.sendMessage("§7No room in front of you. Face somewhere more open.");
    return;
  }

  let entity;
  try {
    entity = player.dimension.spawnEntity(WATCHER.ID, spot);
  } catch (err) {
    player.sendMessage(`§cCould not spawn ${WATCHER.ID}: ${err}`);
    return;
  }

  entity.addTag("nx_summoned");
  try {
    const eye = player.getHeadLocation();
    entity.teleport(entity.location, {
      dimension: entity.dimension,
      facingLocation: v3(eye.x, entity.location.y + 2.4, eye.z),
      keepVelocity: false,
    });
  } catch {
    /* pose stays as spawned */
  }

  playSafe(player, SFX.STARE, { location: spot, volume: 0.9, pitch: 1.0 });
  player.sendMessage(
    "§7It is standing in front of you. §8Summoned instances stay put and do " +
      "not hide — this is a viewer, not the real behaviour."
  );

  // Open the maw a few seconds in, so the animation is visible on demand too.
  system.runTimeout(() => {
    setProp(entity, "nx:maw", true);
    playSafe(player, SFX.MAW, { location: entity.location, volume: 0.9, pitch: 1.0 });
  }, 70);
}

function summonGaunt(player) {
  Gaunt.forget(player.id);
  const spot = Gaunt.summonNear(player);
  if (!spot) {
    player.sendMessage("§7Nowhere open enough. The Gaunt needs sky and a clear horizon.");
    return;
  }
  player.sendMessage("§7Look up, and out. It is about sixty blocks away.");
}

/**
 * Play every custom sound in sequence, named as it goes. If these are silent
 * the resource pack is not attached, which is a completely different problem
 * from the behaviour pack not running.
 */
function testSounds(player) {
  const list = [
    ["nx.drone", "drone"],
    ["nx.breath", "breath"],
    ["nx.whisper", "whisper"],
    ["nx.stare", "stare"],
    ["nx.maw", "maw"],
    ["nx.gaunt_call", "the Gaunt's call"],
    ["nx.far_step", "a far step"],
    ["nx.scrape", "scrape"],
    ["nx.heart", "heartbeat"],
    ["nx.knock", "knock"],
    ["nx.chorus", "chorus"],
    ["nx.vanish", "vanish"],
    ["nx.listen", "listen"],
  ];
  player.sendMessage(`§7Playing ${list.length} sounds. If you hear nothing at all, the resource pack is not applied.`);
  list.forEach(([id, label], i) => {
    system.runTimeout(() => {
      try {
        player.onScreenDisplay.setActionBar(`§8${id} §7- ${label}`);
      } catch {
        /* ignore */
      }
      playSafe(player, id, { location: player.location, volume: 1.0, pitch: 1.0 });
    }, i * 60);
  });
}

function clearAll(player) {
  Watcher.forget(player.id);
  Gaunt.forget(player.id);
  Watcher.sweep();
  Gaunt.sweep();
  let removed = 0;
  for (const id of ["nx:watcher", "nx:gaunt", "nx:kindler", "nx:hollow"]) {
    try {
      for (const e of player.dimension.getEntities({ type: id })) {
        e.remove();
        removed++;
      }
    } catch {
      /* ignore */
    }
  }
  player.sendMessage(`§7Removed ${removed}.`);
}

function state(player) {
  const n = Notice.get(player);
  const r = Watcher.permittedRadius(player, Watcher.stealthTier(player));
  player.sendMessage(
    `§7notice §f${n.toFixed(1)}§7/${NOTICE.MAX}   floor §f${Notice.getFloor(player).toFixed(1)}` +
      `   band §f${Notice.tierIndex(player)}   stealth §f${Watcher.stealthTier(player)}`
  );
  player.sendMessage(
    `§7permitted §f${r.toFixed(1)}m§7   watcher §f${Watcher.isPresent(player) ? "present" : "absent"}` +
      `   gaunt §f${Gaunt.isPresent(player) ? "present" : "absent"}` +
      `   intensity §f${Notice.intensity()}x`
  );
  const need = [];
  if (n < WATCHER.THRESHOLD) need.push(`§7Watcher needs §f${WATCHER.THRESHOLD}`);
  if (n < GAUNT.THRESHOLD) need.push(`§7Gaunt needs §f${GAUNT.THRESHOLD}§7 and open sky`);
  if (need.length) player.sendMessage(need.join("§7,   "));
}

export function onScriptEvent(event) {
  const player = event.sourceEntity;
  if (!player || typeof player.sendMessage !== "function") return;

  const arg = (event.message ?? "").trim();

  switch (event.id) {
    case "nx:help":
      for (const line of HELP) player.sendMessage(line);
      break;

    case "nx:here":
      summonWatcher(player);
      break;

    case "nx:gaunt":
      summonGaunt(player);
      break;

    case "nx:sounds":
      testSounds(player);
      break;

    case "nx:state":
      state(player);
      break;

    case "nx:clear":
      clearAll(player);
      break;

    case "nx:set": {
      const value = Number.parseFloat(arg);
      if (!Number.isFinite(value)) {
        player.sendMessage("§7Usage: /scriptevent nx:set 70");
        break;
      }
      Notice.force(player, value);
      player.sendMessage(`§7notice set to §f${Notice.get(player).toFixed(1)}`);
      break;
    }

    case "nx:intensity": {
      const value = Number.parseFloat(arg);
      if (!Number.isFinite(value) || value <= 0) {
        player.sendMessage(`§7Usage: /scriptevent nx:intensity 3   §8(currently ${Notice.intensity()}x)`);
        break;
      }
      Notice.setIntensity(value);
      player.sendMessage(`§7Accrual multiplier is now §f${Notice.intensity()}x§7 for this world.`);
      break;
    }

    default:
      break;
  }
}

/**
 * One line, once per join. It breaks the fiction slightly, and it is worth it:
 * without it there is no way to distinguish "installed and waiting" from
 * "silently failed to load".
 */
export function greet(player) {
  system.runTimeout(() => {
    try {
      player.sendMessage(
        "§8Notice is active. Nothing will happen for a while — that is the point. " +
          "§7/scriptevent nx:help§8 if you want to look at it now."
      );
    } catch {
      /* ignore */
    }
  }, 60);
}
