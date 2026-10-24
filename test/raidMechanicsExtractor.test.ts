import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import { createConsoleLogger } from "../src/core/logger.js";
import type { RaidMechanicsDataset, RaidRosterWave } from "../src/domain/types.js";
import { RaidMechanicsExtractor } from "../src/extraction/raidMechanicsExtractor.js";

/**
 * The decompiled client lives under the gitignored workspace, so the pinned-value suite only runs where
 * 26.3-pre-3 has been decompiled. Every value below is parsed from that source, not from a fixture.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT_ROOT = join(ROOT, "workspace", "versions", "26.3-pre-3", "decompiled", "client");
const HAS_WORKSPACE = existsSync(join(CLIENT_ROOT, "net/minecraft/world/entity/raid/Raid.java"));

function counts(wave: RaidRosterWave | undefined): Record<string, [number, number]> {
  return Object.fromEntries(
    (wave?.raiders ?? []).map((entry) => [entry.raider, [entry.fixed + entry.randomMin, entry.fixed + entry.randomMax]]),
  );
}

describe.skipIf(!HAS_WORKSPACE)("raid mechanics extractor (26.3-pre-3 source)", () => {
  let data: RaidMechanicsDataset;

  beforeAll(async () => {
    const extracted = await new RaidMechanicsExtractor(createConsoleLogger(false)).extract(CLIENT_ROOT);
    if (!extracted) throw new Error("raid mechanics did not extract");
    data = extracted;
  });

  test("parses every seam without warnings", () => {
    expect(data.warnings).toEqual([]);
    expect(data.sourcePaths).toContain("net/minecraft/world/entity/raid/Raid.java");
  });

  test("waves per difficulty and the RaiderType spawn arrays", () => {
    expect(data.waves.numGroupsByDifficulty).toEqual({ peaceful: 0, easy: 3, normal: 5, hard: 7 });
    expect(data.waves.spawnOrder).toEqual(["vindicator", "evoker", "pillager", "witch", "ravager"]);
    expect(data.waves.spawnsPerWaveBeforeBonus).toEqual({
      vindicator: [0, 0, 2, 0, 1, 4, 2, 5],
      evoker: [0, 0, 0, 0, 0, 1, 1, 2],
      pillager: [0, 4, 3, 3, 4, 4, 4, 2],
      witch: [0, 0, 0, 0, 3, 0, 0, 1],
      ravager: [0, 0, 0, 1, 0, 1, 0, 2],
    });
    expect(data.waves.bonusWave.requiresRaidOmenLevelAtLeast).toBe(2);
  });

  test("bonus spawn rules", () => {
    const rule = (raider: string) => data.bonusSpawns.rules.find((entry) => entry.raider === raider);
    expect(rule("pillager")?.capByDifficulty).toEqual({
      easy: { uniformBelow: 2 },
      normal: { constant: 1 },
      hard: { constant: 2 },
    });
    expect(rule("witch")).toMatchObject({
      capByDifficulty: { easy: { constant: 0 }, normal: { constant: 1 } },
      zeroOnWaves: { atMost: 2, equals: [4] },
    });
    expect(rule("ravager")).toMatchObject({
      capByDifficulty: { easy: { constant: 0 }, hard: { constant: 1 } },
      onlyOnBonusWave: true,
    });
    expect(rule("evoker")?.capByDifficulty.hard).toEqual({ constant: 0 });
  });

  test("roster table: exact extra-spawn odds, riders and captains", () => {
    const table = (difficulty: string) => data.rosterTable.find((entry) => entry.difficulty === difficulty);
    const easyWave1 = table("easy")?.waves[0];
    // Easy: cap = nextInt(2), extra = cap > 0 ? nextInt(cap + 1) : 0 -> P(0) = 1/2 + 1/4.
    expect(easyWave1?.raiders.find((entry) => entry.raider === "pillager")?.extraDistribution).toEqual([
      { count: 0, probability: 0.75 },
      { count: 1, probability: 0.25 },
    ]);

    const hard = table("hard");
    expect(hard?.waves.map((wave) => [wave.totalMin, wave.totalMax])).toEqual([
      [4, 8],
      [5, 9],
      [4, 9],
      [8, 12],
      [11, 16],
      [7, 12],
      [14, 19],
    ]);
    expect(counts(hard?.bonusWave)).toEqual({
      vindicator: [5, 7],
      evoker: [2, 2],
      pillager: [2, 4],
      witch: [1, 2],
      ravager: [2, 3],
    });
    expect(hard?.bonusWave).toMatchObject({ wave: 8, baseIndex: 7, totalMin: 14, totalMax: 21 });
    expect(hard?.bonusWave.riders).toEqual([
      { rider: "minecraft:evoker", seats: "first", min: 1, max: 1, expected: 1 },
      { rider: "minecraft:vindicator", seats: "rest", min: 1, max: 2, expected: 1.5 },
    ]);
    expect(hard?.waves[0]?.captainOdds.vindicator).toBeCloseTo(2 / 3, 12);

    // Normal wave 5 = getNumGroups(NORMAL): every ravager carries a pillager. The normal bonus wave (group 6) has no riders.
    const normal = table("normal");
    expect(normal?.waves[4]?.riders).toEqual([{ rider: "minecraft:pillager", seats: "all", min: 1, max: 1, expected: 1 }]);
    expect(normal?.bonusWave.riders).toEqual([]);
    // Witches can appear on wave 3 through the bonus roll even though the fixed count is 0.
    expect(counts(normal?.waves[2]).witch).toEqual([0, 1]);
  });

  test("omen flow, levels, and ominous bottle sources", () => {
    expect(data.omen.maxRaidOmenLevel).toBe(5);
    expect(
      data.omen.levels.map((level) => [level.raidOmenLevel, level.bonusWave, level.enchantOdds, level.heroOfTheVillageAmplifier]),
    ).toEqual([
      [1, false, 0, 0],
      [2, true, 0.1, 1],
      [3, true, 0.25, 2],
      [4, true, 0.5, 3],
      [5, true, 0.75, 4],
    ]);
    expect(data.omen.badOmen.raidOmenDuration).toEqual({ ticks: 600, seconds: 30 });
    expect(data.omen.raidOmen.triggersAtRemainingTicks).toBe(1);
    expect(data.omen.canStartRaid).toEqual({
      id: "minecraft:gameplay/can_start_raid",
      defaultValue: true,
      overrides: [{ kind: "dimension_type", id: "minecraft:the_nether", value: false }],
    });
    expect(data.omen.ominousBottle).toMatchObject({
      badOmenDuration: { ticks: 120000, seconds: 6000 },
      amplifierMin: 0,
      amplifierMax: 4,
    });
    expect(
      data.omen.ominousBottle.sources.map((source) => [
        source.lootTable,
        source.amplifierMin,
        source.amplifierMax,
        source.requiresCaptain,
      ]),
    ).toEqual([
      ["minecraft:chests/trial_chambers/reward_common", 0, 1, false],
      ["minecraft:chests/trial_chambers/reward_ominous_common", 2, 4, false],
      ["minecraft:entities/pillager", 0, 4, true],
    ]);
    expect(data.omen.trialOmen.perBadOmenLevel).toEqual({ ticks: 18000, seconds: 900 });
  });

  test("raid enchantment tiers", () => {
    expect(data.enchantments.byRaider.pillager).toMatchObject({
      mainHandItem: "minecraft:crossbow",
      equipsOnlyWhenEnchanted: true,
      tiers: [
        { minWave: 6, provider: "minecraft:raid/pillager_post_wave_5", enchantment: "minecraft:quick_charge", level: 2 },
        { minWave: 4, provider: "minecraft:raid/pillager_post_wave_3", enchantment: "minecraft:quick_charge", level: 1 },
      ],
    });
    expect(data.enchantments.byRaider.vindicator?.tiers.map((tier) => [tier.minWave, tier.enchantment, tier.level])).toEqual([
      [6, "minecraft:sharpness", 2],
      [1, "minecraft:sharpness", 1],
    ]);
    expect(Object.keys(data.enchantments.byRaider).sort()).toEqual(["pillager", "vindicator"]);
  });

  test("timers and geometry", () => {
    const t = (key: string) => data.timers[key]?.ticks;
    expect([
      t("raidTimeout"),
      t("betweenWaves"),
      t("postRaidVictoryDelay"),
      t("celebration"),
      t("heroOfTheVillage"),
      t("maxNoActionTime"),
    ]).toEqual([48000, 300, 40, 600, 48000, 2400]);
    expect(t("outsideRaidRemoval")).toBe(600);
    expect(data.geometry).toMatchObject({
      raidRadius: 96,
      raiderRemovalDistance: 112,
      villagePoiSearchRadius: 64,
      centerRelocationSectionRadius: 2,
    });
    expect(data.geometry.horn).toEqual({ soundEvent: "minecraft:event.raid.horn", rangeBlocks: 64, playedAtDistance: 13 });
    expect(data.geometry.waveSpawn).toMatchObject({
      ringScale: 32,
      howFarSlope: 0.22,
      howFarOffset: 0.24,
      allowInsideVillageAtOrBelowSeconds: 7,
      triesWhileCountingDown: 8,
      triesAtWaveStart: 20,
      maxFailedSpawnAttempts: 5,
    });
    expect(data.geometry.waveSpawn.bySecondsRemaining.at(-1)).toEqual({
      secondsRemaining: 15,
      howFar: 3.06,
      ringRadius: 97.92,
      jitterStep: 3,
    });
  });

  test("hero of the village rewards", () => {
    expect(data.hero.duration).toEqual({ ticks: 48000, seconds: 2400 });
    expect(data.hero.amplifierFormula).toBe("raidOmenLevel - 1");
    expect(data.hero.discount.byAmplifier.map((entry) => entry.fraction)).toEqual([0.3, 0.3625, 0.425, 0.4875, 0.55]);
    expect(data.hero.discount.minimumReduction).toBe(1);
    expect(data.hero.gifts.betweenGifts).toEqual({ min: { ticks: 600, seconds: 30 }, max: { ticks: 6600, seconds: 330 } });
    expect(Object.keys(data.hero.gifts.byProfession)).toHaveLength(13);
    expect(data.hero.gifts.byProfession["minecraft:librarian"]).toBe("minecraft:gameplay/hero_of_the_village/librarian_gift");
    expect(data.hero.gifts.babyLootTable).toBe("minecraft:gameplay/hero_of_the_village/baby_gift");
  });

  test("patrols", () => {
    expect(data.patrols).toMatchObject({
      attemptInterval: { min: { ticks: 12000 }, max: { ticks: 13199 } },
      chanceOneIn: 5,
      offset: { min: 24, max: 47 },
      notWithinVillageSections: 2,
      memberSpread: 4,
      maxBlockLight: 8,
      despawnDistanceWhilePatrolling: 128,
      naturalCaptainChance: 0.06,
    });
    expect(data.patrols.groupSize.byDifficulty).toEqual({
      easy: { min: 2, max: 3 },
      normal: { min: 3, max: 5 },
      hard: { min: 4, max: 8 },
    });
    expect(data.patrols.canSpawnAttribute.overrides.map((entry) => [entry.kind, entry.id])).toEqual([
      ["biome", "minecraft:mushroom_fields"],
      ["timeline", "minecraft:early_game"],
    ]);
  });

  test("raiders, captain banner, and progression hooks", () => {
    const raider = (key: string) => data.raiders.find((entry) => entry.key === key);
    expect(data.raiders.map((entry) => entry.key).sort()).toEqual([
      "evoker",
      "illusioner",
      "pillager",
      "ravager",
      "vindicator",
      "witch",
    ]);
    expect(raider("illusioner")).toMatchObject({ inRaidWaves: false, maxHealth: 32 });
    expect(raider("ravager")).toMatchObject({ canBeLeader: false, maxHealth: 100 });
    expect(raider("witch")).toMatchObject({ canBeLeader: false, maxHealth: 26 });
    expect(raider("evoker")).toMatchObject({ canBeLeader: true, maxHealth: 24 });
    expect(data.captain.bannerDropChance).toBe(2);
    expect(data.captain.ominousBannerLayers).toHaveLength(8);
    expect(data.captain.ominousBannerLayers[0]).toEqual({
      pattern: "rhombus_middle",
      patternId: "minecraft:rhombus",
      color: "cyan",
    });
    expect(data.progression.criteriaTriggers).toEqual({
      RAID_OMEN: "minecraft:voluntary_exile",
      RAID_WIN: "minecraft:hero_of_the_village",
    });
    expect(
      data.progression.advancements.find((entry) => entry.id === "minecraft:adventure/hero_of_the_village")?.experience,
    ).toBe(100);
  });
});

describe("raid mechanics extractor without sources", () => {
  test("returns undefined when Raid.java is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "raid-mechanics-"));
    try {
      expect(await new RaidMechanicsExtractor(createConsoleLogger(false)).extract(root)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const PREVIEW_CLIENT_ROOT = join(ROOT, "workspace", "versions", "26.4-snapshot-5", "decompiled", "client");
const HAS_PREVIEW_SOURCE = existsSync(join(PREVIEW_CLIENT_ROOT, "net/minecraft/world/entity/raid/Raid.java"));

describe.skipIf(!HAS_PREVIEW_SOURCE)("raid mechanics extractor (26.4-snapshot-5 source)", () => {
  test("recognizes the source Math.clamp seams without inventing values", async () => {
    const data = await new RaidMechanicsExtractor(createConsoleLogger(false)).extract(PREVIEW_CLIENT_ROOT);
    expect(data?.warnings).toEqual([]);
    expect(data?.omen.ominousBottle).toMatchObject({ amplifierMin: 0, amplifierMax: 4 });
    expect(data?.omen.levels).toHaveLength(5);
  });
});
