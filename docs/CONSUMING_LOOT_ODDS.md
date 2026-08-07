# Consuming `fishing-odds.json` and `loot-odds.json` (pugtools "what are the odds?")

This guide covers the two odds datasets: what is in them, what every probability
field actually means, and how to turn `fishing-odds.json` into a fishing guide
page without recomputing anything.

Everything in both files is **closed-form exact probability**. Weighted pools are
solved algebraically, multi-roll counts by convolution, probabilistic conditions
by exhaustive scenario enumeration. There is no Monte Carlo anywhere, so a number
you render is the number, not an estimate. Anything the pipeline could not derive
is reported as a `warnings` entry rather than filled in with a guess.

## 1. Where the data lives

- **Static bundle** (same layout as every other collection):
  `minecraft-data/<version>/fishing-odds.json` and
  `minecraft-data/<version>/loot-odds.json`
- **API**: `GET /versions/:version/fishing-odds` and
  `GET /versions/:version/loot-odds`. Both are single objects, exposed as
  one-entry collections for route consistency, so the payload is
  `{ "fishingOdds": [ … ] }` / `{ "lootOdds": [ … ] }`.
- **Types**: `import type { FishingOddsDataset, LootOddsDataset } from "mc-datahub/types"`.
- **Regenerating**: `node scripts/build-odds.mjs <version>` rebuilds both files
  from a workspace that has already been processed (dataset sidecars + decompiled
  client). It does not download or decompile anything and takes about three
  seconds.

Both files start with `version` and `generatedAt`, exactly like
`tree-features.json` and friends.

`fishing-odds.json` is pretty-printed (~1.2 MiB raw, ~40 KiB gzipped).
`loot-odds.json` is written compact on purpose (~1.0 MiB raw, ~140 KiB gzipped);
pretty-printing every mob, chest and gift table at every context is not worth the
bytes. Serve both gzipped and neither is a page-weight problem.

## 2. The two files at a glance

| file                | covers                                                                            |
| ------------------- | --------------------------------------------------------------------------------- |
| `fishing-odds.json` | `minecraft:gameplay/fishing` only, in full depth: mechanics, grid, scenarios, timing |
| `loot-odds.json`    | bartering, archaeology, gifts, mob drops, chest loot                                |

Fishing is **not** duplicated in `loot-odds.json`. Its `fishing` field is just a
pointer:

```jsonc
"fishing": { "tableId": "minecraft:gameplay/fishing", "dataset": "fishing-odds.json" }
```

Block drops (`minecraft:blocks/*`, 1113 tables in 26.2) are deliberately not
included. They are mostly one-item identity tables and would triple the file for
almost no value; evaluate them on demand from `loot-tables.json` if you ever need
them.

## 3. `fishing-odds.json`

```jsonc
{
  "version": "26.2",
  "generatedAt": "…",
  "tableId": "minecraft:gameplay/fishing",
  "mechanics": { … },   // the fishing loop, parsed from decompiled source
  "oddsGrid": { … },    // luck -4..10 x open/closed water, per item
  "scenarios": [ … ],   // 26 named presets pointing into the grid
  "timing": { … },      // expected seconds per catch, catches per hour
  "warnings": []
}
```

### 3.1 `mechanics` — the loop itself

Every field traces to a parsed line of `FishingHook.java`,
`FishingRodItem.java`, `EnchantmentHelper.java`,
`LootPoolSingletonContainer.java`, `Attributes.java`, `MobEffects.java`,
`BubbleColumnBlock.java`, or the `lure` / `luck_of_the_sea` / `gameplay/fishing`
JSON. On 26.2 `mechanics.warnings` is empty, which means nothing was assumed.

```jsonc
{
  "waitTime": {
    "baseRoll": { "minTicks": 100, "maxTicks": 600, "minSeconds": 5, "maxSeconds": 30, "outcomes": 501 },
    "lureApplication": "initial_roll_subtraction",
    "lureApplicationSource": "this.timeUntilLured = this.timeUntilLured - this.lureSpeed;",
    "countdownVariable": "fishingSpeed",
    "countdownBaseSpeed": 1,
    "rerollsWhenNonPositive": true,
    "teaseChance": { "baseChance": 0.15, "tiers": [{ "belowTicks": 20, "perTickBelow": 0.05 }, …] },
  },
  "rain": {
    "baseSpeed": 1,
    "checkOffsetY": 1,
    "rain": { "chance": 0.25, "speedDelta": 1, "condition": "level.isRainingAt(blockPos.above())" },
    "obstructedSky": { "chance": 0.5, "speedDelta": -1, "condition": "!level.canSeeSky(blockPos.above())" },
    "expectedSpeed": { "clearSkyVisible": 1, "rainingSkyVisible": 1.25, "clearSkyObstructed": 0.5, "rainingSkyObstructed": 0.75 },
  },
  "hookWindow": {
    "approachRoll": { "minTicks": 20, "maxTicks": 80, … },   // timeUntilHooked
    "catchableRoll": { "minTicks": 20, "maxTicks": 40, … },  // nibble
    "approachDecrementVariable": "fishingSpeed",             // same timer speed as the wait
    "nibbleDecrementPerTick": 1,                             // nibble ignores fishingSpeed
    "missedBiteResetsTimers": true,
  },
  "openWater": { … },      // see §7
  "luckSources": { … },    // see §6
  "lureSources": { "perLevel": [ … ], "secondsToTicks": 20, "truncatesToInt": true, … },
  "weightFormula": {
    "expression": "max(floor(weight + quality * luck), 0)",
    "entryIncludedWhenWeightGreaterThan": 0,
    "defaultWeight": 1,
    "defaultQuality": 0,
  },
  "lootTable": { "id": "minecraft:gameplay/fishing", "pools": [ … ] },
  "xp": { "minPerCatch": 1, "maxPerCatch": 6, "expression": "random.nextInt(6) + 1", "rodDamageOnCatch": 1, … },
  "sourcePaths": [ … ],
  "warnings": []
}
```

`lureSources.perLevel` is the per-Lure-level wait window, already derived:

```jsonc
{ "level": 3, "seconds": 15, "ticks": 300,
  "rawWaitMinTicks": -200, "rawWaitMaxTicks": 300,
  "effectiveWaitMinTicks": 1, "effectiveWaitMaxTicks": 300,
  "effectiveWaitMinSeconds": 0.05, "effectiveWaitMaxSeconds": 15,
  "rerollChance": 0.4012 }
```

`rawWaitMinTicks` is negative because `roll - lureSpeed` can land at or below
zero; those rolls are thrown away (see §5), which is what `rerollChance` counts.

### 3.2 `oddsGrid` — every luck value, both water states

```jsonc
{
  "tableId": "minecraft:gameplay/fishing",
  "luckValues": [-4, -3, …, 10],
  "cells": [ { "luck": -4, "inOpenWater": true, … }, { "luck": -4, "inOpenWater": false, … }, … ],
  "warnings": []
}
```

30 cells, ordered luck-ascending with `inOpenWater: true` before `false`. Each
cell:

```jsonc
{
  "luck": 3,
  "inOpenWater": true,
  "categories": [
    { "tableId": "minecraft:gameplay/fishing/junk",     "name": "junk",     "poolIndex": 0, "weight": 10, "quality": -2, "effectiveWeight": 4,  "probability": 0.041237113402061855 },
    { "tableId": "minecraft:gameplay/fishing/treasure", "name": "treasure", "poolIndex": 0, "weight": 5,  "quality": 2,  "effectiveWeight": 11, "probability": 0.1134020618556701 },
    { "tableId": "minecraft:gameplay/fishing/fish",     "name": "fish",     "poolIndex": 0, "weight": 85, "quality": -1, "effectiveWeight": 82, "probability": 0.845360824742268 },
  ],
  "items": [ … ],     // flattened: one row per item id
  "outcomes": [ … ],  // one row per entry path (same item from two entries stays split)
  "pools": [ … ],     // raw per-pool weights, roll distribution, per-entry probabilities
  "warnings": []
}
```

`items` and `outcomes` rows are the engine's full `LootOutcome` shape:

```jsonc
{
  "key": "minecraft:enchanted_book",
  "kind": "item",
  "itemId": "minecraft:enchanted_book",
  "displayName": "Enchanted Book",
  "probability": 0.008333333333333333,
  "expectedCount": 0.008333333333333333,
  "count": { "min": 1, "max": 1, "expected": 1 },
  "countDistribution": [[1, 0.008333333333333333]],
  "tablePath": ["minecraft:gameplay/fishing", "minecraft:gameplay/fishing/treasure"],
  "entryPaths": ["minecraft:gameplay/fishing#0[1]>minecraft:gameplay/fishing/treasure#0[4]"],
  "poolIndices": [0],
  "enchantments": [
    { "source": "enchant_with_levels",
      "levels": { "min": 30, "max": 30, "expected": 30 },
      "possibleEnchantments": ["minecraft:protection", …, "minecraft:mending"] }
  ],
  "conditions": [ … ],
  "unresolvedConditions": [],
  "annotations": ["enchanting turns Book into an Enchanted Book"]
}
```

Treasure rods, bows and armour also carry `damage`:

```jsonc
"damage": { "minDamageFraction": 0.1, "maxDamageFraction": 1, "expectedDamageFraction": 0.7125, "maxDurability": 64 }
```

**These are the fraction of durability already consumed**, not the fraction
remaining. The `minecraft:set_damage` JSON field is inverted (`setDamageValue(floor((1 - damage) * maxDamage))`),
and the pipeline flips it back so a guide can print "arrives with 28.75%
durability left" directly as `1 - expectedDamageFraction`.

### 3.3 `scenarios` — named presets

26 entries: one per interesting luck source combination, in both water states.

```jsonc
{
  "id": "lots_3_luck_1_open_water",
  "label": "Luck of the Sea III + Luck I, open water",
  "lotsLevel": 3,
  "luckPotionLevel": 1,
  "luckPotionAmplifier": 0,
  "luck": 4,
  "inOpenWater": true,
  "gridIndex": 16,
  "categories": [ … ],            // inlined, so a preset card needs no lookup
  "expectedItemsPerCatch": 1.001705
}
```

`gridIndex` indexes `oddsGrid.cells` directly — `oddsGrid.cells[scenario.gridIndex]`
is guaranteed to be the cell with that `luck` and `inOpenWater`. Use it for the
full per-item table; use the inlined `categories` for the summary card.

The set covers: unenchanted, Luck of the Sea I–III, Luck I–III on a bare rod,
Luck of the Sea III stacked with Luck I–III, and Bad Luck I–III. Scenario ids are
stable; the id is `<seed>_<open|closed>_water`.

`expectedItemsPerCatch` is the sum of `expectedCount` over the cell's `items`. It
is slightly above 1 at low luck because the junk table's ink sac entry rolls a
stack of 10, and exactly 1 from luck 5 up, where junk's effective weight floors to
zero and drops out of the pool entirely.

### 3.4 `timing` — how long a catch takes

```jsonc
{
  "ticksPerSecond": 20,
  "combinations": [
    { "key": "clearSkyVisible",      "label": "Clear, sky visible",      "raining": false, "skyVisible": true,
      "decrementDistribution": [[1, 1]], "expectedDecrement": 1 },
    { "key": "clearSkyObstructed",   "label": "Clear, sky obstructed",   "raining": false, "skyVisible": false,
      "decrementDistribution": [[0, 0.5], [1, 0.5]], "expectedDecrement": 0.5 },
    { "key": "rainingSkyVisible",    "label": "Raining, sky visible",    "raining": true,  "skyVisible": true,
      "decrementDistribution": [[1, 0.75], [2, 0.25]], "expectedDecrement": 1.25 },
    { "key": "rainingSkyObstructed", "label": "Raining, sky obstructed", "raining": true,  "skyVisible": false,
      "decrementDistribution": [[0, 0.375], [1, 0.5], [2, 0.125]], "expectedDecrement": 0.75 },
  ],
  "rows": [ … ],                                       // 4 Lure levels x 4 combinations
  "approachWindow": { "minTicks": 20, "maxTicks": 80, "minSeconds": 1, "maxSeconds": 4, "outcomes": 61 },
  "nibbleWindow":   { "minTicks": 20, "maxTicks": 40, "minSeconds": 1, "maxSeconds": 2, "outcomes": 21 },
  "nibbleDecrementPerTick": 1,
  "expectedXpPerCatch": 3.5,
  "model": [ … ],                                      // plain-English statement of the derivation
  "warnings": []
}
```

One row per Lure level per combination:

```jsonc
{
  "lureLevel": 0,
  "lureTicks": 0,
  "combination": "clearSkyVisible",
  "rerollChance": 0,
  "expectedRollsPerCycle": 1,
  "expectedWaitTicks": 351,
  "expectedWaitSeconds": 17.55,
  "expectedApproachTicks": 50,
  "expectedApproachSeconds": 2.5,
  "expectedCycleTicks": 401,
  "expectedCycleSeconds": 20.05,
  "expectedCatchesPerHour": 179.55,
  "expectedXpPerHour": 628.43
}
```

The full table, seconds per catch (`expectedCycleSeconds`) with catches per hour
in brackets:

| Lure | clear, sky visible | raining, sky visible | clear, sky obstructed | raining, sky obstructed |
| ---- | ------------------ | -------------------- | --------------------- | ----------------------- |
| 0    | 20.05 s (179.6/h)  | 16.07 s (224.1/h)    | 40.05 s (89.9/h)      | 26.74 s (134.6/h)       |
| 1    | 15.08 s (238.8/h)  | 12.09 s (297.9/h)    | 30.10 s (119.6/h)     | 20.11 s (179.1/h)       |
| 2    | 12.59 s (286.0/h)  | 10.10 s (356.5/h)    | 25.11 s (143.4/h)     | 16.79 s (214.5/h)       |
| 3    | 10.11 s (356.1/h)  | 8.12 s (443.4/h)     | 20.13 s (178.8/h)     | 13.47 s (267.2/h)       |

#### How those numbers are derived

`FishingHook.catchingFish` runs once per tick while the bobber is in water:

1. It rolls `fishingSpeed` fresh **every tick**, starting at
   `rain.baseSpeed` (1). `+1` with `rain.rain.chance` (0.25) if it is raining at
   the block above the bobber, `-1` with `rain.obstructedSky.chance` (0.5) if the
   sky there is obstructed. The two rolls are independent, so a covered bobber in
   the rain can tick down by 0, 1 or 2. That is exactly
   `combinations[].decrementDistribution`, and `expectedDecrement` matches
   `mechanics.rain.expectedSpeed` (the pipeline cross-checks the two and warns if
   they ever disagree).
2. If no timer is set, it rolls `timeUntilLured = Mth.nextInt(random, 100, 600)`
   and subtracts `lureSpeed` once. That costs one tick.
3. If `timeUntilLured > 0`, it subtracts `fishingSpeed`. When the timer reaches
   zero or below it rolls `timeUntilHooked = Mth.nextInt(random, 20, 80)`.
4. `timeUntilHooked` counts down by the **same** `fishingSpeed` (that is what
   `hookWindow.approachDecrementVariable` records), then sets
   `nibble = Mth.nextInt(random, 20, 40)` and the bobber dips.
5. `nibble` counts down by 1 per tick, ignoring `fishingSpeed`
   (`nibbleDecrementPerTick`). Reeling in during that window rolls the loot table;
   letting it lapse resets both timers.

So:

- **Reroll cost.** A wait roll of `R` with Lure ticks `L` gives `R - L`. If that
  is `<= 0` the `timeUntilLured > 0` branch fails on the next tick and the code
  falls through to a fresh roll, burning exactly one tick. The number of rolls per
  cycle is geometric, so `expectedRollsPerCycle = 1 / (1 - rerollChance)`, and
  `rerollChance = |{R : R <= L}| / 501`. For Lure III that is 201/501 = 0.4012,
  which matches `lureSources.perLevel[3].rerollChance`.
- **Countdown length.** Expected ticks to take a timer from `w` to zero is solved
  by the exact recurrence `T(w) = (1 + Σ_{k>0} P(k)·T(w - k)) / (1 - P(0))`, with
  `T(w <= 0) = 0`. This is not `w / expectedDecrement`: a decrement of 2 can
  overshoot past zero, and dividing by the mean rate would quietly ignore that.
- **`expectedWaitSeconds`** = `(expectedRollsPerCycle + mean of T(R - L) over the
  rolls that survive) / 20`.
- **`expectedApproachSeconds`** = `mean of T(H) for H in 20..80`, over the same
  decrement distribution.
- **`expectedCycleSeconds`** = wait + approach. It assumes you reel in the moment
  the bobber dips, so the nibble window contributes nothing. An AFK farm that
  reacts late adds up to `nibbleWindow.maxSeconds` (2 s) per catch; use
  `nibbleWindow` if you want to model that.
- **`expectedCatchesPerHour`** = `3600 / expectedCycleSeconds`;
  **`expectedXpPerHour`** = that times `expectedXpPerCatch` (3.5, the midpoint of
  the uniform `random.nextInt(6) + 1` orb, awarded per caught stack).

One caveat worth surfacing in UI copy: the `rainingSkyObstructed` row is computed
because the two per-tick modifiers are independent rolls in the parsed source, but
in practice `Level.isRainingAt` also requires sky access, so an actually-covered
bobber will not see the rain bonus. Treat that column as the arithmetic
combination, not as advice.

## 4. `loot-odds.json`

```jsonc
{
  "version": "26.2",
  "generatedAt": "…",
  "fishing": { "tableId": "minecraft:gameplay/fishing", "dataset": "fishing-odds.json" },
  "lootingLevels": [0, 1, 2, 3],
  "chestLuck": 0,
  "bartering": { … },
  "archaeology": [ … ],   // 6 tables
  "gifts": [ … ],         // 21 tables
  "mobDrops": [ … ],      // 109 tables
  "chests": [ … ],        // 56 tables
  "warnings": [ … ]
}
```

Every section except `bartering` is an array of the same `LootOddsTable` shape:

```jsonc
{
  "tableId": "minecraft:archaeology/desert_pyramid",
  "name": "desert_pyramid",
  "tableType": "minecraft:archaeology",
  "cells": [
    {
      "contexts": [{}],
      "items": [
        { "itemId": "minecraft:archer_pottery_sherd", "displayName": "Archer Pottery Sherd", "kind": "item",
          "probability": 0.125, "expectedCount": 0.125,
          "count": { "min": 1, "max": 1, "expected": 1 },
          "countDistribution": [[1, 0.125]] },
      ],
      "warnings": []
    }
  ],
  "warnings": []
}
```

Item rows here are the trimmed `LootOddsItem` shape: no `tablePath`,
`entryPaths`, `poolIndices` or full `conditions` array (those stay in
`loot-tables.json` if you need to drill in). `damage`, `enchantments`, `potions`,
`smelted`, `unresolvedConditions` and `annotations` are present only when they
apply.

### Sections

- **`bartering`** — `minecraft:gameplay/piglin_bartering`. One evaluation of the
  table is one gold ingot handed to a piglin, so every row carries two extra
  fields on top of the normal ones:

  ```jsonc
  { "itemId": "minecraft:crying_obsidian", "displayName": "Crying Obsidian",
    "probability": 0.08528784648187633,
    "expectedCount": 0.17057569296375266,
    "expectedCountPerIngot": 0.17057569296375266,
    "expectedIngotsPerItem": 5.8625,
    "count": { "min": 1, "max": 3, "expected": 2 } }
  ```

  `expectedIngotsPerItem` is `1 / expectedCountPerIngot` — "trade 5.86 ingots per
  crying obsidian on average". Because bartering always hands back exactly one
  stack, the `probability` column sums to 1 across the section.

- **`archaeology`** — all six brushable suspicious-sand/gravel tables
  (`desert_pyramid`, `desert_well`, `ocean_ruin_cold`, `ocean_ruin_warm`,
  `trail_ruins_common`, `trail_ruins_rare`). One brush = one evaluation.

- **`gifts`** — every remaining `minecraft:gameplay/*` table: `cat_morning_gift`,
  `sniffer_digging`, `chicken_lay`, `panda_sneeze`, `armadillo_shed`,
  `turtle_grow`, and all fourteen `hero_of_the_village/*_gift` tables. The fishing
  table and its three sub-tables are excluded (they live in the other file), and
  bartering has its own section.

- **`mobDrops`** — every `minecraft:entities/*` table at each of
  `lootingLevels`. See §8 for the context representation.

- **`chests`** — all 56 `minecraft:chests/*` tables at `chestLuck` (0). One
  evaluation is one chest generated, so `probability` is "this chest contains at
  least one of these" and `expectedCount` is "how many this chest holds on
  average".

## 5. What the probability fields mean, exactly

This is the part most likely to get rendered wrong, so be precise:

| field                | meaning                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `probability`        | P(at least one of this item) **per full evaluation of the table**                                              |
| `probabilityPerRoll` | P(this outcome wins **a single roll of its pool**). Only on `fishing-odds.json` rows, and only when one pool produces it |
| `expectedCount`      | E[number of items] per full evaluation. **Unconditional** — includes the zero case                              |
| `count`              | min / max / expected **conditioned on the item dropping at all**                                                |
| `countDistribution`  | exact `[count, probability]` pairs, `count >= 1`. Sums to `probability`                                         |

The identity that ties them together:
`expectedCount === probability * count.expected`, and
`probability === Σ countDistribution[i][1]`.

"One full evaluation of the table" means, per section: one catch (fishing), one
gold ingot (bartering), one brush (archaeology), one gift/lay/sneeze/dig (gifts),
one mob death (mobDrops), one generated chest (chests).

So for fishing: `probability` is the chance **per catch**, not per cast and not
per hour. Multiply by `timing.rows[].expectedCatchesPerHour` for a per-hour
figure.

`categories[].probability` is the chance that a catch comes from that sub-table,
computed as `effectiveWeight / Σ effectiveWeight` over entries whose conditions
pass. It is 0, not absent, for treasure outside open water — the entry keeps its
weight of 5, its condition just never passes, so junk and fish renormalise over 95
rather than 100.

## 6. The luck model

`LootContext.getLuck()` is a single float, and everything feeds it:

```
luck = max(0, Luck of the Sea bonus)          // luckSources.enchantment.perLevel[]
     + player minecraft:luck attribute        // Luck / Bad Luck effects, or /attribute
```

From `mechanics.luckSources`:

- `enchantment`: Luck of the Sea's `minecraft:fishing_luck_bonus` is
  `add(linear(base: 1, per_level_above_first: 1))`, so levels I/II/III give
  +1/+2/+3. `hookClampMinimum: 0` and
  `hookClampSource: "this.luck = Math.max(0, luck);"` — the enchantment half can
  never go negative.
- `luckEffect` / `unluckEffect`: the Luck and Bad Luck potions add
  `amount * (amplifier + 1)` to `minecraft:luck`, i.e. ±1/±2/±3 at potion level
  I/II/III.
- `playerLuckAttributeAdded: true` and
  `lootLuckSource: ".withLuck(this.luck + owner.getLuck())"` — the player's
  attribute is added on top, and **it is not clamped**, so Bad Luck really can
  push total luck negative. `luckAttribute` records the attribute's range
  (`-1024` to `1024`), which is why the grid stops at `[-4, 10]` rather than
  trying to be exhaustive.

Luck reaches the odds through the weight formula, from
`mechanics.weightFormula`:

```
effectiveWeight = max(floor(weight + quality * luck), 0)
```

with `defaultWeight: 1`, `defaultQuality: 0`, and
`entryIncludedWhenWeightGreaterThan: 0` — an entry whose effective weight floors
to zero is removed from the pool entirely, not merely made unlikely. That is why
junk vanishes at luck 5 (`floor(10 - 2*5) = 0`) and stays gone at every higher
luck, leaving only fish and treasure to share the pool.

Note `arithmeticNotes`: `weight` and `quality` are ints, `luck` is a float, so the
whole sum is floored — not just `quality * luck`. Fractional luck from
`/attribute` behaves accordingly.

Luck also inflates `bonus_rolls`
(`this.rolls.getInt(context) + Mth.floor(this.bonusRolls.getFloat(context) * context.getLuck())`),
which matters for chest tables, not for fishing.

## 7. Open water, in brief

`mechanics.openWater` records the whole `calculateOpenWater` scan:

- 4 layers, `layerMinY: -1` to `layerMaxY: 2` relative to the bobber's block, each
  a 5x5 area (`areaMinOffsetXZ: -2` to `areaMaxOffsetXZ: 2`) — 100 blocks total.
- Every block in a layer must classify the same way
  (`layerRequiresUniformClassification: true`), otherwise the layer is INVALID and
  the check fails.
- `layerRules` spells out the state machine: the first layer may not be
  ABOVE_WATER, an INSIDE_WATER layer may not sit above an ABOVE_WATER layer, and
  any INVALID layer fails immediately.
- `blockRules`: air and lily pads both count as ABOVE_WATER (so lily pads are
  safe); INSIDE_WATER needs a water-tagged **source** fluid with an empty
  collision shape, so waterlogged stairs/slabs/fences break it
  (`waterloggedSolidBlocksAreInvalid: true`) while bubble columns do not
  (`bubbleColumnIsInsideWater: true`).
- `reevaluatedOnlyOnceLuredOrBiting: true` and `latchesFalseUntilTimersReset: true`
  — the flag is only re-checked once a fish is on its way, and once it goes false
  it stays false for that cycle.
- `enforcedInRetrieveCode: false`, `enforcedByLootCondition: true` — nothing in
  `retrieve` consults the flag; open water matters purely because the treasure
  entry carries the `in_open_water` fishing-hook predicate. That is the whole
  mechanical effect, and it is exactly what the `inOpenWater: false` grid cells
  model.

## 8. The `mobDrops` context representation

Each table's `cells` is a list of `{ contexts, items, warnings }`, where
`contexts` lists **every context that produces byte-identical numbers**. Look up
the cell whose `contexts` contains the combination you want:

```ts
const cell = table.cells.find((c) =>
  c.contexts.some((ctx) => ctx.looting === looting && ctx.killedByPlayer === killedByPlayer),
);
```

Two shapes occur:

- **The table reacts to who killed it.** Every context carries both keys, and
  there are up to 8 cells:

  ```jsonc
  "cells": [
    { "contexts": [{ "looting": 0, "killedByPlayer": false }], "items": [ rotten_flesh, red_mushroom ] },
    …
    { "contexts": [{ "looting": 0, "killedByPlayer": true }],  "items": [ …, iron_ingot, carrot, baked_potato ] },
    …
  ]
  ```

- **The flag cannot change the answer.** The key is omitted entirely rather than
  stamped on, because publishing it would imply a distinction the table does not
  make:

  ```jsonc
  "cells": [{ "contexts": [{ "looting": 0 }, { "looting": 1 }, { "looting": 2 }, { "looting": 3 }], "items": [ … ] }]
  ```

  Most mobs land here — a bat drops nothing regardless — and identical looting
  levels collapse into one cell too, so a table that ignores looting publishes a
  single cell listing all four levels.

Whether a table reacts is determined empirically: it is evaluated both ways at the
lowest looting level and the results compared, so it catches
`minecraft:killed_by_player` wherever it sits, including inside nested tables.

Looting itself is applied through `enchantmentLevels: { "minecraft:looting": n }`,
which drives `minecraft:enchanted_count_increase`,
`minecraft:random_chance_with_enchanted_bonus` and friends. Zombie rotten flesh is
the canonical check: `expectedCount` goes 1.0 → 1.5 → 2.0 → 2.5 across Looting
0–3.

## 9. Known caveats

**Unresolved conditions are treated as passing.** The engine resolves what it can
from the context (luck, open water, killed-by-player, enchantment levels, weather,
block state, biome). Anything it cannot answer — "is this zombie a baby riding a
chicken?", "was the attacker a skeleton?", "is this dolphin on fire?" — is
computed **as if it passed**, and its signature is listed in
`unresolvedConditions` on the affected row. This is deliberate (it shows the item
exists at all) but it means the number is a **ceiling**, not the real drop rate:

```jsonc
{ "itemId": "minecraft:music_disc_lava_chicken", "displayName": "Music Disc",
  "probability": 1, "expectedCount": 1,
  "unresolvedConditions": [
    "minecraft:entity_properties:{\"entity\":\"this\",\"predicate\":{\"minecraft:flags\":{\"is_baby\":true},\"minecraft:vehicle\":{\"minecraft:entity_type\":\"minecraft:chicken\"}}}"
  ] }
```

That is "a chicken jockey always drops the disc", not "every zombie does".
**Render a footnote or an asterisk whenever `unresolvedConditions` is non-empty**,
and consider hiding such rows from headline "best drops" lists. The same applies
to zombie `red_mushroom` (requires riding a zombie horse) and every sheep wool
colour (requires that colour and an unsheared sheep).

If you need one of those answered, the signature is a stable key: re-evaluate the
table yourself with `conditionOverrides: { "<signature>": false }`, or set
`unresolvedConditionsPass: false` to drop them instead.

**Dataset-level `warnings`** on `loot-odds.json` is the deduplicated list of every
such note (67 entries on 26.2), prefixed with the table id. Per-table and per-cell
`warnings` carry the same text scoped down. `fishing-odds.json` has exactly one:
the jungle-biome `location_check` on the junk table's bamboo entry, which has no
biome in context — so bamboo is priced as if you were always fishing in a jungle.

**Annotations are metadata-only notes.** `annotations` flags functions that were
recognised but do not change counts or probabilities — `minecraft:set_name`,
`minecraft:set_instrument`, `minecraft:exploration_map`,
`minecraft:set_stew_effect`, `minecraft:set_ominous_bottle_amplifier`. It also
records real transformations that are worth surfacing, like "enchanting turns Book
into an Enchanted Book" and "furnace_smelt has no smelting recipe for
minecraft:pufferfish".

**`kind: "dynamic"`** rows exist in the type for `minecraft:dynamic` entries the
game resolves at runtime (shulker box contents, banner patterns). None occur in
the sections shipped here on 26.2, but handle the field rather than assuming
`"item"`.

**`damage` is inverted relative to the JSON** (see §3.2). Print
`1 - expectedDamageFraction` for "durability remaining".

**`totalWeightExact: false`** on a pool means the eligible entry set was not
deterministic under the context, so `totalWeight` is an expected value. Only
relevant if you render raw pool internals.

## 10. Building a fishing guide page

Which field powers which piece of UI:

| UI element                                    | source                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| Preset picker (rod + potion + water toggle)   | `scenarios[]` — `label`, `lotsLevel`, `luckPotionLevel`, `inOpenWater`             |
| Big three-way donut (fish / junk / treasure)  | `scenarios[].categories[].probability` (already inlined)                          |
| Per-item odds table                           | `oddsGrid.cells[scenario.gridIndex].items[]` — `displayName`, `probability`        |
| "1 in N" column                               | `1 / probability`, rounded                                                        |
| Per-hour column                               | `probability * timing.rows[].expectedCatchesPerHour`                              |
| Stack size column                             | `count.min`–`count.max`, `count.expected`                                         |
| Distribution sparkline                        | `countDistribution`                                                               |
| "Arrives with X% durability"                  | `1 - damage.expectedDamageFraction`, `damage.maxDurability`                       |
| "Enchanted at level 30" badge + tooltip list  | `enchantments[0].levels`, `enchantments[0].possibleEnchantments`                  |
| Luck slider (-4 … 10)                         | `oddsGrid.luckValues`, then find the cell by `luck` + `inOpenWater`                |
| "Why does treasure need open water?" explainer| `mechanics.openWater.layerRules`, `blockRules`, `areaWidth`/`layerCount`           |
| Weight formula explainer                      | `mechanics.weightFormula.expression`, `arithmeticNotes`, plus `categories[].weight`/`quality`/`effectiveWeight` |
| Lure comparison table                         | `timing.rows[]` filtered to one `combination`                                     |
| Weather/sky toggle on that table              | `timing.combinations[]` — `label`, `expectedDecrement`                            |
| "Expected wait" readout                       | `timing.rows[].expectedWaitSeconds`, `expectedCycleSeconds`                       |
| "Catches / XP per hour" readout               | `timing.rows[].expectedCatchesPerHour`, `expectedXpPerHour`                       |
| "Reel in within N seconds" tip                | `timing.nibbleWindow.minSeconds`–`maxSeconds`                                     |
| Bobber-splash / tease explainer               | `mechanics.waitTime.teaseChance`, `mechanics.hookWindow.fishAngleWobble`           |
| Rod durability cost                           | `mechanics.xp.rodDamageOnCatch` (and the `OnEntity`/`OnGround` variants)           |
| Source citations ("parsed from …")            | `mechanics.sourcePaths`, plus the per-section `sourcePath`/`sourcePaths`           |
| Data caveats footer                           | `warnings` at every level, plus per-item `unresolvedConditions` / `annotations`    |

A minimal render loop:

```ts
import type { FishingOddsDataset } from "mc-datahub/types";

const fishing: FishingOddsDataset = await fetch("/minecraft-data/26.2/fishing-odds.json").then((r) => r.json());

const scenario = fishing.scenarios.find((s) => s.id === "lots_3_open_water")!;
const cell = fishing.oddsGrid.cells[scenario.gridIndex]!;
const timing = fishing.timing.rows.find((row) => row.lureLevel === 3 && row.combination === "clearSkyVisible")!;

for (const item of cell.items) {
  render({
    name: item.displayName,
    perCatch: `${(item.probability * 100).toFixed(3)}%`,
    oneIn: Math.round(1 / item.probability),
    perHour: (item.probability * timing.expectedCatchesPerHour).toFixed(1),
    caveat: item.unresolvedConditions?.length ? "conditional drop" : undefined,
  });
}
```

Two rendering rules worth baking in:

1. **Never print a raw double.** `0.008333333333333333` is `0.833%` or "1 in 120".
   The precision is there so your arithmetic stays exact, not so you can show it.
2. **Always keep the water state visible.** The single biggest source of wrong
   fishing numbers on the web is quoting treasure odds without saying they require
   open water. The dataset makes both states first-class; the UI should too.
