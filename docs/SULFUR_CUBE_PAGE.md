# Sulfur Cube page — data & build guide (for pugtools.com)

This is everything you need to build a page that breaks down **how a Sulfur Cube behaves depending on the
block it swallows** (Minecraft Java 26.2+). All numbers below are extracted straight from the game files by
`mc-datahub`; nothing is hand-authored. You decide what to render — this doc describes the full data contract.

## 1. Where the data comes from

`mc-datahub` produces a `sulfur-cube` collection per game version. Three equivalent ways to get it:

| Method | What you get |
| --- | --- |
| **HTTP** `GET /versions/{version}/sulfur-cube` | `{ version, total, count, limit, offset, sulfurCube: [ <dataset> ] }` — the dataset is the single element of the `sulfurCube` array. CORS-enabled, read-only. |
| **File** `workspace/datasets/{version}/sulfur-cube.json` | `{ version, generatedAt, ...<dataset> }` — the dataset flattened at top level. |
| **CLI** `mc-datahub dump collection sulfur-cube {version} --output sulfur-cube.json` | The bare `<dataset>` object. |

The same object is also embedded at `GET /versions/{version}/dataset` under the `sulfurCube` key. Use
`GET /versions` to list versions that have a processed dataset. OpenAPI lives at `GET /openapi.json`.

> The `<dataset>` object is identical in all three; only the wrapper differs (HTTP nests it in `sulfurCube[0]`).

## 2. The `<dataset>` shape

```jsonc
{
  "entity": { /* static, block-independent facts about the mob */ },
  "behaviorModel": [ "…factual sentence…", … ],   // how swallowing + behavior-swap works
  "baseAttributes": [ /* the cube's complete base AttributeSupplier */ ],
  "immunitiesWhenHoldingBlock": [ "minecraft:fall", … ],  // damage types a block-wearing cube ignores
  "hotDamageType": { /* the bespoke damage type the "hot" archetype deals */ },
  "archetypes": [ /* the 12 behavior profiles — THE CORE OF THE PAGE */ ],
  "blockIndex": { "minecraft:dirt": "regular", … },  // reverse lookup: block id → archetype key
  "sourcePaths": [ … ],   // provenance: game files this was derived from
  "warnings": []          // non-empty only if extraction couldn't resolve something
}
```

### 2a. `entity`

```jsonc
{
  "id": "minecraft:sulfur_cube",
  "displayName": "Sulfur Cube",
  "spawnBiome": "minecraft:sulfur_caves",
  "fullSize": 2, "babySize": 1,
  "healthPerSize": 4,                 // maxHealth = healthPerSize × size → 8 (full), 4 (baby)
  "temptRange": 8,
  "splitCount": 2,                    // a killed full cube splits into 2 babies
  "pickupTimerTicks": 100,            // after shearing, ignores items for this many ticks
  "experienceReward": { "min": 1, "max": 2 },
  "bucketItem": "minecraft:sulfur_cube_bucket",
  "spawnEggItem": "minecraft:sulfur_cube_spawn_egg",
  "contentComponent": "minecraft:sulfur_cube_content",
  "particle": "minecraft:sulfur_cube_goo",
  "foodItems": ["minecraft:slime_ball"],           // babies eat this to grow / breeding
  "swallowableTag": "minecraft:sulfur_cube_swallowable",
  "shearable": true, "bucketable": true,
  "textures": ["images/entity/sulfur_cube/sulfur_cube_outer.png", …]  // servable, see §3
}
```

### 2b. `archetypes[]` — the heart of the page

One entry per behavior profile (12 in 26.2). The cube adopts exactly one archetype at a time, chosen by
which archetype's block list contains the block it swallowed.

```jsonc
{
  "id": "minecraft:bouncy",
  "key": "bouncy",
  "displayName": "Bouncy",
  "behavior": {                 // human-oriented, page-ready numbers (see interpretation below)
    "mobility": 2,              // how far/fast it gets shoved when hit or bumped (= −knockback_resistance)
    "bounciness": 0.9,          // 0..1, higher = bouncier
    "friction": 0.3,            // lower = more slippery / slides; higher = grippy/sticky
    "airDrag": 0.01             // lower = keeps momentum & flies further; higher = damps quickly
  },
  "attributeModifiers": [       // the RAW modifiers, exactly as the game applies them (for full fidelity)
    { "attribute": "minecraft:bounciness", "amount": 0.9, "operation": "add_value", "id": "minecraft:bouncy_add_bounciness" },
    …
  ],
  "buoyant": true,              // floats on water/lava while holding a block
  "explosive": false,          // true only for the "explosive" archetype
  "dealsContactDamage": false, // true only for the "hot" archetype
  "explosion": null,           // when explosive: { "power": 3, "causesFire": false, "fuse": 120 } (fuse in ticks)
  "contactDamage": null,       // when hot: { "damageType": "minecraft:sulfur_cube_hot", "amount": 1, "attributeToSource": false }
  "knockback": { "horizontalPower": 0.4125, "verticalPower": 0.105 },  // knockback it imparts
  "sound": {
    "hit": "minecraft:entity.sulfur_cube.bouncy.hit",
    "push": "minecraft:entity.sulfur_cube.bouncy.push",
    "pushCooldownSeconds": 0.7,
    "pushImpulseThreshold": 0.3
  },
  "itemsTag": "#minecraft:sulfur_cube_archetype/bouncy",  // the game tag that selects this archetype
  "blockTags": ["#minecraft:planks", "#minecraft:logs", "#minecraft:bamboo_blocks"],  // nested tags, for reference
  "blocks": [                  // FULLY EXPANDED, sorted, with display names — render these
    { "id": "minecraft:acacia_log", "name": "Acacia Log" }, …
  ],
  "blockCount": 59,
  "sourcePath": "data/minecraft/sulfur_cube_archetype/bouncy.json"
}
```

**Interpreting `behavior`** (base bounciness/knockback are 0 and base friction/air-drag are 1, so these
numbers ARE the cube's effective attribute values while holding a matching block):

- `mobility` = `−knockback_resistance`. Higher → the cube is knocked around more easily (feels light/zippy);
  negative → it resists being moved (heavy). Range across archetypes: `−0.8` … `2`.
- `bounciness` 0..1: 0 = no bounce (sticky), 1 = maximum bounce (light).
- `friction`: `< 1` slides (ice-like), `1` neutral, `> 1` grippy (sticky = 2).
- `airDrag`: `< 1` glides/keeps momentum, `> 1` gets damped fast (light = 1.8 → floaty & slow).

If you want to show the exact game math instead of the friendly numbers, use `attributeModifiers` (the two
knockback-resistance modifiers are always equal, which is why `mobility` collapses them into one).

### 2c. `baseAttributes[]`

The cube's complete base attribute supplier — every attribute the entity has, with its base value and clamp
range, in game builder order. Archetype `attributeModifiers` apply on top of these.

```jsonc
{
  "attribute": "minecraft:follow_range",
  "base": 16,               // value on the Sulfur Cube
  "min": 0, "max": 2048,
  "attributeDefault": 32,   // the attribute registry's own default
  "overridden": true,       // true when the cube sets a non-default base
  "note": "…"               // present on max_health (runtime 4×size override)
}
```

### 2d. `hotDamageType` and `immunitiesWhenHoldingBlock`

`immunitiesWhenHoldingBlock` is the list of damage type ids a cube ignores while wearing any block (fall,
arrow, explosions, etc. — it still gets knocked back). `hotDamageType` is the burning contact damage the
`hot` archetype applies: `{ id, effects: "burning", exhaustion, scaling, messageId }`.

## 3. Images

- **Sulfur Cube textures** — `entity.textures` are dataset-relative served paths. Fetch at
  `GET /versions/{version}/assets/{path}`, e.g.
  `…/assets/images/entity/sulfur_cube/sulfur_cube_outer.png` (there are `outer`/`inner` and `_small` variants
  for the full and baby cube). These are entity skins (UV atlases), not ready-made icons.
- **Block icons** — the archetype `blocks[]` give ids + names. `sulfur-cube.json` does not embed a block
  icon per block; join block ids to the existing `blocks` / `models` / `textures` collections (the "3D
  renderer consumer contract" in the main README) or reuse whatever block-render pipeline pugtools already
  has. Raw block textures are served at `…/assets/images/block/{texture}.png` (texture name, not block id —
  e.g. `magma_block` → `magma.png`), resolvable via `blocks.json` → `textureRefs`.

## 4. Suggested page structure

Everything below is a suggestion; the data supports other layouts.

1. **Header / explainer.** Sulfur Cube identity + the swallow mechanic. Pull the bullet sentences straight
   from `behaviorModel`. Show `entity` facts (spawns in Sulfur Caves, sizes/health, splits into 2, bucketable,
   shearable, eats slime balls).
2. **The 12 archetypes** (the main content). One card/section per `archetypes[]` entry:
   - Title = `displayName`; badges from `buoyant` (Floats), `explosive` (Explodes — show `explosion.power`/
     `fuse`), `dealsContactDamage` (Burns — show `contactDamage.amount`).
   - The four `behavior` numbers as bars/dials with the plain-English meaning from §2b.
   - `knockback` and `sound` if you want depth.
   - The **block gallery**: render `blocks[]` (icons + `name`), collapsible since some lists are large
     (`slow_bouncy` has 145). Show `blockCount`.
3. **"What happens if my cube eats ___?" lookup.** A search box over `blockIndex` (block id → archetype key),
   linking to that archetype's section. This is the most user-facing framing of "behavior depends on block."
4. **Reference / appendix.** `baseAttributes` table, `immunitiesWhenHoldingBlock` list, `hotDamageType`.

## 5. Worked examples

- **Block → behavior:** user searches "Magma Block" → `blockIndex["minecraft:magma_block"] === "hot"` →
  jump to the `hot` archetype → it `dealsContactDamage` (`1` burning damage), `buoyant`, mobility `1`.
- **Behavior → blocks:** "which blocks make the fastest-sliding cube?" → archetype `fast_sliding`
  (`friction 0.05`, `airDrag 0.01`) → `blocks` = blue ice, packed ice, snow block.
- **Effective stat:** a cube on `sticky` has `friction 2` on top of base `friction_modifier` (base `1`,
  `add_multiplied_total`), i.e. it barely slides at all; `bounciness 0` means it doesn't bounce.

## 6. Keeping it current

The collection regenerates automatically whenever a version is processed (`mc-datahub process version …`),
and can be refreshed standalone with `node scripts/regen-sulfur-cube.mjs {version}`. Point your ingest at the
version you want; if `warnings` is ever non-empty, that's a heads-up that a field couldn't be resolved for
that version (older/newer snapshots) rather than a silent gap.
