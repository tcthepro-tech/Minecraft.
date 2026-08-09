# Notice — design specification

Everything in this pack reads one number. That is the whole architecture, and
it is the reason the dread scales instead of spiking.

---

## 1. The spine: `notice`

Every player carries a hidden float in `[0, 100]`, stored as the dynamic
property `nx:notice`. A second property, `nx:floor`, is a ratchet: it tracks
45% of the highest notice ever reached, only ever rises, and notice can never
decay below it.

`notice` does not control aggression. **It controls permitted distance.** High
notice does not make the Watcher attack — there is no attack. It shrinks the
radius at which the world is willing to let it stand.

### Accrual, per second

| Source | Rate | Notes |
|---|---|---|
| Solitude | +0.018 | No other player within 48 m. Ramps ×1 → ×2.2 over 15 minutes alone |
| Depth | +0.026 max | Begins at y=48, full weight at y=−40 |
| Darkness | +0.038 | No sky access, or sky at night, and no light source within 5 m |

### Trespass, event-driven

| Event | Gain |
|---|---|
| First block broken in a chunk this session, below y=45 | +1.8 |
| Breaking a block with solid neighbours on all six faces | +0.6 |
| Opening an Aperture reliquary | **+22** |
| Each 2 seconds of sustained observation of the Watcher | +1.4 |

The enclosed-rock rule is quieter than it looks. Digging a tunnel does not
trigger it, because the block behind you is already air — only genuinely sealed
rock counts, which is exactly the "you made this space, it was never open"
feeling the mechanic is after.

### Decay, per second

| Source | Rate |
|---|---|
| Genuine daylight (sky access, daytime) | −0.22 |
| Another player within 24 m | −0.12 |
| A villager within 16 m | −0.07 |
| A light source within 5 m | −0.05 |
| Ambient bleed, always | −0.008 |

### The ratchet

Decay stops at the floor. The floor only rises. Dying releases the current
charge down to the floor and no further, so a second descent begins where the
first one ended. The tallow candle is the only effect in the entire pack that
lowers the floor, at −0.02/s while lit.

### Measured curve

Alone, dark, y=−20, not mining — regression-tested in `tools/harness/sim.mjs`:

| notice | reached at | what changes |
|---|---|---|
| 14 | 3.3 min | The Watcher is permitted to exist |
| 18 | 4.2 min | Fog tier 1; ambient audio begins |
| 38 | 8.5 min | Fog tier 2; Apertures may generate; the Kindler becomes possible at 45 |
| 58 | 12.6 min | Fog tier 3; heartbeat begins at 62; placement behind the player unlocks at 55 |
| 80 | 16.7 min | Fog tier 4; permitted radius ~10 m |

Mining shortens all of this considerably — a long exploratory tunnel crosses a
chunk boundary every sixteen blocks.

---

## 2. The Watcher

### Permitted distance

```
radius = 34 − 28 · (notice / 100) ^ 0.85
```

then multiplied by `1 + 0.18 · stealthTier`, and clamped to never come closer
than 4.5 m regardless of what the curve says.

| notice | 0 | 20 | 40 | 60 | 80 | 100 |
|---|---|---|---|---|---|---|
| permitted | 34 m | 26.9 m | 21.1 m | 15.9 m | 10.8 m | 6 m |

At notice 90 the boundary sits at 8.4 m for a tier-0 Watcher and 14.4 m for a
tier-4 one. Staring pushes it away. That is the point.

### The loop

Runs per tracked player on a randomised 20–40 tick interval, never per frame,
and only one instance exists per player at a time.

1. **Select anchor.** Sample 18 candidate positions on a circle at the
   permitted radius (±2 m). For each, walk down the column to find the first
   surface with three blocks of headroom.
2. **Score.** Reject anything closer than 4.5 m, anything outside the edge band
   of the view cone (dot 0.30–0.85), and anything currently visible to *any*
   player. Prefer partial occlusion — head clear, body swallowed — then
   framing (solid blocks flanking the head, which is what makes a doorway read
   as deliberate), then darkness, then distance fidelity. At stealth tier 2 and
   above, a fully exposed candidate is rejected outright.
3. **Verify unobserved.** Before moving, raycast from every nearby player's eyes
   to three points on the Watcher's current silhouette. If any ray lands, abort.
   The destination was already proven unwatched in step 2; this proves the
   *departure* is too.
4. **Teleport, don't walk.** `movement.speed` is 0 and the behaviour file
   contains no navigation or behaviour components at all. It is physically
   incapable of walking. Gravity is off so it cannot drift or settle.
5. **Freeze on sight.** The instant a raycast connects it stops doing anything.
   It turns to face the observer exactly once, at placement, and never again —
   there is no `look_at_target` animation and no head tracking, so the pose is
   frozen by construction rather than by a state flag.
6. **Reward staring with absence.** Sustained observation adds notice every 2
   seconds. After 6 seconds of it, the Watcher is marked ready to leave — and
   vanishes on the first frame nobody can see it, incrementing its stealth tier.
   Higher tiers appear further away, insist on more cover, last less long
   (1200 → 380 ticks) and stay away longer afterwards (200 → 1000 ticks).
7. **Never engage.** No aggro state, no damage, no pathfinding, no sound on
   appearance. `damage_sensor` denies every cause; it cannot be hurt, burned,
   drowned or pushed.

Above notice 55, anchors behind the player unlock. Below that it may only be
placed in peripheral vision.

### Multiplayer

Step 3 checks *every* nearby player, not just the tracked one. A second player
standing off to the side vetoes the teleport just as effectively as the first,
so nobody can be positioned to catch it repositioning. Each player has their
own Watcher instance and their own notice value.

The observation cone is deliberately wider than Bedrock's real horizontal FOV
(63° half-angle against roughly 51°). A false positive costs nothing — the
Watcher simply holds still for another cycle. A false negative would let a
player watch it teleport, which is the one failure the entity cannot survive.

### Geometry

`geometry.nx_watcher`, 128×128 texture, 41 cubes across 42 bones, 53 model
units from hoof to horn tip (3.3 blocks). `minecraft:scale` brings the Watcher
to 0.9 — just under three blocks, so it fits the same cave ceiling a player
does and the anchor finder only has to guarantee three blocks of headroom.
The Gaunt scales the identical geometry to 3.0.

Both the geometry and its textures are generated by `tools/gen_creature.py`
from one shared spec. Hand-packing 41 UV rectangles onto a sheet and then
hand-painting them in a separate file is how you get silent misalignment; here
the packer assigns every rect and hands the same rects to the painter along
with a material name, so the two cannot drift apart.

| Group | Detail |
|---|---|
| Skull + maw | 8×7×8 cranium, with a 7×7×7 jaw hinged at the **back** of the skull so it swings down and away, opening the whole face rather than dropping a chin |
| Mask | A one-texel-thick pale plate over the front of the skull, split along the jaw line into `mask` (upper) and `grin` (lower, parented to the jaw) |
| Horns | Two three-segment horns curving outward, each segment inheriting the last one's rotation so three modest angles compound into a real curve, plus a forward-angled spur each side |
| Hair | A shaggy cap over the cranium and lank strands down both sides, with ragged alpha along the bottom edges |
| Torso | 10×13×6 ribcage over an 8×6×5 pelvis |
| Arms | 15-unit upper and forearm, a short palm, and three fingers each **longer than the palm** |
| Legs | Digitigrade: thigh forward 11°, shin back 29°, then a long narrow hoof forward 19° |
| Spikes | Shoulders, elbows and knees |

The proportions are human enough to parse as a person at a glance and wrong
enough to be unpleasant on the second: the backward joint at mid-leg is what
makes the Gaunt's walk read as incorrect rather than merely slow.

### Texture

Two palettes over the same layout. The Watcher lives underground and stays dark
enough to read as a silhouette in fog; the Gaunt is seen against sky at eighty
blocks, so it is paler and greyer or it disappears into the treeline.

The face is where the detail budget goes. Eight texels across is not much, so
the read is carried by three shapes only: two huge round whites with a single
dark pupil each — set one texel inboard, so the stare converges slightly in
front of you — dark sockets around them, and a full row of teeth along the
bottom edge that meets the grin plate's row exactly at the jaw line. Hairline
crazing runs across the plate like old porcelain. Anything subtler than this
is mush at Minecraft resolution.

Material is `entity_alphatest`, which is what lets the hair be ragged.

### Animation

The Watcher has exactly one animated state, and it is gated hard: above notice
72, after a full three seconds of being stared at, with a 35% chance, the maw
opens. Silently. The grin tears in half — the upper teeth stay on the face, the
lower row swings away with the jaw — and what is behind it is throat.

Everything else about the model is frozen. There is no idle, no sway, no head
tracking, no `look_at_target`. The resting animation holds the jaw three
degrees ajar and does nothing else, so zero drift is a property of the resource
pack rather than a state the script has to maintain.

State is carried by the entity property `nx:maw`, read by
`controller.animation.nx_watcher` through `q.property`. Entity properties are
the only channel from script to the client renderer; `setProp` degrades to "the
animation never plays" if the API is unavailable rather than throwing.

---

## 3. The Gaunt

The same geometry at 3.0 scale — roughly ten blocks — walking the horizon.
It is the payoff for reaching the top of the curve and the only thing in the
pack that moves under its own power in plain sight.

**It never approaches.** Its initial heading is perpendicular to the player, so
it crosses your field of view rather than closing on it, and `MIN_DISTANCE` is
re-checked on *every stride*: if the next step would bring it inside 45 metres
it curves away instead. That floor is the entire reason it is safe to show. The
shape you are watching cross the treeline is a shape that cannot arrive.

Movement is script-driven teleports of `1.6 / 20` blocks per tick, on the fast
loop. At that granularity teleporting is indistinguishable from walking, and it
keeps the path entirely under script control — the entity itself still has
`movement.speed` 0 and no navigation components, exactly like the Watcher.

It follows terrain but will not scramble: a step onto ground more than three
blocks up or down makes it turn instead.

Watch it for four and a half seconds and it stops walking, turns to face you,
and never does anything else. It leaves on the first frame nobody is looking.

Appears above notice 70, under open sky only, roughly every seven and a half
minutes, with a ten-minute enforced absence afterwards.

The walk cycle is 3.6 seconds a stride — deliberately slow. At ten blocks tall
a normal cadence reads as scuttling, and scuttling is not what this is.

## 4. The supporting pair

Both read `notice` and hold no escalation state of their own.

### The Hollow — pressure

An invisible, collisionless marker with an empty geometry. It spawns strictly
behind the player (cone dot < −0.25) at 3–9 m, in a spot no player can see,
plays one vanilla sound at low volume and unusual pitch, often a second beat
9–16 ticks later so it reads as a stride rather than a knock, and removes
itself after 70 ticks.

There is never anything there when you turn around, because there was never
anything there. The player supplies the figure.

Active above notice 26. Interval scales from 55 seconds down to 12.

### The Kindler — release

A hooded figure with a small flame, rendered with `entity_emissive_alpha` so
only the flame glows. It stands still. It never approaches, never speaks, and
never follows.

Within 7 m it burns notice at −1.6/s — seven times faster than daylight — which
makes it the only practical way down once things are genuinely bad. But close
faster than 5.2 blocks/second inside that radius and it gutters out, costing
you 2.5 notice. Relief you have to approach carefully.

Appears above notice 45, roughly every 150 seconds, at 14–26 m. Lives for two
minutes.

The figure itself is as dark as the Watcher. You have to get close enough to
see whether there is a flame before you know which one you found.

---

## 5. Incidents

Eleven one-shot events in `events.js`, drawn from a weighted pool. Three rules
they all obey, enforced by the harness:

- **Nothing damages the player.** Not one of them.
- **Nothing is destructive.** No incident places or breaks a block.
- **Nothing announces the Watcher.** An event that reliably preceded an
  appearance would teach the player to read the tells, and the moment the
  player can predict it, it stops working.

Each declares the notice band it lives in, so the vocabulary grows with the
curve instead of everything being available at once. The last three drawn are
excluded from the next draw.

| Incident | From | What happens |
|---|---|---|
| `settle` | 12 | The cave shifts, two to four beats, pitched down |
| `doorway` | 20 | A door opens and closes where you have not built a door |
| `rummage` | 26 | Something opens a container. There is no container |
| `hush` | 30 | The ambient bed cuts out completely for eight seconds |
| `breath` | 36 | Close, behind, at the wrong pitch to be anything you know |
| `shudder` | 42 | A tremor with no source (`camerashake`, well under a jolt) |
| `guttering` | 48 | Every light goes out for three seconds — the Darkness effect, so the torches are still burning when it lifts |
| `namecall` | 55 | Your own name on the action bar |
| `closer` | 60 | The Watcher relocates to the very floor of its range |
| `gape` | 72 | If it is in front of you right now, it opens its mouth |
| `chorus` | 84 | Three more appear in a ring, unobserved, gone within ten seconds |

`closer` relaxes the *target radius*, not the safety rules: the relocation
still goes through `selectAnchor`, which still refuses any position a player
can see and still refuses to come inside `MIN_ABSOLUTE`. An incident may make
the Watcher bolder. It may never make it visible in motion.

Interval scales from 200 seconds at the threshold down to 45 at maximum notice.

## 6. Structures

Script-generated rather than shipped as `.mcstructure`, specifically so that
placement can be gated on notice. A fresh world contains none of them.

A 7 × 4 × 7 room shelled in deepslate tile, with a free-standing polished
blackstone doorway on the centre line and a chest set into its mouth. The
doorway leads nowhere. That is the entire idea of the room.

**Placement rules.** Only below y=38, only above notice 40, only 28–56 m from
the player, only in volumes that sample ≥90% solid, and never within 90 m of a
known site. Any chest, torch, bed, door, furnace, crafting table, spawner or
portal in the sampled volume rejects the site outright — apertures cut into
rock, never into somebody's base.

Attempted once every ~90 seconds per player, with a 5%–30% chance scaling on
notice. The world remembers the last 40 sites in a dynamic property.

Apertures generated beneath an open cave are working as intended: you are meant
to find one by mining into it, which is itself a trespass event.

**The reliquary** holds tallow candles, bone, string, candles, soul sand, gold
nuggets, and occasionally an echo shard or a name tag. It is deliberately not
worth +22 notice. Opening it is a choice, not a reward.

### The Ossuary

Shallower and commoner: a 5×3×5 chamber shelled in deepslate, floored in bone
block, with bone stacked floor-to-ceiling in the corners and a chest worth +8
notice. Available from notice 26 and up to y=48, so it is usually the first
structure a player ever finds. Its job is to make the deep feel *occupied*
rather than empty — somebody stacked these.

### The Effigy

The only structure the pack puts where daylight can reach it. Five basalt
pillars in a ring of radius 4, some chained, around a five-block centre post
topped with a skull, with soul soil trodden into the ground inside the ring.

Surface placement has its own site test: the ground must be flat to within
three blocks across the whole footprint, there must be open sky four blocks
above every column, and nothing man-made may be underfoot — planks, bricks,
glass, wool, chests, doors and torches all reject the site.

Which structure gets attempted is decided by *where the player is*, not by a
roll. A player who never goes underground will only ever meet effigies; a
player who never surfaces will never see one.

---

## 7. Atmosphere

### Fog

Four `.json` fog definitions pushed and popped through `/fog @s push nx:dread_N
nx_dread` on tier change. Fixed distances, not render-distance multipliers, so
the boundary is a promise rather than a setting.

| Tier | notice | start | end | colour |
|---|---|---|---|---|
| 1 | 18 | 34 m | 150 m | `#0b0c11` |
| 2 | 38 | 22 m | 96 m | `#08090d` |
| 3 | 58 | 12 m | 58 m | `#05060a` |
| 4 | 80 | 5 m | 30 m | `#020306` |

The fog end tracks the permitted radius. At maximum notice you cannot see
further than the distance at which it is allowed to stand.

### Audio

The pack ships no `.ogg` files. Every sound is a vanilla Bedrock event played
at an unusual pitch, which means nothing here can ever sound like *a mod
sound* — it all sounds like the game, played slightly wrong.

`ambient.cave`, `dig.stone` and `dig.gravel` form the base bed. Above pressure
0.35 `mob.warden.listening` joins; above 0.55, `mob.warden.nearby_close` and
`random.door_close`. Sounds are emitted from a random point 5–18 m away — the
radius closing as notice rises — never from the Watcher's actual position.

**No cue is ever tied to the Watcher's arrival.** A sting on spawn would teach
the player that silence means safety, and the pack would collapse into a
jumpscare generator.

The heartbeat (`mob.warden.heartbeat`) begins at notice 62 and accelerates from
34 to 15 ticks between beats. It runs on a separate per-tick loop, because a
heartbeat quantised to one second sounds like a metronome instead of a pulse.

A stare has exactly one perceptual consequence and it is subtractive: the
ambient bed drops out for six seconds. Looking at it makes the world quieter.

### Text

Five action-bar lines, fired only on upward tier crossings, never on a timer.
None of them names the entity.

---

## 8. Counterplay

Four ways down the curve, in ascending order of cost: daylight, company, light,
the Kindler. All four are listed with their rates in the README.

One way to move the ratchet itself. The **tallow candle** — string over two
honeycomb, yields two — multiplies all accrual by 0.35 for six minutes and
decays the floor at 0.02/s while lit. It is the only floor-lowering effect in
the pack.

Averting your eyes is also counterplay, and it is free. Sustained observation
is the single fastest way to raise notice that does not involve opening a
reliquary.

---

## 9. Technical notes

### Performance

The model runs once a second per player, not per frame. Costs per player-second:

- **Light scan:** ~122 block reads. The scan is exhaustive over a 11×6×11 box
  but amortised across four seconds. A stepped lattice was the original
  implementation and was wrong — stepping by two only samples one parity, so a
  torch one block off the lattice is not "usually missed", it is *never* found.
- **Sky check:** one `getTopmostBlock`.
- **Villager query:** one `getEntities`.

Anchor selection is the expensive operation — a few hundred block reads and a
few dozen raycasts, all inside a single tick. Two mitigations:

- Candidates are rejected on distance and cone alignment *before* any raycast
  is fired. Roughly two thirds die there, and each one saves three raycasts per
  nearby player.
- Searches are rationed globally to one per tick. Randomised per-player cadence
  usually keeps them apart, but "usually" is not a guarantee, and on a full
  server the collisions are precisely what a player feels as a stutter.

### Failure modes

Every world access is wrapped. `getBlock` and `getBlockFromRay` throw on
unloaded chunks constantly at the edge of simulation distance; swallowing the
throw and treating the result as unusable is correct, because an unloaded chunk
is somewhere the Watcher may not stand anyway. Each subsystem's per-player work
is individually guarded so one player's bad tick cannot stall the loop for
everyone else.

`isValid` is a method on older script API builds and a property on newer ones;
the code handles both.

### Reload safety

In-memory state does not survive a world restart, so on boot the pack sweeps
all three dimensions and removes any pack entity without a live owner.

### Testing

`tools/harness/` resolves `@minecraft/server` to a stub and runs the pack's
real scripts, unmodified, against a simulated voxel world. The stub's
`getBlockFromRay` is a genuine Amanatides–Woo traversal of a genuine grid — a
stub that faked line of sight would prove nothing, since the invariant is
decided entirely by raycasts.

Seven scenarios, ~410 assertions per run:

1. **The invariant.** Two players wander and turn at different speeds for 8000
   ticks. Every position change and every removal is checked against whether
   the Watcher was observable in that frame. Typically ~350 relocations and
   ~400 frames under observation per run.
2. **Permitted distance.** Monotonic in notice; tier pushes it back out; the
   floor ratchets and notice never returns to zero.
3. **Environment response.** Solitude and darkness accrue; daylight decays; a
   nearby torch slows accrual. This is the test that caught the light-scan
   parity bug.
4. **Aperture placement.** Generates in buried stone, fills every reliquary,
   and consumes 0% previously-open air near a cavern.
5. **The escalation curve.** Pins minutes-to-tier, so a careless tweak to any
   accrual constant fails a test rather than shipping a pack that tops out in
   five minutes.
6. **The Gaunt.** Spawns under open sky, actually walks (~490 stride ticks),
   never comes inside its 45 m floor whatever the terrain does to it, and halts
   when stared at.
7. **Incidents.** Silent below the threshold, more frequent as notice rises,
   never move the player, and change zero blocks across twenty minutes at
   maximum notice.

`tools/validate.py` catches the structural mistakes Bedrock fails silently on —
a mistyped geometry identifier gives you an invisible entity and no error
anywhere. It checks UUID uniqueness, pack dependencies, that every behaviour
entity has a client counterpart, that every geometry/texture/controller/
animation reference resolves, that no cube's UV unwrap runs past its texture,
that every fog id named in `config.js` exists, that no animation controller
transitions to a state it does not define, and that every animation short name
a controller plays is one the entity actually declares.
