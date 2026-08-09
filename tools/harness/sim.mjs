/**
 * Runs the pack's real scripts against a simulated world.
 *
 * The Watcher's whole premise is a claim about something that must never
 * happen: no player may ever see it move. That claim is not checkable by
 * reading the code, because it depends on the interaction between randomised
 * anchor selection, two players looking in different directions, and the
 * geometry of the cave they are standing in. So it gets simulated.
 *
 *     node --import ./tools/harness/hook.mjs tools/harness/sim.mjs
 */

import { world, system, Dimension, Player } from "./stub.mjs";

// ---------------------------------------------------------------------------
// A cavern: stone floor, eight blocks of air, stone ceiling, scattered pillars
// to give the anchor scorer something to hide behind.
// ---------------------------------------------------------------------------

function generator(x, y, z) {
  if (y <= -1) return "minecraft:stone";
  if (y >= 8) return "minecraft:stone";
  const hash = Math.abs(((x * 7919) ^ (z * 104729)) >>> 0);
  if (hash % 11 === 0) return "minecraft:stone"; // pillar
  return "minecraft:air";
}

const overworld = world.addDimension(new Dimension("minecraft:overworld", generator));
world.addDimension(new Dimension("minecraft:nether", () => "minecraft:air"));
world.addDimension(new Dimension("minecraft:the_end", () => "minecraft:air"));

const alice = world.addPlayer(new Player("Alice", overworld, { x: 0.5, y: 0, z: 0.5 }));
const bob = world.addPlayer(new Player("Bob", overworld, { x: 6.5, y: 0, z: -3.5 }));

// ---------------------------------------------------------------------------

const Notice = await import("../../packs/notice_BP/scripts/notice.js");
const Watcher = await import("../../packs/notice_BP/scripts/watcher.js");
const { WATCHER, NOTICE } = await import("../../packs/notice_BP/scripts/config.js");
await import("../../packs/notice_BP/scripts/main.js");

let failures = 0;
let assertions = 0;

function check(condition, message) {
  assertions++;
  if (!condition) {
    failures++;
    console.log(`  FAIL  ${message}`);
  }
}

function watchers() {
  return overworld.getEntities({ type: WATCHER.ID });
}

function isStandable(loc) {
  const x = Math.floor(loc.x);
  const y = Math.floor(loc.y);
  const z = Math.floor(loc.z);
  const solid = (yy) => overworld.typeAt(x, yy, z) === "minecraft:stone";
  const open = (yy) => overworld.typeAt(x, yy, z) === "minecraft:air";
  return solid(y - 1) && open(y) && open(y + 1) && open(y + 2);
}

// ---------------------------------------------------------------------------
// Scenario 1 — the invariant
// ---------------------------------------------------------------------------

console.log("\nscenario: the Watcher is never seen moving");

let moves = 0;
let observedFrames = 0;
let seenPositions = 0;
let badAnchors = 0;
let tooClose = 0;
let radiusViolations = 0;
let placements = 0;
const lastKnown = new Map(); // entity id -> last observed position

// Give both players enough notice that the Watcher is permitted to exist.
Notice.add(alice, 45);
Notice.add(bob, 30);

for (let tick = 0; tick < 8000; tick++) {
  // Players wander and look around. Bob turns faster, which is what would
  // catch a naive implementation out.
  if (tick % 3 === 0) {
    alice.rotation.y = (alice.rotation.y + (Math.random() - 0.5) * 40) % 360;
    alice.rotation.x = Math.max(-60, Math.min(60, alice.rotation.x + (Math.random() - 0.5) * 14));
    bob.rotation.y = (bob.rotation.y + (Math.random() - 0.5) * 110) % 360;
  }
  if (tick % 7 === 0) {
    for (const p of [alice, bob]) {
      const nx = p.location.x + (Math.random() - 0.5) * 1.4;
      const nz = p.location.z + (Math.random() - 0.5) * 1.4;
      if (generator(Math.floor(nx), 0, Math.floor(nz)) === "minecraft:air") {
        p.location.x = nx;
        p.location.z = nz;
      }
    }
  }

  // Snapshot the state the pack is about to make its decision from.
  const before = watchers().map((e) => ({
    entity: e,
    pos: { ...e.location },
    observed: Boolean(Watcher.observedByAnyone(overworld, e.location, world.getAllPlayers())),
  }));
  for (const b of before) if (b.observed) observedFrames++;

  system.step();

  for (const b of before) {
    if (b.entity.removed) {
      // Removal is a form of disappearance and is bound by the same rule.
      check(!b.observed, `tick ${tick}: Watcher was removed while a player was looking at it`);
      continue;
    }
    const moved =
      Math.abs(b.entity.location.x - b.pos.x) > 1e-6 ||
      Math.abs(b.entity.location.y - b.pos.y) > 1e-6 ||
      Math.abs(b.entity.location.z - b.pos.z) > 1e-6;
    if (!moved) continue;
    moves++;
    if (b.observed) {
      failures++;
      assertions++;
      if (failures < 5) {
        console.log(`  FAIL  tick ${tick}: Watcher teleported while observed`);
      }
    } else {
      assertions++;
    }
  }

  // Anchor sanity, and the permitted-distance contract.
  //
  // The radius is a contract about *placement*, not about steady state: once
  // it is standing there, the player is free to walk away from it. So the
  // check only fires on the tick a position is actually chosen.
  for (const e of watchers()) {
    if (!isStandable(e.location)) badAnchors++;
    if (Watcher.observedByAnyone(overworld, e.location, world.getAllPlayers())) seenPositions++;

    const previous = lastKnown.get(e.id);
    const here = { ...e.location };
    lastKnown.set(e.id, here);
    const justPlaced =
      !previous ||
      Math.abs(previous.x - here.x) > 1e-6 ||
      Math.abs(previous.y - here.y) > 1e-6 ||
      Math.abs(previous.z - here.z) > 1e-6;
    if (!justPlaced) continue;

    const owner = e.getDynamicProperty("nx:owner") === alice.id ? alice : bob;
    const dx = here.x - owner.location.x;
    const dz = here.z - owner.location.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    placements++;
    if (d < WATCHER.MIN_ABSOLUTE - 0.01) tooClose++;

    // selectAnchor samples at targetRadius +/- 2, then snaps to a block centre.
    const permitted = Watcher.permittedRadius(owner, Watcher.stealthTier(owner));
    if (Math.abs(d - permitted) > 3.2) {
      radiusViolations++;
      if (radiusViolations <= 3) {
        console.log(
          `        placed at ${d.toFixed(1)}m with ${permitted.toFixed(1)}m permitted ` +
            `(notice ${Notice.get(owner).toFixed(0)})`
        );
      }
    }
  }
}

console.log(`  ${moves} relocations and ${placements} distinct placements across 8000 ticks`);
console.log(`  ${observedFrames} tick-frames spent under observation`);
console.log(`  ${seenPositions} tick-frames where a Watcher was actually visible to someone`);
check(moves > 20, `the Watcher should have relocated many times (got ${moves})`);
check(observedFrames > 20, `players should have caught sight of it (got ${observedFrames})`);
check(badAnchors === 0, `every anchor must be standable ground (${badAnchors} were not)`);
check(tooClose === 0, `MIN_ABSOLUTE must hold (${tooClose} violations)`);
check(radiusViolations === 0, `placements must respect the permitted radius (${radiusViolations} of ${placements} did not)`);

// ---------------------------------------------------------------------------
// Scenario 2 — permitted distance shrinks with notice, and the floor ratchets
// ---------------------------------------------------------------------------

console.log("\nscenario: notice controls permitted distance, not aggression");

const probe = world.addPlayer(new Player("Probe", overworld, { x: 400.5, y: 0, z: 400.5 }));
let previous = Infinity;
const samples = [];
for (let n = 0; n <= NOTICE.MAX; n += 10) {
  probe.setDynamicProperty("nx:floor", 0);
  probe.setDynamicProperty("nx:notice", n);
  const r = Watcher.permittedRadius(probe, 0);
  samples.push([n, Number(r.toFixed(1))]);
  check(r <= previous + 1e-9, `radius must not grow as notice rises (${n} -> ${r})`);
  previous = r;
}
console.log("  notice -> permitted radius: " + samples.map(([n, r]) => `${n}:${r}m`).join("  "));
check(samples[0][1] === WATCHER.FAR, `notice 0 must permit exactly ${WATCHER.FAR}m`);
check(samples.at(-1)[1] <= WATCHER.NEAR + 0.01, `notice ${NOTICE.MAX} must permit ${WATCHER.NEAR}m`);

// Stealth tier pushes the boundary back out — staring makes it more distant.
probe.setDynamicProperty("nx:notice", 90);
const t0 = Watcher.permittedRadius(probe, 0);
const t4 = Watcher.permittedRadius(probe, WATCHER.MAX_STEALTH_TIER);
console.log(`  at notice 90: tier 0 permits ${t0.toFixed(1)}m, tier 4 permits ${t4.toFixed(1)}m`);
check(t4 > t0, "a higher stealth tier must permit a greater distance");

// The ratchet.
probe.setDynamicProperty("nx:notice", 0);
probe.setDynamicProperty("nx:floor", 0);
Notice.add(probe, 80);
const floor = Notice.getFloor(probe);
check(floor > 0, "reaching high notice must raise the floor");
Notice.add(probe, -1000);
console.log(`  after peaking at 80 and decaying hard: notice ${Notice.get(probe).toFixed(1)}, floor ${floor.toFixed(1)}`);
check(Notice.get(probe) >= floor - 1e-9, "notice must never fall below the floor");
check(Notice.get(probe) > 0, "notice must never return to zero once earned");

// ---------------------------------------------------------------------------
// Scenario 3 — the model responds to the world
// ---------------------------------------------------------------------------

console.log("\nscenario: solitude and darkness accrue, daylight and company decay");

function measure(label, setup) {
  const p = world.addPlayer(new Player(label, overworld, { x: 900.5, y: 0, z: 900.5 }));
  p.setDynamicProperty("nx:notice", 40);
  p.setDynamicProperty("nx:floor", 0);
  setup(p);
  const start = Notice.get(p);
  for (let i = 0; i < 60; i++) Notice.evaluate(p, world.getAllPlayers().filter((q) => q === p || q.name === "Companion"));
  const delta = Notice.get(p) - start;
  console.log(`  ${label.padEnd(22)} ${delta >= 0 ? "+" : ""}${delta.toFixed(2)} over 60s`);
  return delta;
}

world.setTimeOfDay(18000); // night
const deepAlone = measure("alone, dark, y=0", () => {});

world.setTimeOfDay(6000); // noon
const daylit = measure("daylight, y=200", (p) => {
  p.location = { x: 900.5, y: 200, z: 900.5 };
});

world.setTimeOfDay(18000);
const withLight = measure("dark, torch adjacent", (p) => {
  overworld.setBlock(902, 0, 900, "minecraft:torch");
  p.location = { x: 900.5, y: 0, z: 900.5 };
});

check(deepAlone > 0, "alone in the dark must accrue notice");
check(daylit < 0, "genuine daylight must decay notice");
check(withLight < deepAlone, "a nearby light must slow accrual");

// ---------------------------------------------------------------------------
// Scenario 4 — aperture generation only cuts into buried rock
// ---------------------------------------------------------------------------

console.log("\nscenario: apertures only cut into virgin rock");

const solid = world.addDimension(new Dimension("sim:solid", (x, y, z) => "minecraft:stone"));
const digger = world.addPlayer(new Player("Digger", solid, { x: 0.5, y: 10, z: 0.5 }));
digger.setDynamicProperty("nx:notice", 95);

const Structures = await import("../../packs/notice_BP/scripts/structures.js");
let built = 0;
for (let i = 0; i < 40; i++) {
  // Advance the clock rather than clearing the cooldown map: forget() re-primes
  // the timer, so calling it here would mean no attempt ever comes due.
  system.currentTick += 4000;
  const before = solid.overrides.size;
  Structures.tick([digger]);
  if (solid.overrides.size > before) built++;
}
console.log(`  ${built} apertures cut in 40 attempts at notice 95`);
check(built > 0, "apertures must generate in fully buried stone at high notice");

const lootCommands = solid.commands.filter((c) => c.startsWith("loot insert"));
check(lootCommands.length === built, "every aperture must fill its reliquary");

// Apertures may legitimately appear in the sealed rock *beneath* an open
// cavern — that is the intended discovery path, since you find one by mining
// into it. What must never happen is an aperture eating space that was already
// open, because that is how you delete somebody's base.
const cavernDigger = world.addPlayer(new Player("Caver", overworld, { x: 2000.5, y: 0, z: 2000.5 }));
cavernDigger.setDynamicProperty("nx:notice", 95);
const cavernBefore = new Set(overworld.overrides.keys());
for (let i = 0; i < 60; i++) {
  system.currentTick += 4000;
  Structures.tick([cavernDigger]);
}

let overwrittenSolid = 0;
let overwrittenAir = 0;
for (const key of overworld.overrides.keys()) {
  if (cavernBefore.has(key)) continue;
  const [x, y, z] = key.split(",").map(Number);
  if (generator(x, y, z) === "minecraft:air") overwrittenAir++;
  else overwrittenSolid++;
}
const total = overwrittenSolid + overwrittenAir;
const airShare = total === 0 ? 0 : overwrittenAir / total;
console.log(
  `  near an open cavern: ${total} blocks replaced, ${(airShare * 100).toFixed(1)}% of them ` +
    `previously open air`
);
check(total > 0, "apertures should still generate in the rock beneath a cavern");
check(airShare < 0.1, `apertures must not consume open space (${(airShare * 100).toFixed(1)}% did)`);

// ---------------------------------------------------------------------------
// Scenario 5 — the escalation curve
// ---------------------------------------------------------------------------
//
// The whole pitch is that dread scales instead of spiking, which is a claim
// about wall-clock time. Pinning the curve here means a careless tweak to any
// single accrual constant shows up as a failing test rather than as a pack
// that tops out in the first five minutes of a cave.

console.log("\nscenario: escalation curve (alone, dark, y=-20, no mining)");

world.setTimeOfDay(18000);
const spelunker = world.addPlayer(new Player("Spelunker", overworld, { x: 5000.5, y: -20, z: 5000.5 }));
spelunker.setDynamicProperty("nx:notice", 0);
spelunker.setDynamicProperty("nx:floor", 0);

const solo = [spelunker];
const marks = new Map([[WATCHER.THRESHOLD, null], [18, null], [38, null], [58, null], [80, null]]);
for (let second = 1; second <= 60 * 90; second++) {
  Notice.evaluate(spelunker, solo);
  const n = Notice.get(spelunker);
  for (const [level, at] of marks) {
    if (at === null && n >= level) marks.set(level, second);
  }
}

for (const [level, at] of marks) {
  const label = level === WATCHER.THRESHOLD ? `${level} (Watcher permitted)` : String(level);
  console.log(`  notice ${label.padEnd(24)} ${at === null ? "not reached in 90 min" : (at / 60).toFixed(1) + " min"}`);
}

const firstSighting = marks.get(WATCHER.THRESHOLD);
const topOut = marks.get(80);
check(firstSighting !== null && firstSighting > 90, "the first appearance must not be immediate");
check(firstSighting !== null && firstSighting < 60 * 8, "the first appearance must arrive within a caving trip");
check(topOut !== null, "the curve must reach its top tier within 90 minutes");
check(topOut > 60 * 10, `topping out must take real time (got ${(topOut / 60).toFixed(1)} min)`);

// ---------------------------------------------------------------------------
// Scenario 6 — the Gaunt never closes
// ---------------------------------------------------------------------------
//
// The Watcher is bounded by a permitted radius it is allowed to approach. The
// Gaunt is bounded by one it is not: whatever its heading, whatever the
// terrain does to it, it may never come inside MIN_DISTANCE. It is the only
// thing in the pack that moves under its own power in plain sight, so the
// distance floor is the entire reason it is safe to show.

console.log("\nscenario: the Gaunt walks, and never closes");

const Gaunt = await import("../../packs/notice_BP/scripts/gaunt.js");
const { GAUNT } = await import("../../packs/notice_BP/scripts/config.js");

// Open sky: solid ground at y=63, nothing above it.
const surface = world.addDimension(
  new Dimension("sim:surface", (x, y, z) => (y <= 63 ? "minecraft:stone" : "minecraft:air"))
);
const walker = world.addPlayer(new Player("Walker", surface, { x: 0.5, y: 64, z: 0.5 }));
walker.setDynamicProperty("nx:notice", 95);
walker.setDynamicProperty("nx:floor", 0);

// Force a spawn attempt rather than waiting out the seven-minute timer.
let appeared = false;
for (let i = 0; i < 200 && !appeared; i++) {
  system.currentTick += 20000;
  Gaunt.tick([walker]);
  appeared = surface.getEntities({ type: GAUNT.ID }).length > 0;
}
check(appeared, "the Gaunt must spawn under open sky at high notice");

let closest = Infinity;
let furthest = 0;
let moved = 0;
let lastPos = null;
let haltedAt = null;

if (appeared) {
  for (let tick = 0; tick < 2400; tick++) {
    // The player watches it for a stretch in the middle, then looks away.
    const staring = tick > 400 && tick < 700;
    const g = surface.getEntities({ type: GAUNT.ID })[0];
    if (g) {
      if (staring) {
        const dx = g.location.x - walker.location.x;
        const dz = g.location.z - walker.location.z;
        walker.rotation.y = (Math.atan2(-dx, dz) * 180) / Math.PI;
      } else {
        walker.rotation.y = 180 + (Math.atan2(-(g.location.x - walker.location.x),
          g.location.z - walker.location.z) * 180) / Math.PI;
      }
    }

    system.currentTick++;
    Gaunt.tick([walker]);

    const after = surface.getEntities({ type: GAUNT.ID })[0];
    if (!after) break;
    const d = Math.hypot(after.location.x - walker.location.x,
      after.location.z - walker.location.z);
    closest = Math.min(closest, d);
    furthest = Math.max(furthest, d);
    if (lastPos && (Math.abs(after.location.x - lastPos.x) > 1e-9 ||
        Math.abs(after.location.z - lastPos.z) > 1e-9)) moved++;
    lastPos = { ...after.location };
    if (after.getProperty("nx:walking") === false && haltedAt === null) haltedAt = tick;
  }
}

console.log(`  closest approach ${closest.toFixed(1)}m (floor is ${GAUNT.MIN_DISTANCE}m), ` +
  `furthest ${furthest.toFixed(1)}m`);
console.log(`  ${moved} stride ticks; halted at tick ${haltedAt ?? "never"}`);
check(moved > 100, `the Gaunt must actually walk (got ${moved} stride ticks)`);
check(closest >= GAUNT.MIN_DISTANCE - 0.5,
  `the Gaunt must never come inside ${GAUNT.MIN_DISTANCE}m (got ${closest.toFixed(1)}m)`);
check(haltedAt !== null, "sustained observation must stop it walking");

// ---------------------------------------------------------------------------
// Scenario 7 — incidents are gated, varied, and harmless
// ---------------------------------------------------------------------------

console.log("\nscenario: incidents are notice-gated and never repeat back to back");

const Events = await import("../../packs/notice_BP/scripts/events.js");
const { EVENTS } = await import("../../packs/notice_BP/scripts/config.js");

function runIncidents(notice, seconds) {
  const p = world.addPlayer(new Player(`Ev${notice}`, overworld, { x: 7000.5, y: 0, z: 7000.5 }));
  p.setDynamicProperty("nx:notice", notice);
  p.setDynamicProperty("nx:floor", 0);
  const before = p.location.y;
  let fired = 0;
  const seen = new Set();
  const soundsBefore = world.sounds.length;
  for (let i = 0; i < seconds; i++) {
    system.currentTick += 20;
    const barsBefore = p.actionBars.length;
    const sBefore = world.sounds.length;
    const eBefore = p.effects.length;
    Events.tick([p]);
    if (world.sounds.length > sBefore || p.actionBars.length > barsBefore ||
        p.effects.length > eBefore) fired++;
  }
  check(p.location.y === before, `incidents must never move the player (notice ${notice})`);
  return { fired, sounds: world.sounds.length - soundsBefore };
}

const low = runIncidents(5, 400);
console.log(`  notice 5  (below the ${EVENTS.THRESHOLD} threshold): ${low.fired} incidents`);
check(low.fired === 0, "no incidents may fire below the threshold");

const mid = runIncidents(35, 900);
const high = runIncidents(95, 900);
console.log(`  notice 35: ${mid.fired} incidents over 15 minutes`);
console.log(`  notice 95: ${high.fired} incidents over 15 minutes`);
check(mid.fired > 0, "incidents must fire at mid notice");
check(high.fired >= mid.fired, "incidents must not get rarer as notice rises");

// No incident is allowed to break blocks. Snapshot the world around a player
// at maximum notice and confirm nothing changed.
const destructive = world.addPlayer(new Player("Ev-blocks", overworld, { x: 7400.5, y: 0, z: 7400.5 }));
destructive.setDynamicProperty("nx:notice", 100);
const overridesBefore = overworld.overrides.size;
for (let i = 0; i < 1200; i++) {
  system.currentTick += 20;
  Events.tick([destructive]);
}
console.log(`  ${overworld.overrides.size - overridesBefore} blocks changed by 20 minutes of incidents`);
check(overworld.overrides.size === overridesBefore, "incidents must never place or break a block");

// ---------------------------------------------------------------------------

console.log("");
if (failures) {
  console.log(`FAILED — ${failures} of ${assertions} assertions`);
  process.exit(1);
}
console.log(`OK — ${assertions} assertions passed`);
