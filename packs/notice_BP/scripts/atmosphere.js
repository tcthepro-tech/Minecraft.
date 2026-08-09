import { system } from "@minecraft/server";
import { FOG, SFX, NOTICE } from "./config.js";
import * as Notice from "./notice.js";
import * as Watcher from "./watcher.js";
import { isHushed } from "./events.js";
import { clamp, lerp, rand, pick, playSafe, runSafe } from "./util.js";

/**
 * Everything the player actually perceives, derived entirely from `notice`.
 *
 * No cue here is ever tied to the Watcher's arrival. A sting on spawn would
 * teach the player that silence means safety, and the pack would collapse into
 * a jumpscare generator. The audio tracks the number, not the entity.
 */

const fogTier = new Map(); // playerId -> tier currently pushed
const nextAmbient = new Map(); // playerId -> tick
const nextHeart = new Map(); // playerId -> tick

function applyFog(player) {
  const tier = Notice.tierIndex(player);
  if (fogTier.get(player.id) === tier) return;

  runSafe(player, `fog @s remove ${FOG.LAYER}`);
  const id = FOG.IDS[tier];
  if (id) runSafe(player, `fog @s push ${id} ${FOG.LAYER}`);
  fogTier.set(player.id, tier);
}

export function clearFog(player) {
  runSafe(player, `fog @s remove ${FOG.LAYER}`);
  fogTier.delete(player.id);
}

/**
 * Sparse, quiet, and never on a fixed beat. The interval shortens with notice
 * so the world grows busier without any single sound getting louder.
 */
function ambient(player, env) {
  const now = system.currentTick;
  const p = Notice.pressure(player);
  const due = nextAmbient.get(player.id) ?? now + rand(200, 700);
  if (now < due) {
    nextAmbient.set(player.id, due);
    return;
  }
  nextAmbient.set(player.id, now + lerp(900, 160, p) * rand(0.6, 1.5));

  if (Notice.get(player) < 10) return;
  if (env.daylight && Math.random() < 0.8) return;
  // A `hush` incident is in progress: the bed stays out until it lifts.
  if (isHushed(player)) return;

  const palette = [SFX.CAVE, SFX.CAVE, SFX.SETTLE];
  if (p > 0.35) palette.push(SFX.LISTEN);
  if (p > 0.55) palette.push(SFX.BREATH, SFX.DOOR);
  if (p > 0.8) palette.push(SFX.BREATH);

  const angle = rand(0, Math.PI * 2);
  const r = lerp(18, 5, p);
  const at = {
    x: player.location.x + Math.cos(angle) * r,
    y: player.location.y + rand(-1, 2),
    z: player.location.z + Math.sin(angle) * r,
  };

  playSafe(player, pick(palette), {
    location: at,
    volume: clamp(0.18 + p * 0.55, 0.15, 0.85),
    pitch: rand(0.45, 0.85),
  });
}

/**
 * The heartbeat is the player's own. It only appears once the permitted radius
 * has closed to the point where something could genuinely be within arm's
 * reach, and it accelerates as that radius shrinks.
 */
function heartbeat(player) {
  const notice = Notice.get(player);
  if (notice < 62) return;

  const now = system.currentTick;
  const due = nextHeart.get(player.id) ?? now;
  if (now < due) return;

  const p = clamp((notice - 62) / (NOTICE.MAX - 62), 0, 1);
  nextHeart.set(player.id, now + Math.round(lerp(34, 15, p)));

  playSafe(player, SFX.HEART, {
    location: player.location,
    volume: clamp(0.25 + p * 0.45, 0.2, 0.75),
    pitch: lerp(0.85, 1.15, p),
  });
}

/**
 * The only text the pack ever shows. It fires on threshold crossings, never on
 * a timer, and never names the entity — the player has to decide for
 * themselves what the line is about.
 */
const LINES = [
  "",
  "§8You are being kept track of.",
  "§8Something has decided where you are.",
  "§8It is closer than it was.",
  "§7It is allowed to stand behind you.",
];

const lastTier = new Map();

function threshold(player) {
  const tier = Notice.tierIndex(player);
  const prev = lastTier.get(player.id);
  lastTier.set(player.id, tier);
  if (prev === undefined || tier <= prev || tier === 0) return;

  try {
    player.onScreenDisplay.setActionBar(LINES[tier] ?? "");
  } catch {
    /* action bar is unavailable in some contexts */
  }
  playSafe(player, SFX.LISTEN, { location: player.location, volume: 0.35, pitch: 0.6 });
}

/**
 * A stare has one perceptual consequence and it is subtractive: the ambient
 * bed drops out. Looking at it makes the world quieter, not louder.
 */
function stareHush(player) {
  if (!Watcher.isBeingSeen(player)) return;
  const now = system.currentTick;
  nextAmbient.set(player.id, Math.max(nextAmbient.get(player.id) ?? now, now + 120));
}

export function tick(player, env) {
  try {
    applyFog(player);
    threshold(player);
    stareHush(player);
    ambient(player, env);
  } catch {
    /* atmosphere is cosmetic; never let it break the model */
  }
}

/** Runs every tick, separately from the one-second model, so it can keep time. */
export function fastTick(players) {
  for (const player of players) {
    try {
      heartbeat(player);
    } catch {
      /* ignore */
    }
  }
}

export function forget(playerId) {
  fogTier.delete(playerId);
  nextAmbient.delete(playerId);
  nextHeart.delete(playerId);
  lastTier.delete(playerId);
}
