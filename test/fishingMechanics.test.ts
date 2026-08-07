import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { createConsoleLogger } from "../src/core/logger.js";
import { type FishingMechanics, FishingMechanicsExtractor } from "../src/extraction/fishingMechanicsExtractor.js";

/**
 * The decompiled client lives under the gitignored workspace, so the source-parity suite only runs
 * where version 26.2 has actually been prepared. The fixture suite below always runs.
 */
const CLIENT_ROOT = join(process.cwd(), "workspace", "versions", "26.2", "decompiled", "client");
const hasDecompiledClient = existsSync(join(CLIENT_ROOT, "net/minecraft/world/entity/projectile/FishingHook.java"));

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    Array.from(tempDirs, async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
  tempDirs.clear();
});

async function createTempClientRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fishing-mechanics-"));
  tempDirs.add(root);
  return root;
}

async function writeJavaFile(root: string, relativePath: string, contents: string): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

describe.runIf(hasDecompiledClient)("fishing mechanics extractor (26.2 source)", () => {
  let mechanics: FishingMechanics;

  beforeAll(async () => {
    const extracted = await new FishingMechanicsExtractor(createConsoleLogger(false)).extract(CLIENT_ROOT);
    expect(extracted).toBeDefined();
    mechanics = extracted as FishingMechanics;
  });

  test("parses every field without falling back to a warning", () => {
    expect(mechanics.warnings).toEqual([]);
    expect(mechanics.sourcePaths).toContain("net/minecraft/world/entity/projectile/FishingHook.java");
    expect(mechanics.sourcePaths).toContain("net/minecraft/world/item/FishingRodItem.java");
    expect(mechanics.sourcePaths).toContain("net/minecraft/world/level/storage/loot/entries/LootPoolSingletonContainer.java");
    expect(mechanics.sourcePaths).toContain("data/minecraft/enchantment/lure.json");
  });

  test("pins the wait-time roll and how lure applies to it", () => {
    expect(mechanics.waitTime.baseRoll).toEqual({
      minTicks: 100,
      maxTicks: 600,
      minSeconds: 5,
      maxSeconds: 30,
      outcomes: 501,
    });
    // Lure shortens the initial roll; it does not accelerate the per-tick countdown.
    expect(mechanics.waitTime.lureApplication).toBe("initial_roll_subtraction");
    expect(mechanics.waitTime.lureApplicationSource).toBe("this.timeUntilLured = this.timeUntilLured - this.lureSpeed;");
    expect(mechanics.waitTime.countdownVariable).toBe("fishingSpeed");
    expect(mechanics.waitTime.countdownBaseSpeed).toBe(1);
    expect(mechanics.waitTime.rerollsWhenNonPositive).toBe(true);
    expect(mechanics.waitTime.teaseChance?.baseChance).toBeCloseTo(0.15);
    expect(mechanics.waitTime.teaseChance?.tiers).toEqual([
      { belowTicks: 20, perTickBelow: 0.05 },
      { belowTicks: 40, perTickBelow: 0.02 },
      { belowTicks: 60, perTickBelow: 0.01 },
    ]);
  });

  test("pins the rain and sky modifiers applied to the countdown", () => {
    expect(mechanics.rain.checkOffsetY).toBe(1);
    expect(mechanics.rain.baseSpeed).toBe(1);
    expect(mechanics.rain.rain).toEqual({
      chance: 0.25,
      speedDelta: 1,
      condition: "level.isRainingAt(blockPos.above())",
    });
    expect(mechanics.rain.obstructedSky).toEqual({
      chance: 0.5,
      speedDelta: -1,
      condition: "!level.canSeeSky(blockPos.above())",
    });
    expect(mechanics.rain.expectedSpeed).toEqual({
      clearSkyVisible: 1,
      rainingSkyVisible: 1.25,
      clearSkyObstructed: 0.5,
      rainingSkyObstructed: 0.75,
    });
  });

  test("pins the approach and catchable windows", () => {
    expect(mechanics.hookWindow.approachRoll).toMatchObject({ minTicks: 20, maxTicks: 80, minSeconds: 1, maxSeconds: 4 });
    expect(mechanics.hookWindow.catchableRoll).toMatchObject({ minTicks: 20, maxTicks: 40, minSeconds: 1, maxSeconds: 2 });
    expect(mechanics.hookWindow.fishAngleWobble).toEqual({ center: 0, radius: 9.188 });
    expect(mechanics.hookWindow.fishApproachBlocksPerRemainingTick).toBeCloseTo(0.1);
    expect(mechanics.hookWindow.approachBubbleParticleChance).toBeCloseTo(0.15);
    expect(mechanics.hookWindow.missedBiteResetsTimers).toBe(true);
  });

  test("pins the open-water scan area and block rules", () => {
    expect(mechanics.openWater.layerMinY).toBe(-1);
    expect(mechanics.openWater.layerMaxY).toBe(2);
    expect(mechanics.openWater.layerCount).toBe(4);
    expect(mechanics.openWater.areaWidth).toBe(5);
    expect(mechanics.openWater.areaDepth).toBe(5);
    expect(mechanics.openWater.blocksPerLayer).toBe(25);
    expect(mechanics.openWater.totalBlocksScanned).toBe(100);
    expect(mechanics.openWater.layerRequiresUniformClassification).toBe(true);
    expect(mechanics.openWater.layerRules).toHaveLength(3);
    expect(mechanics.openWater.outOfWaterTimeLimit).toBe(10);
    expect(mechanics.openWater.maxOutOfWaterTime).toBe(10);
    expect(mechanics.openWater.outOfWaterIncrementPerTick).toBe(1);
    expect(mechanics.openWater.outOfWaterDecrementPerTick).toBe(1);
    expect(mechanics.openWater.reevaluatedOnlyOnceLuredOrBiting).toBe(true);
    expect(mechanics.openWater.latchesFalseUntilTimersReset).toBe(true);
    expect(mechanics.openWater.blockRules).toEqual({
      airIsAboveWater: true,
      lilyPadIsAboveWater: true,
      requiresWaterFluidTag: true,
      requiresSourceFluid: true,
      requiresEmptyCollisionShape: true,
      waterloggedSolidBlocksAreInvalid: true,
      bubbleColumnIsInsideWater: true,
    });
    // Treasure is gated purely by the loot condition; retrieve() never reads the flag.
    expect(mechanics.openWater.enforcedInRetrieveCode).toBe(false);
    expect(mechanics.openWater.enforcedByLootCondition).toBe(true);
  });

  test("pins the luck chain from Luck of the Sea through the Luck mob effect", () => {
    expect(mechanics.luckSources.hookClampMinimum).toBe(0);
    expect(mechanics.luckSources.helperMethod).toBe("EnchantmentHelper.getFishingLuckBonus");
    expect(mechanics.luckSources.helperClampMinimum).toBe(0);
    expect(mechanics.luckSources.enchantment?.id).toBe("minecraft:luck_of_the_sea");
    expect(mechanics.luckSources.enchantment?.maxLevel).toBe(3);
    expect(mechanics.luckSources.enchantment?.base).toBe(1);
    expect(mechanics.luckSources.enchantment?.perLevelAboveFirst).toBe(1);
    expect(mechanics.luckSources.enchantment?.perLevel).toEqual([
      { level: 1, value: 1 },
      { level: 2, value: 2 },
      { level: 3, value: 3 },
    ]);
    expect(mechanics.luckSources.playerLuckAttributeAdded).toBe(true);
    expect(mechanics.luckSources.lootLuckSource).toBe(".withLuck(this.luck + owner.getLuck())");
    expect(mechanics.luckSources.luckAttribute).toEqual({
      id: "minecraft:luck",
      defaultValue: 0,
      minValue: -1024,
      maxValue: 1024,
    });
    expect(mechanics.luckSources.luckEffect?.amount).toBe(1);
    expect(mechanics.luckSources.luckEffect?.amplifierExpression).toBe("this.amount * (amplifier + 1)");
    expect(mechanics.luckSources.luckEffect?.perLevel).toEqual([
      { level: 1, amplifier: 0, luckDelta: 1 },
      { level: 2, amplifier: 1, luckDelta: 2 },
      { level: 3, amplifier: 2, luckDelta: 3 },
    ]);
    expect(mechanics.luckSources.unluckEffect?.amount).toBe(-1);
    expect(mechanics.luckSources.unluckEffect?.perLevel[0]).toEqual({ level: 1, amplifier: 0, luckDelta: -1 });
  });

  test("pins the per-level lure wait windows", () => {
    expect(mechanics.lureSources.secondsToTicks).toBe(20);
    expect(mechanics.lureSources.truncatesToInt).toBe(true);
    expect(mechanics.lureSources.helperMethod).toBe("EnchantmentHelper.getFishingTimeReduction");
    expect(mechanics.lureSources.enchantment?.id).toBe("minecraft:lure");
    expect(mechanics.lureSources.enchantment?.perLevel).toEqual([
      { level: 1, value: 5 },
      { level: 2, value: 10 },
      { level: 3, value: 15 },
    ]);
    expect(mechanics.lureSources.perLevel.map((entry) => [entry.level, entry.ticks])).toEqual([
      [0, 0],
      [1, 100],
      [2, 200],
      [3, 300],
    ]);
    expect(mechanics.lureSources.perLevel[0]).toMatchObject({
      rawWaitMinTicks: 100,
      rawWaitMaxTicks: 600,
      effectiveWaitMinSeconds: 5,
      effectiveWaitMaxSeconds: 30,
      rerollChance: 0,
    });
    // Lure III can roll the wait below zero, which the game discards and re-rolls.
    expect(mechanics.lureSources.perLevel[3]).toMatchObject({
      rawWaitMinTicks: -200,
      rawWaitMaxTicks: 300,
      effectiveWaitMinTicks: 1,
      effectiveWaitMaxTicks: 300,
      effectiveWaitMaxSeconds: 15,
      rerollChance: 0.4012,
    });
  });

  test("pins the luck-weighted loot weight formula", () => {
    expect(mechanics.weightFormula.javaSource).toBe(
      "return Math.max(Mth.floor(LootPoolSingletonContainer.this.weight + LootPoolSingletonContainer.this.quality * luck), 0);",
    );
    expect(mechanics.weightFormula.expression).toBe("max(floor(weight + quality * luck), 0)");
    expect(mechanics.weightFormula.components).toEqual({
      weight: "LootPoolSingletonContainer.this.weight",
      quality: "LootPoolSingletonContainer.this.quality",
      luck: "luck",
    });
    expect(mechanics.weightFormula.floors).toBe(true);
    expect(mechanics.weightFormula.clampMinimum).toBe(0);
    expect(mechanics.weightFormula.defaultWeight).toBe(1);
    expect(mechanics.weightFormula.defaultQuality).toBe(0);
    expect(mechanics.weightFormula.entryIncludedWhenWeightGreaterThan).toBe(0);
    expect(mechanics.weightFormula.bonusRollsSource).toBe(
      "this.rolls.getInt(context) + Mth.floor(this.bonusRolls.getFloat(context) * context.getLuck())",
    );
  });

  test("pins the fishing loot table entries and context", () => {
    expect(mechanics.lootTable.id).toBe("minecraft:gameplay/fishing");
    expect(mechanics.lootTable.paramSet).toBe("minecraft:fishing");
    expect(mechanics.lootTable.contextParams).toEqual(["ORIGIN", "TOOL", "THIS_ENTITY"]);
    expect(mechanics.lootTable.pools).toHaveLength(1);
    expect(mechanics.lootTable.pools[0]?.rolls).toBe(1);
    expect(mechanics.lootTable.pools[0]?.entries).toEqual([
      {
        type: "minecraft:loot_table",
        value: "minecraft:gameplay/fishing/junk",
        weight: 10,
        quality: -2,
        requiresOpenWater: false,
      },
      {
        type: "minecraft:loot_table",
        value: "minecraft:gameplay/fishing/treasure",
        weight: 5,
        quality: 2,
        requiresOpenWater: true,
      },
      {
        type: "minecraft:loot_table",
        value: "minecraft:gameplay/fishing/fish",
        weight: 85,
        quality: -1,
        requiresOpenWater: false,
      },
    ]);
  });

  test("pins the XP reward and rod durability costs", () => {
    expect(mechanics.xp.minPerCatch).toBe(1);
    expect(mechanics.xp.maxPerCatch).toBe(6);
    expect(mechanics.xp.expression).toBe("random.nextInt(6) + 1");
    expect(mechanics.xp.awardedPerCaughtStack).toBe(true);
    expect(mechanics.xp.rodDamageOnCatch).toBe(1);
    expect(mechanics.xp.rodDamageOnGround).toBe(2);
    expect(mechanics.xp.rodDamageOnItemEntity).toBe(3);
    expect(mechanics.xp.rodDamageOnEntity).toBe(5);
    expect(mechanics.xp.itemPullSpeed).toBeCloseTo(0.1);
    expect(mechanics.xp.itemPullArcMultiplier).toBeCloseTo(0.08);
  });
});

describe("fishing mechanics extractor (fixtures)", () => {
  test("returns undefined when FishingHook.java is missing", async () => {
    const root = await createTempClientRoot();
    expect(await new FishingMechanicsExtractor(createConsoleLogger(false)).extract(root)).toBeUndefined();
  });

  test("warns instead of guessing when the surrounding sources are absent", async () => {
    const root = await createTempClientRoot();
    await writeJavaFile(
      root,
      "net/minecraft/world/entity/projectile/FishingHook.java",
      `package net.minecraft.world.entity.projectile;

public class FishingHook extends Projectile {
   private static final int MAX_OUT_OF_WATER_TIME = 10;

   private FishingHook(final EntityType<? extends FishingHook> type, final Level level, final int luck, final int lureSpeed) {
      this.luck = Math.max(0, luck);
      this.lureSpeed = Math.max(0, lureSpeed);
   }

   private void catchingFish(final BlockPos blockPos) {
      int fishingSpeed = 1;
      BlockPos above = blockPos.above();
      if (this.random.nextFloat() < 0.25F && this.level().isRainingAt(above)) {
         fishingSpeed++;
      }

      if (this.timeUntilLured > 0) {
         this.timeUntilLured -= fishingSpeed;
      } else {
         this.timeUntilLured = Mth.nextInt(this.random, 100, 600);
         this.timeUntilLured = this.timeUntilLured - this.lureSpeed;
      }
   }
}`,
    );

    const mechanics = await new FishingMechanicsExtractor(createConsoleLogger(false)).extract(root);

    expect(mechanics).toBeDefined();
    // What is present is parsed exactly...
    expect(mechanics?.waitTime.baseRoll?.minTicks).toBe(100);
    expect(mechanics?.waitTime.baseRoll?.maxTicks).toBe(600);
    expect(mechanics?.rain.rain?.chance).toBe(0.25);
    expect(mechanics?.luckSources.hookClampMinimum).toBe(0);
    expect(mechanics?.openWater.maxOutOfWaterTime).toBe(10);
    // ...and everything absent becomes a warning rather than a hardcoded guess.
    expect(mechanics?.rain.obstructedSky).toBeUndefined();
    expect(mechanics?.hookWindow.approachRoll).toBeUndefined();
    expect(mechanics?.openWater.layerCount).toBeUndefined();
    expect(mechanics?.weightFormula.javaSource).toBeUndefined();
    expect(mechanics?.lureSources.enchantment).toBeUndefined();
    expect(mechanics?.lureSources.perLevel).toEqual([]);
    expect(mechanics?.xp.minPerCatch).toBeUndefined();
    expect(mechanics?.warnings.length).toBeGreaterThan(10);
    expect(mechanics?.warnings.some((warning) => warning.includes("LootPoolSingletonContainer.java"))).toBe(true);
  });
});
