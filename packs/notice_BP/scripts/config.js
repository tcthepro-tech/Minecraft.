/**
 * Every tunable in the pack lives here.
 *
 * The whole addon is a single scalar — `notice` — plus a set of curves that
 * read it. Nothing below controls aggression, because nothing in the pack is
 * aggressive. The numbers control *permission*: how close the world is willing
 * to let something stand.
 */

export const NOTICE = {
  /** Hard ceiling. notice is always clamped to [0, MAX]. */
  MAX: 100,

  /**
   * The ratchet. notice decays toward `floor`, never below it, and the floor
   * only ever rises. A world that has noticed you does not forget; it only
   * stops paying attention for a while.
   */
  FLOOR_RATIO: 0.45,
  FLOOR_MAX: 72,

  /** Evaluation cadence for the notice model, in ticks. */
  EVAL_INTERVAL: 20,

  /**
   * Global accrual multiplier, settable in game with `/scriptevent nx:intensity`.
   *
   * The default used to be 1.0, which put first contact at 3.3 minutes of
   * unbroken dark solitude. That is a defensible slow burn and a terrible first
   * five minutes: a player who loads the pack, looks around a lit base and sees
   * nothing has no way to tell it from a pack that failed to install.
   */
  INTENSITY: 1.6,

  // --- Accrual (per evaluation, i.e. per second) ---------------------------

  /** Alone: no other player within SOLITUDE_RADIUS. */
  SOLITUDE_RADIUS: 48,
  SOLITUDE_GAIN: 0.018,
  /** Solitude compounds. Multiplier ramps to this over SOLITUDE_RAMP seconds. */
  SOLITUDE_RAMP: 900,
  SOLITUDE_RAMP_MAX: 2.2,

  /** Depth: begins below DEPTH_START, scaling to full weight at DEPTH_FULL. */
  DEPTH_START: 48,
  DEPTH_FULL: -40,
  DEPTH_GAIN: 0.026,

  /** Darkness: no sky access, or sky access at night, with no light nearby. */
  DARK_GAIN: 0.038,
  /** Radius searched for a light source. Scanned exhaustively, a quarter per second. */
  LIGHT_SCAN_RADIUS: 5,

  // --- Trespass (event-driven spikes) --------------------------------------

  /** Breaking into fully-enclosed stone below TRESPASS_MAX_Y. */
  TRESPASS_MAX_Y: 45,
  TRESPASS_GAIN: 0.6,
  /** First block broken in a chunk this session, below TRESPASS_MAX_Y. */
  VIRGIN_CHUNK_GAIN: 1.8,
  /** Opening an Aperture reliquary. The single largest jump in the pack. */
  APERTURE_GAIN: 22,

  /** Staring at the Watcher. Looking at it is how you feed it. */
  STARE_GAIN: 1.4,

  // --- Decay ---------------------------------------------------------------

  /** Standing in genuine daylight. */
  DAYLIGHT_DECAY: 0.22,
  /** Another player within this radius. */
  COMPANY_RADIUS: 24,
  COMPANY_DECAY: 0.12,
  /** A villager within this radius. Someone else is keeping watch. */
  VILLAGER_RADIUS: 16,
  VILLAGER_DECAY: 0.07,
  /** A light source within LIGHT_SCAN_RADIUS. */
  LIT_DECAY: 0.05,
  /** Baseline bleed, always applied. */
  AMBIENT_DECAY: 0.008,

  // --- Counterplay ---------------------------------------------------------

  /** A lit tallow candle: accrual multiplier, and the only floor-lowering effect. */
  CANDLE_TICKS: 7200,
  CANDLE_GAIN_MULT: 0.35,
  CANDLE_FLOOR_DECAY: 0.02,
};

/** Named bands. Used for fog, audio, structures and the support pair. */
export const TIERS = [
  { name: "unwatched", min: 0 },
  { name: "noticed", min: 18 },
  { name: "attended", min: 38 },
  { name: "close", min: 58 },
  { name: "permitted", min: 80 },
];

export const WATCHER = {
  ID: "nx:watcher",

  /** Below this, the Watcher is not permitted to exist at all. */
  THRESHOLD: 14,

  /** Loop cadence per tracked player, randomised in this range each cycle. */
  MIN_INTERVAL: 20,
  MAX_INTERVAL: 40,

  /**
   * Permitted distance. This is the entire point of `notice`.
   * radius = FAR - (FAR - NEAR) * (notice / MAX) ^ CURVE
   */
  FAR: 34,
  NEAR: 6,
  CURVE: 0.85,

  /** Stealth tier pushes the radius back out. Staring makes it better at hiding. */
  MAX_STEALTH_TIER: 4,
  TIER_RADIUS_BONUS: 0.18,

  /** Above this notice, it may be placed outside the view cone — behind you. */
  BEHIND_THRESHOLD: 55,

  /**
   * A viewer "observes" a point when it is inside this cone and unoccluded.
   * cos(63 deg) is deliberately wider than Bedrock's real horizontal FOV:
   * a false positive only makes the Watcher hold still, which is always safe.
   */
  OBSERVE_DOT: 0.45,
  /** Anchors are preferred at the edge of vision, not its centre. */
  EDGE_DOT_MIN: 0.3,
  EDGE_DOT_MAX: 0.85,

  /** Candidate anchors sampled per relocation attempt. */
  SAMPLES: 18,
  /** Vertical search window around the player when hunting for standable ground. */
  GROUND_UP: 6,
  GROUND_DOWN: 9,

  /** Ticks of sustained observation before it earns the right to leave. */
  STARE_LIMIT: 120,
  /** Ticks between notice increments while being stared at. */
  STARE_PERIOD: 40,

  /** Lifetime in ticks per stealth tier. Higher tiers appear more briefly. */
  LIFETIME: [1200, 900, 700, 520, 380],
  /** Ticks of forced absence after a vanish, per stealth tier. */
  COOLDOWN: [200, 320, 480, 700, 1000],

  /** Never place within this distance of the player, whatever notice says. */
  MIN_ABSOLUTE: 4.5,

  /**
   * The one exception to "it never animates". Above this notice, a Watcher
   * being actively stared at may open its maw — silently, once, as the last
   * thing before it goes. Everything else about the model is frozen.
   */
  MAW_MIN_NOTICE: 72,
  /** Ticks of staring before the maw is even considered. */
  MAW_AFTER: 60,
  MAW_CHANCE: 0.35,
};

export const HOLLOW = {
  ID: "nx:hollow",
  /** Minimum notice before the Hollow will occupy space near you. */
  THRESHOLD: 26,
  /** Base seconds between attempts, divided by pressure. */
  BASE_PERIOD: 55,
  MIN_PERIOD: 12,
  DISTANCE: [3, 9],
  /** Ticks the marker entity persists while it makes its noise. */
  LIFETIME: 70,
};

export const KINDLER = {
  ID: "nx:kindler",
  /** The relief only shows up once things are genuinely bad. */
  THRESHOLD: 45,
  /** Seconds between spawn attempts. */
  PERIOD: 150,
  SPAWN_DISTANCE: [14, 26],
  /** Within this radius it burns notice down fast. */
  COMFORT_RADIUS: 7,
  COMFORT_DECAY: 1.6,
  /** Approach faster than this (blocks/sec) inside COMFORT_RADIUS and it gutters out. */
  STARTLE_SPEED: 5.2,
  LIFETIME: 2400,
};

/**
 * The Gaunt: the Watcher's geometry at three times the scale, walking the
 * horizon. It is scenery with a pulse — it never approaches, and the distance
 * floor below is enforced on every single stride.
 */
export const GAUNT = {
  ID: "nx:gaunt",
  /** Only once the curve is genuinely near the top. */
  THRESHOLD: 70,
  SPAWN_DISTANCE: [64, 110],
  /** It may never come closer than this, whatever its heading says. */
  MIN_DISTANCE: 45,
  DESPAWN_DISTANCE: 170,
  /** Blocks per second. Slow: at ten blocks tall, a normal pace reads as scuttling. */
  SPEED: 1.6,
  LIFETIME: 1800,
  /** Ticks between spawn attempts, and the chance each attempt takes. */
  PERIOD: 9000,
  CHANCE: 0.45,
  /** Forced absence after one leaves. */
  COOLDOWN: 12000,
  /** Ticks of sustained observation before it stops walking and turns to you. */
  STARE_LIMIT: 90,
  STARE_GAIN: 4,
  OBSERVE_DOT: 0.5,
};

/**
 * One-shot incidents. Rare, short, never destructive, never damaging, and
 * never a reliable tell that the Watcher is about to appear.
 */
export const EVENTS = {
  THRESHOLD: 12,
  /** Seconds between incidents, at the threshold and at maximum notice. */
  MAX_PERIOD: 200,
  MIN_PERIOD: 45,
  /** How many recent incidents are excluded from the next draw. */
  NO_REPEAT: 3,
};

export const STRUCTURE = {
  /** Apertures only cut into rock, and only when something is already listening. */
  MIN_NOTICE: 40,
  MAX_Y: 38,
  MIN_Y: -50,
  /** Seconds between generation attempts per player. */
  PERIOD: 90,
  /** Chance per attempt at MIN_NOTICE, scaling to CHANCE_MAX at NOTICE.MAX. */
  CHANCE_MIN: 0.05,
  CHANCE_MAX: 0.3,
  PLACE_DISTANCE: [28, 56],
  /** How many sites the world remembers (for de-duplication). */
  MEMORY: 40,

  /** The Effigy: a ring of standing stones, on the surface, at night. */
  EFFIGY_MIN_NOTICE: 30,
  EFFIGY_CHANCE: 0.22,

  /** The Ossuary: a bone-lined chamber, shallower and commoner than an Aperture. */
  OSSUARY_MIN_NOTICE: 26,
  OSSUARY_MAX_Y: 48,
  OSSUARY_CHANCE: 0.3,
  /** Opening an ossuary chest. Less than an Aperture, but not nothing. */
  OSSUARY_GAIN: 8,
};

export const FOG = {
  /** Fog ids, indexed by tier. Tier 0 pushes nothing. */
  IDS: [null, "nx:dread_1", "nx:dread_2", "nx:dread_3", "nx:dread_4"],
  LAYER: "nx_dread",
};

/**
 * Audio.
 *
 * `nx.*` are the pack's own, synthesised by tools/gen_sounds.py and shipped as
 * Ogg Vorbis. Everything that should sound like the world rather than like a
 * creature stays on vanilla Bedrock events at odd pitches — a door closing
 * somewhere is far more unsettling as the game's real door sound than as
 * anything bespoke.
 */
export const SFX = {
  // --- The pack's own ------------------------------------------------------
  /** Close, wet, and under 1.2 kHz. Reads as large rather than sharp. */
  BREATH: "nx.breath",
  /** Sub-bass bed. Three detuned partials that never settle into a pitch. */
  DRONE: "nx.drone",
  /** Syllables without words. The brain supplies the language. */
  WHISPER: "nx.whisper",
  /**
   * Plays when you *look* at the Watcher — never when it arrives. It is a
   * presence tone, not a sting: no transient, nothing to flinch at. Silence
   * still never means safety.
   */
  STARE: "nx.stare",
  /** The grin coming apart. The pitch falls as it opens. */
  MAW: "nx.maw",
  /** Enormous and far away. Almost no high end, because distance eats it. */
  FAR: "nx.gaunt_call",
  /** A footfall from something with a very long stride. */
  FAR_STEP: "nx.far_step",
  SCRAPE: "nx.scrape",
  HEART: "nx.heart",
  KNOCK: "nx.knock",
  CHORUS: "nx.chorus",
  /** Only ever heard after it has already gone. */
  VANISH: "nx.vanish",
  LISTEN: "nx.listen",

  // --- Vanilla: the world, not the creature --------------------------------
  CAVE: "ambient.cave",
  DOOR: "random.door_close",
  DOOR_OPEN: "random.door_open",
  STEP: "dig.gravel",
  SETTLE: "dig.stone",
  KINDLE: "random.click",
  GUTTER: "random.fizz",
  CHEST_OPEN: "random.chestopen",
  CHEST_CLOSE: "random.chestclosed",
};

export const PROP = {
  NOTICE: "nx:notice",
  FLOOR: "nx:floor",
  ALONE: "nx:alone",
  CANDLE: "nx:candle_until",
  TIER: "nx:stealth_tier",
  OWNER: "nx:owner",
  APERTURES: "nx:apertures",
};

/** Blocks that count as "someone left a light on". */
export const LIGHT_SOURCES = new Set([
  "minecraft:torch",
  "minecraft:wall_torch",
  "minecraft:soul_torch",
  "minecraft:soul_wall_torch",
  "minecraft:lantern",
  "minecraft:soul_lantern",
  "minecraft:glowstone",
  "minecraft:sea_lantern",
  "minecraft:shroomlight",
  "minecraft:campfire",
  "minecraft:soul_campfire",
  "minecraft:lit_pumpkin",
  "minecraft:redstone_lamp",
  "minecraft:end_rod",
  "minecraft:froglight",
  "minecraft:ochre_froglight",
  "minecraft:verdant_froglight",
  "minecraft:pearlescent_froglight",
  "minecraft:candle",
  "minecraft:lit_candle",
  "minecraft:fire",
  "minecraft:soul_fire",
  "minecraft:lava",
  "minecraft:flowing_lava",
  "minecraft:beacon",
  "minecraft:conduit",
  "minecraft:glow_lichen",
]);
