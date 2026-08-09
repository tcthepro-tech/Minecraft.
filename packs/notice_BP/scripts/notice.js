import { system, world } from "@minecraft/server";
import { NOTICE, TIERS, PROP, LIGHT_SOURCES } from "./config.js";
import { clamp, lerp, safeBlock, seesSky, isDaytime, dist } from "./util.js";

/**
 * The one number.
 *
 * Read it with get(player). Nothing else in the pack is allowed to keep its own
 * escalation state — structures, fog, audio and both support entities all
 * derive from this, which is why the dread scales smoothly instead of spiking.
 */

/**
 * The accrual multiplier, persisted on the world so it survives a reload.
 * Only ever scales *gains* — decay and the floor are untouched, so turning it
 * up makes the pack faster, never harder to escape.
 */
let intensityCache;

export function intensity() {
  if (intensityCache === undefined) {
    const stored = world.getDynamicProperty("nx:intensity");
    intensityCache = typeof stored === "number" && stored > 0 ? stored : NOTICE.INTENSITY;
  }
  return intensityCache;
}

export function setIntensity(value) {
  intensityCache = value;
  try {
    world.setDynamicProperty("nx:intensity", value);
  } catch {
    /* the setting simply will not persist */
  }
}

export function get(player) {
  const n = player.getDynamicProperty(PROP.NOTICE);
  return typeof n === "number" ? n : 0;
}

export function getFloor(player) {
  const f = player.getDynamicProperty(PROP.FLOOR);
  return typeof f === "number" ? f : 0;
}

function set(player, value) {
  const floor = getFloor(player);
  player.setDynamicProperty(PROP.NOTICE, clamp(value, floor, NOTICE.MAX));
}

/** Add (or subtract) notice, respecting the floor and raising it where earned. */
export function add(player, delta) {
  const before = get(player);
  const after = clamp(before + delta, 0, NOTICE.MAX);
  set(player, after);
  if (delta > 0) raiseFloor(player, after);
  return get(player);
}

/**
 * The ratchet. The floor tracks a fraction of the highest notice ever reached
 * and only ever moves up — so a night spent deep underground permanently
 * changes the baseline of the save. This is the reason notice "never returns
 * to zero".
 */
function raiseFloor(player, current) {
  const target = Math.min(current * NOTICE.FLOOR_RATIO, NOTICE.FLOOR_MAX);
  if (target > getFloor(player)) player.setDynamicProperty(PROP.FLOOR, target);
}

/** The tallow candle is the only thing in the pack that walks the floor back. */
export function easeFloor(player, amount) {
  const f = getFloor(player);
  if (f > 0) player.setDynamicProperty(PROP.FLOOR, Math.max(0, f - amount));
}

/** 0..1. The normalised pressure every other system multiplies against. */
export function pressure(player) {
  return get(player) / NOTICE.MAX;
}

export function tierIndex(player) {
  const n = get(player);
  let idx = 0;
  for (let i = 0; i < TIERS.length; i++) if (n >= TIERS[i].min) idx = i;
  return idx;
}

export function candleLit(player) {
  const until = player.getDynamicProperty(PROP.CANDLE);
  return typeof until === "number" && until > system.currentTick;
}

export function lightCandle(player) {
  player.setDynamicProperty(PROP.CANDLE, system.currentTick + NOTICE.CANDLE_TICKS);
}

// ---------------------------------------------------------------------------
// Environment sampling
// ---------------------------------------------------------------------------

/**
 * Offsets for the light scan: a complete radius-N cube, ordered nearest-first
 * so the cheapest slice is also the one most likely to hit.
 *
 * A stepped lattice is tempting here and is wrong. Stepping by two only ever
 * samples one parity, so a torch one block off the lattice is invisible
 * forever — not "usually found", never found. The scan has to be exhaustive.
 */
const LIGHT_OFFSETS = (() => {
  const r = NOTICE.LIGHT_SCAN_RADIUS;
  const out = [];
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -2; dy <= 3; dy++) {
      for (let dz = -r; dz <= r; dz++) out.push([dx, dy, dz]);
    }
  }
  out.sort((a, b) => a[0] * a[0] + a[1] * a[1] + a[2] * a[2] - (b[0] * b[0] + b[1] * b[1] + b[2] * b[2]));
  return out;
})();

/** Slices of the scan spread across consecutive evaluations. */
const LIGHT_SLICES = 4;
const LIGHT_SLICE_SIZE = Math.ceil(LIGHT_OFFSETS.length / LIGHT_SLICES);
/** How long a sighting counts for, in ticks. */
const LIGHT_MEMORY = 120;

const lightScan = new Map(); // playerId -> { slice, lastFound }

/**
 * Exhaustive, but amortised: one quarter of the cube per second, so the cost
 * is a few hundred block reads rather than a few thousand, and a torch is
 * found within four seconds at the worst. Four seconds is nothing against a
 * value that moves by a tenth per tick of the model.
 */
function nearLight(player) {
  let st = lightScan.get(player.id);
  if (!st) {
    st = { slice: 0, lastFound: -Infinity };
    lightScan.set(player.id, st);
  }

  const o = player.location;
  const ox = Math.floor(o.x);
  const oy = Math.floor(o.y);
  const oz = Math.floor(o.z);

  const start = st.slice * LIGHT_SLICE_SIZE;
  const end = Math.min(start + LIGHT_SLICE_SIZE, LIGHT_OFFSETS.length);
  st.slice = (st.slice + 1) % LIGHT_SLICES;

  for (let i = start; i < end; i++) {
    const [dx, dy, dz] = LIGHT_OFFSETS[i];
    const b = safeBlock(player.dimension, { x: ox + dx, y: oy + dy, z: oz + dz });
    if (b && LIGHT_SOURCES.has(b.typeId)) {
      st.lastFound = system.currentTick;
      return true;
    }
  }

  return system.currentTick - st.lastFound <= LIGHT_MEMORY;
}

export function forgetLightScan(playerId) {
  lightScan.delete(playerId);
}

function countCompany(player, players) {
  let nearest = Infinity;
  for (const other of players) {
    if (other.id === player.id) continue;
    if (other.dimension.id !== player.dimension.id) continue;
    const d = dist(other.location, player.location);
    if (d < nearest) nearest = d;
  }
  return nearest;
}

function villagerNear(player) {
  try {
    const found = player.dimension.getEntities({
      location: player.location,
      maxDistance: NOTICE.VILLAGER_RADIUS,
      families: ["villager"],
    });
    return found.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * One second of accrual and decay for one player.
 * Returns a small report so the atmosphere layer can react without re-sampling.
 */
export function evaluate(player, players) {
  const lit = nearLight(player);
  const sky = seesSky(player.dimension, player.location);
  const day = isDaytime();
  const daylight = sky && day;
  const dark = !daylight && !lit;

  const nearestPlayer = countCompany(player, players);
  const alone = nearestPlayer > NOTICE.SOLITUDE_RADIUS;

  // Solitude compounds with duration rather than arriving all at once.
  let aloneFor = player.getDynamicProperty(PROP.ALONE);
  aloneFor = typeof aloneFor === "number" ? aloneFor : 0;
  aloneFor = alone ? aloneFor + 1 : 0;
  player.setDynamicProperty(PROP.ALONE, aloneFor);

  let gain = 0;

  if (alone) {
    const ramp = lerp(1, NOTICE.SOLITUDE_RAMP_MAX, aloneFor / NOTICE.SOLITUDE_RAMP);
    gain += NOTICE.SOLITUDE_GAIN * ramp;
  }

  const y = player.location.y;
  if (y < NOTICE.DEPTH_START) {
    const t = (NOTICE.DEPTH_START - y) / (NOTICE.DEPTH_START - NOTICE.DEPTH_FULL);
    gain += NOTICE.DEPTH_GAIN * clamp(t, 0, 1);
  }

  if (dark) gain += NOTICE.DARK_GAIN;

  gain *= intensity();

  if (candleLit(player)) {
    gain *= NOTICE.CANDLE_GAIN_MULT;
    easeFloor(player, NOTICE.CANDLE_FLOOR_DECAY);
  }

  let decay = NOTICE.AMBIENT_DECAY;
  if (daylight) decay += NOTICE.DAYLIGHT_DECAY;
  if (nearestPlayer <= NOTICE.COMPANY_RADIUS) decay += NOTICE.COMPANY_DECAY;
  if (lit) decay += NOTICE.LIT_DECAY;
  if (villagerNear(player)) decay += NOTICE.VILLAGER_DECAY;

  const net = gain - decay;
  if (net > 0) add(player, net);
  else set(player, get(player) + net); // decay must not raise the floor

  return { lit, daylight, dark, alone, nearestPlayer, aloneFor };
}

/**
 * Set notice directly, ignoring the floor in the downward direction. Only the
 * diagnostic command uses this — the model itself must never move the number
 * below the floor.
 */
export function force(player, value) {
  const v = clamp(value, 0, NOTICE.MAX);
  player.setDynamicProperty(PROP.FLOOR, Math.min(getFloor(player), v));
  player.setDynamicProperty(PROP.NOTICE, v);
}

/** Called once when a player first joins, so the properties always exist. */
export function ensure(player) {
  if (typeof player.getDynamicProperty(PROP.NOTICE) !== "number") {
    player.setDynamicProperty(PROP.NOTICE, 0);
  }
  if (typeof player.getDynamicProperty(PROP.FLOOR) !== "number") {
    player.setDynamicProperty(PROP.FLOOR, 0);
  }
}

/**
 * Death is not absolution. Dying releases the current charge but leaves the
 * floor exactly where it was, so the second descent starts where the first
 * one ended.
 */
export function onDeath(player) {
  player.setDynamicProperty(PROP.ALONE, 0);
  set(player, getFloor(player));
}
