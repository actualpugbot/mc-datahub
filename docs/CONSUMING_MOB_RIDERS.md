# Consuming `mob-riders.json` (riding / passenger system)

This guide shows how to display any rider-on-mount pair — the natural jockeys
(chicken jockey, spider jockey, …), player-rideable mounts (horse, camel, pig,
strider, happy ghast, boats, minecarts), or an arbitrary pair — using the
`mob-riders.json` collection. Everything is source-derived from the decompiled
client; the numbers below are 26.2 values and the JSON re-extracts them per
version.

## 1. Where the data lives

- **Static bundle**: `minecraft-data/<version>/mob-riders.json`
- **Images**: `minecraft-data/<version>/mob-riders/images/<pair>__rider.png` / `__mount.png`

Shape:

```jsonc
{
  "version": "26.2",
  "generatedAt": "…",
  "mechanics": { "positioning": {…}, "rules": {…}, "display": {…} }, // the global system, prose + constants
  "entities": {
    // EVERY entity type (158), so any pair can be composed:
    "happy_ghast": {
      "class": "HappyGhast",
      "width": 4.0, "height": 4.0, "eyeHeight": 2.6,
      "passengerAttachments": [            // one entry per seat, vehicle-local space
        { "x": 0, "y": 4, "z": 1.7 },      // seat 0 = driver (front)
        { "x": -1.7, "y": 4, "z": 0 },
        { "x": 0, "y": 4, "z": -1.7 },
        { "x": 1.7, "y": 4, "z": 0 }
      ],
      "passengerAttachmentsSource": "builder",   // "builder" | "fallback-top-of-hitbox"
      "vehicleAttachment": { "x": 0, "y": -0.5, "z": 0 }, // where THIS entity's body meets a seat when IT rides
      "vehicleAttachmentSource": "builder",      // "builder" | "fallback-feet"
      "maxPassengers": 4,
      "controlledBy": { "controller": "player", "requiresHarness": true },
      "saddle": { "slot": "body", "condition": "alive && !baby" },
      "playerSteerable": true,
      "babyAgeScale": 0.2375,                    // only present when it differs from the 0.5 default
      "overrides": { "canAddPassenger": "HappyGhast", … } // class name -> look up in overrideSources
    }, …
  },
  "overrideSources": {
    // verbatim Java for every override referenced above, for the seat math
    // the registry can't express (boats, camel, strider bob, slimes, …)
    "AbstractBoat": { "file": "vehicle/boat/AbstractBoat.java", "methods": { "getPassengerAttachmentPoint": { "line": 135, "code": "…" }, … } }, …
  },
  "riders": [ /* the 6 natural jockey pairs, with spawn chance + images (see §6) */ ]
}
```

## 2. The one formula

A passenger's position is **not** a render-time trick — the game moves the
rider entity onto the seat every tick, and the renderer draws it there like any
other entity. Reproduce it as:

```
seatWorld  = mountPos + rotateY(mount.passengerAttachments[seatIndex], -mountYawDeg)
riderPos   = seatWorld - rotateY(rider.vehicleAttachment, -riderYawDeg)
```

- `seatIndex` = the rider's index in the passenger list, clamped into the seat
  list (a 2nd passenger on a 1-seat mount reuses seat 0).
- `rotateY(p, -deg)` rotates the point around +Y by minus the yaw in degrees
  (Minecraft yaw is clockwise).
- `riderPos` is the rider's **feet** (entity origin), exactly like the mount's.
- Everything is in blocks.

Defaults when a field came from a fallback: seats default to the top of the
hitbox `(0, height, 0)`; `vehicleAttachment` defaults to the feet `(0,0,0)`.
The player is the notable non-zero case: `vehicleAttachment (0, 0.6, 0)`, i.e.
a seated player sinks 0.6 blocks into the seat point.

### Scale (babies, SCALE attribute)

Attachment points live inside the entity's dimensions, and dimensions are
pre-scaled by `ageScale × SCALE-attribute`. So:

- **Baby mount** → multiply the mount's `passengerAttachments` by its baby
  scale (`babyAgeScale` if present, else `mechanics.rules.defaultBabyAgeScale`
  = 0.5) — on x, y **and** z.
- **Baby rider** → multiply the rider's `vehicleAttachment` the same way
  (chicken-jockey baby zombies: `(0, 0.7, 0) × 0.5 = (0, 0.35, 0)`).
- Only living mounts scale their seats; boats/minecarts always use raw values.

### Code-computed seats

When `entities[mount].overrides.getPassengerAttachmentPoint` is set, the
static point is only the baseline; the class in `overrideSources` adjusts it.
The ones that matter for a static viewer:

| Mount                                  | What the code does                                                                                                               | Static-render advice                    |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| boats/rafts (`AbstractBoat`)           | seat y = `height/3` (boat) or `height×8/9` (raft); with 2 passengers z = `+0.2` (front) / `−0.6` (back), `+0.2` more for animals | use these instead of the fallback point |
| `Camel`                                | 2 seats: z = `+0.5` (driver) / `−0.7`; y is animation-driven (standing ≈ `height − 0.375`)                                       | y ≈ 2.0, z per seat                     |
| `Strider`                              | adds a walk-bob of `±0.12 × 2 × min(0.25, walkSpeed)` on y                                                                       | ignore when standing still              |
| `AbstractHorse`                        | shifts seat up/back only during the rearing animation                                                                            | ignore                                  |
| slimes/magma cubes (`AbstractCubeMob`) | seat y = `height − 0.015625 × size`                                                                                              | compute from size                       |
| minecarts (`AbstractMinecart`)         | villagers/wandering traders sit at `(0,0,0)` instead of the 0.1875 seat                                                          | special-case                            |

## 3. Posing the rider model (3D, `mob-models.json` bones)

- **Humanoid riders** (zombie, skeleton, piglin, player, drowned, …) and
  **illagers** switch to the riding pose (radians, from
  `mechanics.display.humanoidRidingPose`):
  - both arms: `xRot += −π/5` (illagers: set to −π/5)
  - legs: `xRot = −1.4137167`, `yRot = ±π/10` (right +, left −), `zRot = ±0.07853982`
- **Zero the walk animation** of any passenger — the game does.
- Non-humanoid riders (baby striders, skeletons' spider mount etc.) have no
  riding pose; render them in idle.

### Rotations

- Rider **body yaw = mount body yaw** is the correct static default. In game
  the head may deviate ±85° (render-side clamp on living mounts), boats clamp
  the whole rider to ±105° logic-side, and steered mounts copy the rider's yaw
  anyway — aligned is always right for a still shot.
- An **animal in a full boat** sits side-saddle: body yaw turned 90° or 270°.

### Baby riders

Use the baby geometry, not a uniform half-scale: body parts at half size
shifted down 24 model units, head near full size (`mechanics.display.baby`).
If you only have the adult model, a uniform `ageScale` (0.5) at the seat is a
reasonable approximation — the seat position stays correct either way because
the `vehicleAttachment` scales with the rider.

### Mount-side extras

- Saddles/harnesses are equipment layers on the mount (pig, strider, horses,
  camel, donkey/mule, nautilus, happy ghast); reins show only while ridden.
  `entities[*].saddle` tells you the slot and who can wear one.
- The chicken renders completely unchanged under a jockey.
- The strider stops pitching its body while ridden.

## 4. The rules (who can ride what)

From `mechanics.rules` + per-entity fields:

- Default capacity is **1 passenger**; `maxPassengers` overrides (boat 2,
  chest boat 1, camel 3-by-code but 2 by player interaction — see
  `playerMountCap` — happy ghast 4).
- `controlledBy` says who steers: boats = first living passenger; horses/
  camels/nautilus = a **player** on a **saddled** mount; pig/strider
  additionally need the `controlItem` (carrot / warped fungus on a stick);
  happy ghast needs its body-slot harness. Absent `controlledBy` + a `Mob`
  mount = the first mob passenger steers (that's how jockeys walk).
- Mounting: riders can't board while sneaking or within the 60-tick
  boarding cooldown after dismounting; no riding cycles; a boarding player is
  moved to the front (driver) seat.
- `saddle.condition` is the equip gate (`alive && !baby`, horses/nautilus also
  `tamed`). 26.x has **no Saddleable interface** — saddle = the SADDLE
  equipment slot, happy-ghast harness = BODY slot.

## 5. Worked example — chicken jockey

```js
const { entities, mechanics } = riders;
const chicken = entities.chicken; // seat (0, 0.7, -0.1), builder
const zombie = entities.zombie; // vehicleAttachment (0, 0.7, 0)
const baby = mechanics.rules.defaultBabyAgeScale; // 0.5

// mount at origin, both facing yaw 0:
const seat = chicken.passengerAttachments[0]; // (0, 0.7, -0.1)
const va = zombie.vehicleAttachment; // (0, 0.7, 0) * 0.5 (baby rider)
const riderFeet = {
  x: seat.x - va.x * baby, // 0
  y: seat.y - va.y * baby, // 0.7 - 0.35 = 0.35
  z: seat.z - va.z * baby, // -0.1
};
// render the BABY zombie model at riderFeet with the humanoid riding pose.
```

## 6. 2D composites (`riders[]` + images)

The `riders` array is the six natural jockey pairs (spawn `chance`, `guard`
line, `riderIsBaby`, source file) with pre-picked canonical images. To
composite in 2D: scale the two images to their hitbox proportions
(`riderDimensions` / `mountDimensions`, rider × `riderScale`), then place the
rider so its feet sit at `mountDimensions.passengerAttachment.y −
riderDimensions.vehicleAttachment.y × riderScale` above the mount's feet, with
the z offset shifting the rider toward the mount's head (negative z = toward
the tail). `mountSeatOverride` warns you when the seat is code-adjusted (see
the table in §2).

## 7. Regenerating

```
node scripts/build-mob-riders.mjs [version]   # default 26.2
```

Reads `workspace/versions/<v>/decompiled/client`, writes
`workspace/datasets/<v>/mob-riders.json` + `mob-riders/images/`. All numeric
constants (boarding cooldown, clamps, pose angles, baby transform) are
re-extracted from the source each run; drift shows up as `warnings` in the
payload instead of silently stale numbers.
