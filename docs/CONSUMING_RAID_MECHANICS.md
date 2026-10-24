# Consuming raid-mechanics.json

`workspace/datasets/<version>/raid-mechanics.json` (also `GET /versions/:version/raid-mechanics`, `dump collection raid-mechanics`).
Built by `src/extraction/raidMechanicsExtractor.ts`; regenerate one version with
`npm run build && node scripts/regen-raid-mechanics.mjs <version>`.

Every number is parsed from the decompiled client (`sourcePaths` lists the files). A seam that no longer
matches becomes a `warnings` entry and the field is left out, so treat a non-empty `warnings` as "re-check
before shipping". Durations are `{ ticks, seconds }`.

## Terms

- **wave / group number**: 1-based. The bonus wave is group `numGroups + 1` and reuses the fixed counts at
  index `numGroups`. Rules that mention a wave number (witch gating, riders, enchant tiers) see the group number.
- **raid omen level**: 1..5. A Bad Omen or Raid Omen amplifier `a` adds `a + 1`. Level 2+ adds the bonus wave.

## Sections

| Key            | What it holds                                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `waves`        | `numGroupsByDifficulty`, `spawnOrder`, raw `spawnsPerWaveBeforeBonus` arrays (index 0 unused), bonus wave rule                                                                                                                              |
| `bonusSpawns`  | Per raider cap rule. `extra = cap > 0 ? nextInt(cap + 1) : 0`                                                                                                                                                                               |
| `rosterTable`  | Precomputed per difficulty: `waves[]` and `bonusWave`, each with per raider `fixed`, `randomMin/Max`, exact `extraDistribution`, `expected`, plus `riders`, totals, `captainOdds`                                                           |
| `riders`       | Ravager rider rules (group == normal groups: pillager; group >= hard groups: evoker on the first ravager, vindicators on the rest)                                                                                                          |
| `captain`      | Who becomes captain, banner drop chance, ominous banner layers                                                                                                                                                                              |
| `omen`         | `levels[]` (one row per raid omen level: bonus wave, enchant odds, hero amplifier, hero discount, trial omen time), Bad Omen and Raid Omen rules, absorb rules, `canStartRaid` overrides, ominous bottle loot sources with amplifier ranges |
| `enchantments` | Odds per omen level, per raider tiers (`minWave`, provider, enchantment, level)                                                                                                                                                             |
| `timers`       | Named durations with a `note` each                                                                                                                                                                                                          |
| `geometry`     | Raid radius, raider removal distance, village check, wave spawn ring formula and a per-second table, horn range                                                                                                                             |
| `outcomes`     | `victory`, `loss`, `stopped` conditions                                                                                                                                                                                                     |
| `hero`         | Hero of the Village duration, credit rules, trade discount per amplifier, gift timing and loot table ids                                                                                                                                    |
| `patrols`      | Pillager patrol timing, chance, offsets, group size per difficulty, captain chance, spawn attribute overrides                                                                                                                               |
| `raiders`      | `#minecraft:raiders` members with `inRaidWaves`, spawn array, `maxHealth`, `canBeLeader`, `raidBuffs`                                                                                                                                       |
| `progression`  | Stat ids, criteria triggers, the two raid advancements                                                                                                                                                                                      |

Gift item odds are not repeated here: look the `hero.gifts` loot table ids up in `loot-odds.json`.

## Reading a wave

```ts
const hard = data.rosterTable.find((t) => t.difficulty === "hard")!;
const waves = raidOmenLevel >= hard.bonusWaveRequiresRaidOmenLevel ? [...hard.waves, hard.bonusWave] : hard.waves;
for (const wave of waves) {
  // wave.totalMin..wave.totalMax includes riders; wave.raiders[i].extraDistribution is exact.
}
```

The hard bonus wave (raid omen 2 to 5 all give the same roster) is 5-7 vindicators, 2 evokers, 2-4 pillagers,
1-2 witches and 2-3 ravagers, plus an evoker rider on the first ravager and 1-2 vindicator riders: 14-21 raiders.

## Gotchas

- Omen level changes only the bonus wave, enchant odds and the hero amplifier. It never changes wave counts.
- On Normal the bonus wave (group 6) has no ravager riders; only group 5 and groups 7+ do.
- Pillager enchant tiers start at group 4: on Normal, Quick Charge I only appears on waves 4 and 5 and Quick Charge II
  only on the bonus wave (group 6). Easy raids top out at group 4, so only their bonus wave can roll Quick Charge I.
- At raid omen level 1 the enchant odds are 0, but the roll is `nextFloat() <= odds`, so a 0.0 roll (1 in 2^24)
  still enchants.
- Only captain pillagers drop ominous bottles (`entities/pillager` is the only mob table with the function).
  Vindicator and evoker captains drop just the banner.
- Raid Omen fires at its last tick at the position where Bad Omen converted, not where the player is then.
