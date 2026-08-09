/**
 * A minimal, honest stand-in for `@minecraft/server`.
 *
 * It implements only the surface the pack actually touches, but it implements
 * that surface for real: the voxel grid is a genuine grid, and getBlockFromRay
 * is a genuine DDA traversal of it. That matters, because the one invariant
 * worth testing — that the Watcher is never seen moving — is decided entirely
 * by raycasts. A stub that faked line of sight would prove nothing.
 */

// ---------------------------------------------------------------------------
// Voxel world
// ---------------------------------------------------------------------------

const SOLID = new Set(["minecraft:stone", "minecraft:deepslate", "minecraft:bedrock"]);

class Block {
  constructor(dimension, x, y, z, typeId) {
    this.dimension = dimension;
    this.location = { x, y, z };
    this.x = x;
    this.y = y;
    this.z = z;
    this.typeId = typeId;
  }
  get isAir() {
    return this.typeId === "minecraft:air";
  }
  get isSolid() {
    return SOLID.has(this.typeId);
  }
  get isLiquid() {
    return this.typeId === "minecraft:water" || this.typeId === "minecraft:lava";
  }
  setType(typeId) {
    this.dimension.setBlock(this.x, this.y, this.z, typeId);
  }
}

export class LocationInUnloadedChunkError extends Error {}

class Dimension {
  constructor(id, generator) {
    this.id = id;
    this.generator = generator;
    this.overrides = new Map();
    this.entities = new Set();
    this.commands = [];
  }

  key(x, y, z) {
    return `${x},${y},${z}`;
  }

  typeAt(x, y, z) {
    const k = this.key(x, y, z);
    if (this.overrides.has(k)) return this.overrides.get(k);
    return this.generator(x, y, z);
  }

  setBlock(x, y, z, typeId) {
    this.overrides.set(this.key(x, y, z), typeId);
  }

  getBlock(loc) {
    const x = Math.floor(loc.x);
    const y = Math.floor(loc.y);
    const z = Math.floor(loc.z);
    if (y < -64 || y > 320) throw new LocationInUnloadedChunkError("out of world");
    return new Block(this, x, y, z, this.typeAt(x, y, z));
  }

  getTopmostBlock(xz) {
    const x = Math.floor(xz.x);
    const z = Math.floor(xz.z);
    for (let y = 200; y > -64; y--) {
      if (this.typeAt(x, y, z) !== "minecraft:air") return new Block(this, x, y, z, this.typeAt(x, y, z));
    }
    return undefined;
  }

  /** Amanatides–Woo voxel traversal. Stops at the first non-passable block. */
  getBlockFromRay(origin, direction, options = {}) {
    const maxDistance = options.maxDistance ?? 64;
    let x = Math.floor(origin.x);
    let y = Math.floor(origin.y);
    let z = Math.floor(origin.z);

    const step = (d) => (d > 0 ? 1 : d < 0 ? -1 : 0);
    const sx = step(direction.x);
    const sy = step(direction.y);
    const sz = step(direction.z);

    const tDelta = {
      x: sx === 0 ? Infinity : Math.abs(1 / direction.x),
      y: sy === 0 ? Infinity : Math.abs(1 / direction.y),
      z: sz === 0 ? Infinity : Math.abs(1 / direction.z),
    };
    const boundary = (o, i, s) => (s > 0 ? i + 1 - o : o - i);
    let tMax = {
      x: sx === 0 ? Infinity : boundary(origin.x, x, sx) * tDelta.x,
      y: sy === 0 ? Infinity : boundary(origin.y, y, sy) * tDelta.y,
      z: sz === 0 ? Infinity : boundary(origin.z, z, sz) * tDelta.z,
    };

    let travelled = 0;
    for (let guard = 0; guard < 1024 && travelled <= maxDistance; guard++) {
      const type = this.typeAt(x, y, z);
      const block = new Block(this, x, y, z, type);
      if (block.isSolid || (options.includeLiquidBlocks && block.isLiquid)) {
        return { block, faceLocation: { x: 0, y: 0, z: 0 } };
      }
      if (tMax.x < tMax.y && tMax.x < tMax.z) {
        x += sx;
        travelled = tMax.x;
        tMax.x += tDelta.x;
      } else if (tMax.y < tMax.z) {
        y += sy;
        travelled = tMax.y;
        tMax.y += tDelta.y;
      } else {
        z += sz;
        travelled = tMax.z;
        tMax.z += tDelta.z;
      }
    }
    return undefined;
  }

  getEntities(options = {}) {
    let list = [...this.entities];
    if (options.type) list = list.filter((e) => e.typeId === options.type);
    if (options.families) {
      list = list.filter((e) => options.families.some((f) => e.families.includes(f)));
    }
    if (options.tags) {
      list = list.filter((e) => options.tags.every((t) => e.tags.has(t)));
    }
    if (options.location && options.maxDistance !== undefined) {
      list = list.filter((e) => distance(e.location, options.location) <= options.maxDistance);
    }
    return list;
  }

  spawnEntity(typeId, location) {
    const e = new Entity(typeId, this, location);
    this.entities.add(e);
    world.register(e);
    return e;
  }

  runCommand(command) {
    this.commands.push(command);
    return { successCount: 1 };
  }
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

let nextId = 1;

class Entity {
  constructor(typeId, dimension, location) {
    this.id = String(nextId++);
    this.typeId = typeId;
    this.dimension = dimension;
    this.location = { ...location };
    this.tags = new Set();
    this.families = [];
    this.props = new Map();
    this.properties = new Map();
    this.effects = [];
    this.removed = false;
    /** Every position this entity has ever occupied, with the tick it moved. */
    this.history = [{ tick: system.currentTick, ...this.location }];
  }
  isValid() {
    return !this.removed;
  }
  addTag(t) {
    this.tags.add(t);
    return true;
  }
  hasTag(t) {
    return this.tags.has(t);
  }
  getDynamicProperty(k) {
    return this.props.get(k);
  }
  setDynamicProperty(k, v) {
    this.props.set(k, v);
  }
  clearVelocity() {}
  /** Entity properties: the script->renderer channel. */
  setProperty(name, value) {
    this.properties.set(name, value);
  }
  getProperty(name) {
    return this.properties.get(name);
  }
  addEffect(type, duration, options) {
    this.effects.push({ type, duration, ...options });
    return true;
  }
  teleport(location, options = {}) {
    const moved =
      Math.abs(location.x - this.location.x) > 1e-6 ||
      Math.abs(location.y - this.location.y) > 1e-6 ||
      Math.abs(location.z - this.location.z) > 1e-6;
    this.location = { x: location.x, y: location.y, z: location.z };
    if (options.dimension && options.dimension !== this.dimension) {
      this.dimension.entities.delete(this);
      this.dimension = options.dimension;
      this.dimension.entities.add(this);
    }
    if (moved) this.history.push({ tick: system.currentTick, ...this.location });
  }
  remove() {
    this.removed = true;
    this.dimension.entities.delete(this);
    world.unregister(this);
  }
  playSound(id, options) {
    world.sounds.push({ id, ...options });
  }
  runCommand(command) {
    return this.dimension.runCommand(command);
  }
}

export class Player extends Entity {
  constructor(name, dimension, location) {
    super("minecraft:player", dimension, location);
    this.name = name;
    this.rotation = { x: 0, y: 0 };
    this.messages = [];
    this.actionBars = [];
    this.onScreenDisplay = {
      setActionBar: (t) => this.actionBars.push(t),
    };
  }
  getHeadLocation() {
    return { x: this.location.x, y: this.location.y + 1.62, z: this.location.z };
  }
  /** rotation.y is yaw in degrees, rotation.x is pitch, matching Bedrock. */
  getViewDirection() {
    const yaw = (this.rotation.y * Math.PI) / 180;
    const pitch = (this.rotation.x * Math.PI) / 180;
    return {
      x: -Math.sin(yaw) * Math.cos(pitch),
      y: -Math.sin(pitch),
      z: Math.cos(yaw) * Math.cos(pitch),
    };
  }
  getRotation() {
    return { ...this.rotation };
  }
  sendMessage(m) {
    this.messages.push(m);
  }
  getComponent() {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

class Signal {
  constructor() {
    this.handlers = [];
  }
  subscribe(fn) {
    this.handlers.push(fn);
    return fn;
  }
  unsubscribe(fn) {
    this.handlers = this.handlers.filter((h) => h !== fn);
  }
  emit(payload) {
    for (const h of this.handlers) h(payload);
  }
}

// ---------------------------------------------------------------------------
// World and system
// ---------------------------------------------------------------------------

class World {
  constructor() {
    this.dimensions = new Map();
    this.players = [];
    this.byId = new Map();
    this.props = new Map();
    this.sounds = [];
    this.timeOfDay = 18000; // night, by default; this is a horror pack
    this.afterEvents = {
      playerSpawn: new Signal(),
      playerLeave: new Signal(),
      playerBreakBlock: new Signal(),
      playerInteractWithBlock: new Signal(),
      itemUse: new Signal(),
      entityDie: new Signal(),
    };
  }
  addDimension(dim) {
    this.dimensions.set(dim.id, dim);
    return dim;
  }
  getDimension(id) {
    const d = this.dimensions.get(id);
    if (!d) throw new Error(`no such dimension ${id}`);
    return d;
  }
  getAllPlayers() {
    return [...this.players];
  }
  addPlayer(player) {
    this.players.push(player);
    player.dimension.entities.add(player);
    this.register(player);
    return player;
  }
  register(entity) {
    this.byId.set(entity.id, entity);
  }
  unregister(entity) {
    this.byId.delete(entity.id);
  }
  getEntity(id) {
    const e = this.byId.get(id);
    return e && !e.removed ? e : undefined;
  }
  getTimeOfDay() {
    return this.timeOfDay;
  }
  setTimeOfDay(t) {
    this.timeOfDay = t;
  }
  getDynamicProperty(k) {
    return this.props.get(k);
  }
  setDynamicProperty(k, v) {
    this.props.set(k, v);
  }
}

class SystemShim {
  constructor() {
    this.currentTick = 0;
    this.intervals = [];
    this.timeouts = [];
    this.immediate = [];
    this.afterEvents = { scriptEventReceive: new Signal() };
  }
  run(fn) {
    this.immediate.push(fn);
    return this.immediate.length;
  }
  runInterval(fn, period = 1) {
    this.intervals.push({ fn, period, next: this.currentTick + period });
    return this.intervals.length;
  }
  runTimeout(fn, delay = 1) {
    this.timeouts.push({ fn, at: this.currentTick + delay });
    return this.timeouts.length;
  }
  clearRun() {}

  /** Advance exactly one tick, running whatever is due. */
  step() {
    const pending = this.immediate;
    this.immediate = [];
    for (const fn of pending) fn();

    const due = this.timeouts.filter((t) => t.at <= this.currentTick);
    this.timeouts = this.timeouts.filter((t) => t.at > this.currentTick);
    for (const t of due) t.fn();

    for (const i of this.intervals) {
      if (this.currentTick >= i.next) {
        i.next = this.currentTick + i.period;
        i.fn();
      }
    }
    this.currentTick++;
  }
}

export const world = new World();
export const system = new SystemShim();
export { Dimension, Entity, Block };
