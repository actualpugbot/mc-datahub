import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileExists, readJsonFile } from "../core/fs.js";
import type { Logger } from "../core/logger.js";
import type {
  FishingEnchantmentScaling,
  FishingHookWindow,
  FishingLootPool,
  FishingLootTableInfo,
  FishingLuckEffect,
  FishingLuckSources,
  FishingLureSources,
  FishingMechanics,
  FishingOpenWater,
  FishingOpenWaterBlockRules,
  FishingTeaseChance,
  FishingTickRange,
  FishingWaitTime,
  FishingWeatherEffects,
  FishingWeightFormula,
  FishingXpReward,
} from "../domain/types.js";

const FISHING_HOOK_SOURCE = "net/minecraft/world/entity/projectile/FishingHook.java";
const FISHING_ROD_SOURCE = "net/minecraft/world/item/FishingRodItem.java";
const ENCHANTMENT_HELPER_SOURCE = "net/minecraft/world/item/enchantment/EnchantmentHelper.java";
/** 26.3 snapshots renamed LootPoolSingletonContainer to UniformContainerBase; try both. */
const LOOT_SINGLETON_SOURCES = [
  "net/minecraft/world/level/storage/loot/entries/UniformContainerBase.java",
  "net/minecraft/world/level/storage/loot/entries/LootPoolSingletonContainer.java",
];
const LOOT_POOL_SOURCE = "net/minecraft/world/level/storage/loot/LootPool.java";
const BUILT_IN_LOOT_TABLES_SOURCE = "net/minecraft/world/level/storage/loot/BuiltInLootTables.java";
const MOB_EFFECTS_SOURCE = "net/minecraft/world/effect/MobEffects.java";
const MOB_EFFECT_SOURCE = "net/minecraft/world/effect/MobEffect.java";
const ATTRIBUTES_SOURCE = "net/minecraft/world/entity/ai/attributes/Attributes.java";
const BUBBLE_COLUMN_SOURCE = "net/minecraft/world/level/block/BubbleColumnBlock.java";
const LURE_ENCHANTMENT_PATH = "data/minecraft/enchantment/lure.json";
const LUCK_OF_THE_SEA_ENCHANTMENT_PATH = "data/minecraft/enchantment/luck_of_the_sea.json";
const FISHING_LOOT_TABLE_PATH = "data/minecraft/loot_table/gameplay/fishing.json";

const TICKS_PER_SECOND = 20;

/**
 * The parsed shapes live in the shared domain module alongside the other source-derived datasets;
 * they are re-exported here so consumers can keep importing them from the extractor.
 */
export type {
  FishingTickRange,
  FishingTeaseTier,
  FishingTeaseChance,
  FishingWaitTime,
  FishingSpeedModifier,
  FishingWeatherEffects,
  FishingHookWindow,
  FishingOpenWaterBlockRules,
  FishingOpenWater,
  FishingEnchantmentScaling,
  FishingLuckEffect,
  FishingLuckSources,
  FishingLureLevelEffect,
  FishingLureSources,
  FishingWeightFormula,
  FishingLootEntry,
  FishingLootPool,
  FishingLootTableInfo,
  FishingXpReward,
  FishingMechanics,
} from "../domain/types.js";

interface RawEnchantment {
  effects?: Record<string, unknown>;
  max_level?: number;
}

interface RawLootTable {
  pools?: unknown[];
}

/**
 * Derives the complete fishing loop from decompiled client source: the wait/bite timers in
 * FishingHook.java, the weather and sky modifiers that speed or slow the countdown, the open-water
 * scan, how Lure and Luck of the Sea feed the hook (via FishingRodItem plus the data-driven
 * enchantment JSON), the luck-weighted loot weight formula in LootPoolSingletonContainer.java, and
 * the XP reward. Nothing is assumed: every value traces to a parsed line, and each parse gap becomes
 * a warning rather than a hardcoded number.
 */
export class FishingMechanicsExtractor {
  constructor(private readonly logger: Logger) {}

  async extract(decompiledClientRoot: string): Promise<FishingMechanics | undefined> {
    const hookPath = join(decompiledClientRoot, FISHING_HOOK_SOURCE);
    if (!(await fileExists(hookPath))) {
      this.logger.warn(`Skipping fishing mechanics; ${FISHING_HOOK_SOURCE} was not found under ${decompiledClientRoot}.`);
      return undefined;
    }

    const warnings: string[] = [];
    const sourcePaths: string[] = [FISHING_HOOK_SOURCE];
    const hookSource = await readFile(hookPath, "utf8");
    const catchingFish = methodBody(hookSource, "private void catchingFish(") ?? "";
    const retrieve = methodBody(hookSource, "public int retrieve(") ?? "";
    if (!catchingFish) {
      warnings.push("The catchingFish(BlockPos) method body was not found in FishingHook.java.");
    }
    if (!retrieve) {
      warnings.push("The retrieve(ItemStack) method body was not found in FishingHook.java.");
    }

    const mechanics: FishingMechanics = {
      waitTime: this.readWaitTime(catchingFish, warnings),
      rain: this.readWeatherEffects(catchingFish, warnings),
      hookWindow: this.readHookWindow(catchingFish, warnings),
      openWater: await this.readOpenWater(decompiledClientRoot, hookSource, retrieve, sourcePaths, warnings),
      luckSources: await this.readLuckSources(decompiledClientRoot, hookSource, retrieve, sourcePaths, warnings),
      lureSources: await this.readLureSources(decompiledClientRoot, hookSource, sourcePaths, warnings),
      weightFormula: await this.readWeightFormula(decompiledClientRoot, sourcePaths, warnings),
      lootTable: await this.readLootTable(decompiledClientRoot, retrieve, sourcePaths, warnings),
      xp: this.readXpReward(retrieve, warnings),
      sourcePaths,
      warnings,
    };

    // The wait roll and the lure ticks come from different files, so the per-level wait windows can
    // only be derived once both halves are parsed.
    this.fillLureWaitWindows(mechanics, warnings);

    for (const warning of warnings) {
      this.logger.warn(`Fishing mechanics: ${warning}`);
    }

    return mechanics;
  }

  /**
   * Parses the `timeUntilLured` roll and the statement that applies lure to it. On 26.2 the code is
   * `timeUntilLured = Mth.nextInt(random, 100, 600); timeUntilLured = timeUntilLured - lureSpeed;`,
   * so lure shortens the initial roll rather than accelerating the per-tick countdown.
   */
  private readWaitTime(catchingFish: string, warnings: string[]): FishingWaitTime {
    const waitTime: FishingWaitTime = { sourcePath: FISHING_HOOK_SOURCE };

    const roll = catchingFish.match(
      /this\.timeUntilLured\s*=\s*Mth\.nextInt\(\s*this\.random\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\)\s*;/,
    );
    if (roll) {
      waitTime.baseRoll = tickRange(Number(roll[1]), Number(roll[2]));
    } else {
      warnings.push("The timeUntilLured base roll (Mth.nextInt(random, min, max)) was not found in FishingHook.catchingFish().");
    }

    const lureApplied = catchingFish.match(/this\.timeUntilLured\s*=\s*this\.timeUntilLured\s*-\s*this\.lureSpeed\s*;/);
    if (lureApplied) {
      waitTime.lureApplication = "initial_roll_subtraction";
      waitTime.lureApplicationSource = lureApplied[0];
    } else if (/this\.timeUntilLured\s*-=\s*[^;]*lureSpeed/.test(catchingFish)) {
      waitTime.lureApplication = "countdown_decrement";
      waitTime.lureApplicationSource = catchingFish.match(/this\.timeUntilLured\s*-=\s*[^;]*lureSpeed[^;]*;/)?.[0];
    } else {
      warnings.push("No statement applying lureSpeed to timeUntilLured was found in FishingHook.catchingFish().");
    }

    const countdown = catchingFish.match(/this\.timeUntilLured\s*-=\s*(\w+)\s*;/);
    if (countdown) {
      waitTime.countdownVariable = countdown[1];
    } else {
      warnings.push("The timeUntilLured per-tick decrement was not found in FishingHook.catchingFish().");
    }

    const baseSpeed = catchingFish.match(/int\s+(\w+)\s*=\s*(-?\d+)\s*;/);
    if (baseSpeed && (waitTime.countdownVariable === undefined || baseSpeed[1] === waitTime.countdownVariable)) {
      waitTime.countdownBaseSpeed = Number(baseSpeed[2]);
    } else {
      warnings.push("The base fishingSpeed value was not found in FishingHook.catchingFish().");
    }

    // A roll that lands at or below zero fails the `timeUntilLured > 0` guard on the next tick and
    // falls through to the terminal else branch, which simply rolls a fresh wait.
    waitTime.rerollsWhenNonPositive = /else\s+if\s*\(this\.timeUntilLured\s*>\s*0\)/.test(catchingFish) && lureApplied !== null;
    if (!waitTime.rerollsWhenNonPositive) {
      warnings.push("The `timeUntilLured > 0` guard used to decide non-positive re-roll behaviour was not found.");
    }

    waitTime.teaseChance = this.readTeaseChance(catchingFish, warnings);
    return waitTime;
  }

  private readTeaseChance(catchingFish: string, warnings: string[]): FishingTeaseChance {
    const tease: FishingTeaseChance = { tiers: [] };

    const base = catchingFish.match(/float\s+(\w+)\s*=\s*([\d.]+)F\s*;/);
    if (base) {
      tease.baseChance = Number(base[2]);
    } else {
      warnings.push("The base tease-splash chance was not found in FishingHook.catchingFish().");
    }

    const pattern =
      /if\s*\(this\.timeUntilLured\s*<\s*(\d+)\)\s*\{\s*\w+\s*\+=\s*\(\s*(\d+)\s*-\s*this\.timeUntilLured\s*\)\s*\*\s*([\d.]+)F\s*;/g;
    for (const match of catchingFish.matchAll(pattern)) {
      tease.tiers.push({ belowTicks: Number(match[1]), perTickBelow: Number(match[3]) });
    }
    if (tease.tiers.length === 0) {
      warnings.push("No escalating tease-splash tiers were parsed from FishingHook.catchingFish().");
    }

    return tease;
  }

  /**
   * Parses the two independent per-tick modifiers applied to `fishingSpeed`: rain above the bobber
   * adds one, and an obstructed sky above the bobber subtracts one. Each is gated by its own random
   * roll, so the expected decrement is `base + chance * delta` per modifier.
   */
  private readWeatherEffects(catchingFish: string, warnings: string[]): FishingWeatherEffects {
    const weather: FishingWeatherEffects = { sourcePath: FISHING_HOOK_SOURCE };

    const offset = catchingFish.match(/BlockPos\s+(\w+)\s*=\s*\w+\.above\(\)\s*;/);
    if (offset) {
      weather.checkOffsetY = 1;
    } else {
      warnings.push("The block position sampled for weather/sky (blockPos.above()) was not found in FishingHook.catchingFish().");
    }

    const base = catchingFish.match(/int\s+(\w+)\s*=\s*(-?\d+)\s*;/);
    const speedVariable = base?.[1];
    if (base) {
      weather.baseSpeed = Number(base[2]);
    } else {
      warnings.push("The base fishingSpeed value was not found in FishingHook.catchingFish().");
    }

    const rain = catchingFish.match(
      /if\s*\(this\.random\.nextFloat\(\)\s*<\s*([\d.]+)F\s*&&\s*this\.level\(\)\.isRainingAt\(\w+\)\)\s*\{\s*(\w+)\+\+\s*;/,
    );
    if (rain && (speedVariable === undefined || rain[2] === speedVariable)) {
      weather.rain = { chance: Number(rain[1]), speedDelta: 1, condition: "level.isRainingAt(blockPos.above())" };
    } else {
      warnings.push(
        "The rain fishingSpeed modifier (nextFloat() < N && isRainingAt(...)) was not found in FishingHook.catchingFish().",
      );
    }

    const sky = catchingFish.match(
      /if\s*\(this\.random\.nextFloat\(\)\s*<\s*([\d.]+)F\s*&&\s*!this\.level\(\)\.canSeeSky\(\w+\)\)\s*\{\s*(\w+)--\s*;/,
    );
    if (sky && (speedVariable === undefined || sky[2] === speedVariable)) {
      weather.obstructedSky = { chance: Number(sky[1]), speedDelta: -1, condition: "!level.canSeeSky(blockPos.above())" };
    } else {
      warnings.push(
        "The sky-visibility fishingSpeed modifier (nextFloat() < N && !canSeeSky(...)) was not found in FishingHook.catchingFish().",
      );
    }

    if (weather.baseSpeed !== undefined && weather.rain && weather.obstructedSky) {
      const rainBonus = weather.rain.chance * weather.rain.speedDelta;
      const skyPenalty = weather.obstructedSky.chance * weather.obstructedSky.speedDelta;
      weather.expectedSpeed = {
        clearSkyVisible: round4(weather.baseSpeed),
        rainingSkyVisible: round4(weather.baseSpeed + rainBonus),
        clearSkyObstructed: round4(weather.baseSpeed + skyPenalty),
        rainingSkyObstructed: round4(weather.baseSpeed + rainBonus + skyPenalty),
      };
    }

    return weather;
  }

  /** Parses the two post-wait timers: the fish's approach (`timeUntilHooked`) and the bite (`nibble`). */
  private readHookWindow(catchingFish: string, warnings: string[]): FishingHookWindow {
    const window: FishingHookWindow = { sourcePath: FISHING_HOOK_SOURCE };

    const approach = catchingFish.match(
      /this\.timeUntilHooked\s*=\s*Mth\.nextInt\(\s*this\.random\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\)\s*;/,
    );
    if (approach) {
      window.approachRoll = tickRange(Number(approach[1]), Number(approach[2]));
    } else {
      warnings.push("The timeUntilHooked roll was not found in FishingHook.catchingFish().");
    }

    const nibble = catchingFish.match(/this\.nibble\s*=\s*Mth\.nextInt\(\s*this\.random\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\)\s*;/);
    if (nibble) {
      window.catchableRoll = tickRange(Number(nibble[1]), Number(nibble[2]));
    } else {
      warnings.push("The nibble (catchable window) roll was not found in FishingHook.catchingFish().");
    }

    // Which decrement each post-wait timer uses decides whether rain and sky shorten them too, so a
    // wait-time model can only be derived once both are known.
    const approachDecrement = catchingFish.match(/this\.timeUntilHooked\s*-=\s*(\w+)\s*;/);
    if (approachDecrement) {
      window.approachDecrementVariable = approachDecrement[1];
    } else {
      warnings.push("The timeUntilHooked per-tick decrement was not found in FishingHook.catchingFish().");
    }

    const nibbleDecrement = catchingFish.match(/this\.nibble(?:--|\s*-=\s*(\d+))\s*;/);
    if (nibbleDecrement) {
      window.nibbleDecrementPerTick = nibbleDecrement[1] === undefined ? 1 : Number(nibbleDecrement[1]);
    } else {
      warnings.push("The nibble per-tick decrement was not found in FishingHook.catchingFish().");
    }

    const wobble = catchingFish.match(/this\.fishAngle\s*\+\s*\(float\)this\.random\.triangle\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/);
    if (wobble) {
      window.fishAngleWobble = { center: Number(wobble[1]), radius: Number(wobble[2]) };
    } else {
      warnings.push("The approaching fish's angle wobble (random.triangle) was not found in FishingHook.catchingFish().");
    }

    const approachDistance = catchingFish.match(/\w+\s*\*\s*this\.timeUntilHooked\s*\*\s*([\d.]+)F/);
    if (approachDistance) {
      window.fishApproachBlocksPerRemainingTick = Number(approachDistance[1]);
    } else {
      warnings.push("The fish approach distance factor (timeUntilHooked * N) was not found in FishingHook.catchingFish().");
    }

    const bubble = catchingFish.match(
      /if\s*\(this\.random\.nextFloat\(\)\s*<\s*([\d.]+)F\)\s*\{\s*\w+\.sendParticles\(ParticleTypes\.BUBBLE/,
    );
    if (bubble) {
      window.approachBubbleParticleChance = Number(bubble[1]);
    } else {
      warnings.push("The approach bubble-particle chance was not found in FishingHook.catchingFish().");
    }

    window.missedBiteResetsTimers =
      /if\s*\(this\.nibble\s*<=\s*0\)\s*\{\s*this\.timeUntilLured\s*=\s*0\s*;\s*this\.timeUntilHooked\s*=\s*0\s*;/.test(
        catchingFish,
      );
    if (!window.missedBiteResetsTimers) {
      warnings.push(
        "The missed-bite timer reset (nibble <= 0 -> timeUntilLured/timeUntilHooked = 0) was not found in FishingHook.catchingFish().",
      );
    }

    return window;
  }

  /**
   * Parses `calculateOpenWater` (the 4 stacked layers and their allowed transitions), the per-block
   * classifier `getOpenWaterTypeForBlock`, and the `outOfWaterTime` bookkeeping in tick(). Also
   * checks whether `retrieve` consults the flag at all: on 26.2 it does not, the fishing loot table
   * gates treasure through the `in_open_water` predicate instead.
   */
  private async readOpenWater(
    root: string,
    hookSource: string,
    retrieve: string,
    sourcePaths: string[],
    warnings: string[],
  ): Promise<FishingOpenWater> {
    const openWater: FishingOpenWater = { sourcePaths: [FISHING_HOOK_SOURCE] };

    const calculate = methodBody(hookSource, "private boolean calculateOpenWater(");
    if (calculate) {
      const loop = calculate.match(/for\s*\(int\s+(\w+)\s*=\s*(-?\d+);\s*\1\s*<=\s*(-?\d+);\s*\1\+\+\)/);
      if (loop) {
        openWater.layerMinY = Number(loop[2]);
        openWater.layerMaxY = Number(loop[3]);
        openWater.layerCount = openWater.layerMaxY - openWater.layerMinY + 1;
      } else {
        warnings.push("The vertical layer loop was not found in FishingHook.calculateOpenWater().");
      }

      const area = calculate.match(
        /\w+\.offset\(\s*(-?\d+)\s*,\s*\w+\s*,\s*(-?\d+)\s*\)\s*,\s*\w+\.offset\(\s*(-?\d+)\s*,\s*\w+\s*,\s*(-?\d+)\s*\)/,
      );
      if (area) {
        const minX = Number(area[1]);
        const minZ = Number(area[2]);
        const maxX = Number(area[3]);
        const maxZ = Number(area[4]);
        openWater.areaMinOffsetXZ = minX;
        openWater.areaMaxOffsetXZ = maxX;
        openWater.areaWidth = maxX - minX + 1;
        openWater.areaDepth = maxZ - minZ + 1;
        openWater.blocksPerLayer = openWater.areaWidth * openWater.areaDepth;
        if (openWater.layerCount !== undefined) {
          openWater.totalBlocksScanned = openWater.blocksPerLayer * openWater.layerCount;
        }
      } else {
        warnings.push("The scanned area corners (blockPos.offset(...)) were not found in FishingHook.calculateOpenWater().");
      }

      const rules: string[] = [];
      if (
        /case ABOVE_WATER:\s*if\s*\(previousLayer\s*==\s*FishingHook\.OpenWaterType\.INVALID\)\s*\{?\s*return false;/.test(
          calculate,
        )
      ) {
        rules.push(
          "An ABOVE_WATER layer is only allowed once a previous layer has been classified; the very first layer may not be ABOVE_WATER.",
        );
      }
      if (
        /case INSIDE_WATER:\s*if\s*\(previousLayer\s*==\s*FishingHook\.OpenWaterType\.ABOVE_WATER\)\s*\{?\s*return false;/.test(
          calculate,
        )
      ) {
        rules.push("An INSIDE_WATER layer may not sit above an ABOVE_WATER layer, so water can never re-appear above air.");
      }
      if (/case INVALID:\s*return false;/.test(calculate)) {
        rules.push("Any INVALID layer immediately fails the check.");
      }
      if (rules.length === 3) {
        openWater.layerRules = rules;
      } else {
        warnings.push("The layer transition rules in FishingHook.calculateOpenWater() were not fully parsed.");
      }
    } else {
      warnings.push("The calculateOpenWater(BlockPos) method body was not found in FishingHook.java.");
    }

    const area = methodBody(hookSource, "private FishingHook.OpenWaterType getOpenWaterTypeForArea(");
    openWater.layerRequiresUniformClassification = area
      ? /reduce\(\(\w+,\s*\w+\)\s*->\s*\w+\s*==\s*\w+\s*\?\s*\w+\s*:\s*FishingHook\.OpenWaterType\.INVALID\)/.test(area)
      : false;
    if (!openWater.layerRequiresUniformClassification) {
      warnings.push("The uniform-classification reduce in FishingHook.getOpenWaterTypeForArea() was not found.");
    }

    openWater.blockRules = await this.readOpenWaterBlockRules(root, hookSource, sourcePaths, warnings);

    const reset = hookSource.match(
      /if\s*\(this\.nibble\s*<=\s*0\s*&&\s*this\.timeUntilHooked\s*<=\s*0\)\s*\{\s*this\.openWater\s*=\s*true\s*;/,
    );
    openWater.reevaluatedOnlyOnceLuredOrBiting = reset !== null;
    if (!reset) {
      warnings.push("The `nibble <= 0 && timeUntilHooked <= 0 -> openWater = true` reset was not found in FishingHook.tick().");
    }

    const latch = hookSource.match(
      /this\.openWater\s*=\s*this\.openWater\s*&&\s*this\.outOfWaterTime\s*<\s*(\d+)\s*&&\s*this\.calculateOpenWater\(/,
    );
    if (latch) {
      openWater.latchesFalseUntilTimersReset = true;
      openWater.outOfWaterTimeLimit = Number(latch[1]);
    } else {
      warnings.push(
        "The `openWater = openWater && outOfWaterTime < N && calculateOpenWater(...)` guard was not found in FishingHook.tick().",
      );
    }

    const maxOutOfWater = hookSource.match(/static\s+final\s+int\s+MAX_OUT_OF_WATER_TIME\s*=\s*(\d+)\s*;/);
    if (maxOutOfWater) {
      openWater.maxOutOfWaterTime = Number(maxOutOfWater[1]);
    } else {
      warnings.push("The MAX_OUT_OF_WATER_TIME constant was not found in FishingHook.java.");
    }

    const increment = hookSource.match(
      /this\.outOfWaterTime\s*=\s*Math\.min\(\s*\d+\s*,\s*this\.outOfWaterTime\s*\+\s*(\d+)\s*\)/,
    );
    if (increment) {
      openWater.outOfWaterIncrementPerTick = Number(increment[1]);
    } else {
      warnings.push("The outOfWaterTime increment was not found in FishingHook.tick().");
    }

    const decrement = hookSource.match(
      /this\.outOfWaterTime\s*=\s*Math\.max\(\s*\d+\s*,\s*this\.outOfWaterTime\s*-\s*(\d+)\s*\)/,
    );
    if (decrement) {
      openWater.outOfWaterDecrementPerTick = Number(decrement[1]);
    } else {
      warnings.push("The outOfWaterTime decrement was not found in FishingHook.tick().");
    }

    openWater.enforcedInRetrieveCode = /openWater|isOpenWaterFishing/.test(retrieve);

    const lootTablePath = join(root, FISHING_LOOT_TABLE_PATH);
    if (await fileExists(lootTablePath)) {
      const raw = await readFile(lootTablePath, "utf8");
      openWater.enforcedByLootCondition = /"in_open_water"\s*:\s*true/.test(raw);
      if (!openWater.enforcedByLootCondition) {
        warnings.push(`No "in_open_water": true condition was found in ${FISHING_LOOT_TABLE_PATH}.`);
      }
      openWater.sourcePaths.push(FISHING_LOOT_TABLE_PATH);
    } else {
      warnings.push(`${FISHING_LOOT_TABLE_PATH} was not found; the open-water loot condition could not be confirmed.`);
    }

    return openWater;
  }

  private async readOpenWaterBlockRules(
    root: string,
    hookSource: string,
    sourcePaths: string[],
    warnings: string[],
  ): Promise<FishingOpenWaterBlockRules> {
    const rules: FishingOpenWaterBlockRules = {};
    const classifier = methodBody(hookSource, "private FishingHook.OpenWaterType getOpenWaterTypeForBlock(");
    if (!classifier) {
      warnings.push("The getOpenWaterTypeForBlock(BlockPos) method body was not found in FishingHook.java.");
      return rules;
    }

    const aboveWater = classifier.match(/if\s*\(!(\w+)\.isAir\(\)\s*&&\s*!\1\.is\(Blocks\.(\w+)\)\)/);
    if (aboveWater) {
      rules.airIsAboveWater = true;
      rules.lilyPadIsAboveWater = aboveWater[2] === "LILY_PAD";
      if (!rules.lilyPadIsAboveWater) {
        warnings.push(`The air-equivalent block in getOpenWaterTypeForBlock() is Blocks.${aboveWater[2]}, not Blocks.LILY_PAD.`);
      }
    } else {
      warnings.push(
        "The `!isAir() && !is(Blocks.LILY_PAD)` ABOVE_WATER test was not found in FishingHook.getOpenWaterTypeForBlock().",
      );
    }

    const insideWater = classifier.match(
      /(\w+)\.is\(FluidTags\.WATER\)\s*&&\s*\1\.isSource\(\)\s*&&\s*\w+\.getCollisionShape\([\s\S]*?\)\.isEmpty\(\)/,
    );
    if (insideWater) {
      rules.requiresWaterFluidTag = true;
      rules.requiresSourceFluid = true;
      rules.requiresEmptyCollisionShape = true;
      rules.waterloggedSolidBlocksAreInvalid = true;
    } else {
      warnings.push(
        "The INSIDE_WATER test (water fluid tag + source + empty collision shape) was not found in FishingHook.getOpenWaterTypeForBlock().",
      );
    }

    // Bubble columns are the interesting edge case: they report a water source fluid and an empty
    // shape, so they satisfy the INSIDE_WATER test even though they are not water blocks.
    const bubblePath = join(root, BUBBLE_COLUMN_SOURCE);
    if (await fileExists(bubblePath)) {
      const bubbleSource = await readFile(bubblePath, "utf8");
      const fluid = /FluidState\s+getFluidState\([^)]*\)\s*\{\s*return\s+Fluids\.WATER\.getSource\(/.test(bubbleSource);
      const shape = /VoxelShape\s+getShape\([^)]*\)\s*\{\s*return\s+Shapes\.empty\(\)/.test(bubbleSource);
      if (fluid && shape) {
        rules.bubbleColumnIsInsideWater = rules.requiresEmptyCollisionShape === true;
      } else {
        warnings.push(
          "BubbleColumnBlock.getFluidState()/getShape() did not match the expected water-source + empty-shape pattern.",
        );
      }
      sourcePaths.push(BUBBLE_COLUMN_SOURCE);
    } else {
      warnings.push(`${BUBBLE_COLUMN_SOURCE} was not found; bubble-column open-water behaviour could not be derived.`);
    }

    return rules;
  }

  /**
   * Resolves the whole luck chain: the enchantment JSON, the `EnchantmentHelper` clamp, the hook's
   * own clamp, the player's Luck attribute (which is added on top at loot time), and the Luck /
   * Unluck mob effects that move that attribute.
   */
  private async readLuckSources(
    root: string,
    hookSource: string,
    retrieve: string,
    sourcePaths: string[],
    warnings: string[],
  ): Promise<FishingLuckSources> {
    const luck: FishingLuckSources = { sourcePaths: [FISHING_HOOK_SOURCE] };

    const clamp = hookSource.match(/this\.luck\s*=\s*Math\.max\(\s*(-?\d+)\s*,\s*luck\s*\)\s*;/);
    if (clamp) {
      luck.hookClampMinimum = Number(clamp[1]);
      luck.hookClampSource = clamp[0];
    } else {
      warnings.push("The `this.luck = Math.max(0, luck)` clamp was not found in FishingHook.java.");
    }

    const withLuck = retrieve.match(/\.withLuck\((.+)\)\s*$/m);
    if (withLuck) {
      luck.lootLuckSource = withLuck[0];
      luck.playerLuckAttributeAdded = /getLuck\(\)/.test(withLuck[1] ?? "");
      if (!luck.playerLuckAttributeAdded) {
        warnings.push("The loot context luck does not include the player's getLuck() attribute; verify FishingHook.retrieve().");
      }
    } else {
      warnings.push("The withLuck(...) call seeding the loot context was not found in FishingHook.retrieve().");
    }

    const rodPath = join(root, FISHING_ROD_SOURCE);
    if (await fileExists(rodPath)) {
      const rodSource = await readFile(rodPath, "utf8");
      const helper = rodSource.match(/EnchantmentHelper\.(getFishingLuckBonus)\(/);
      if (helper) {
        luck.helperMethod = `EnchantmentHelper.${helper[1]}`;
      } else {
        warnings.push("No EnchantmentHelper luck-bonus call was found in FishingRodItem.java.");
      }
      luck.sourcePaths.push(FISHING_ROD_SOURCE);
      pushUnique(sourcePaths, FISHING_ROD_SOURCE);
    } else {
      warnings.push(`${FISHING_ROD_SOURCE} was not found; the luck input to FishingHook could not be traced.`);
    }

    const helperPath = join(root, ENCHANTMENT_HELPER_SOURCE);
    if (await fileExists(helperPath)) {
      const helperSource = await readFile(helperPath, "utf8");
      const body = methodBody(helperSource, "public static int getFishingLuckBonus(");
      const helperClamp = body?.match(/Math\.max\(\s*(-?\d+)\s*,\s*\w+\.intValue\(\)\s*\)/);
      if (helperClamp) {
        luck.helperClampMinimum = Number(helperClamp[1]);
      } else {
        warnings.push("The clamp inside EnchantmentHelper.getFishingLuckBonus() was not found.");
      }
      luck.sourcePaths.push(ENCHANTMENT_HELPER_SOURCE);
      pushUnique(sourcePaths, ENCHANTMENT_HELPER_SOURCE);
    } else {
      warnings.push(`${ENCHANTMENT_HELPER_SOURCE} was not found; the luck clamp could not be confirmed.`);
    }

    const enchantment = await this.readEnchantmentScaling(
      root,
      LUCK_OF_THE_SEA_ENCHANTMENT_PATH,
      "minecraft:luck_of_the_sea",
      "minecraft:fishing_luck_bonus",
      warnings,
    );
    if (enchantment) {
      luck.enchantment = enchantment;
      luck.sourcePaths.push(LUCK_OF_THE_SEA_ENCHANTMENT_PATH);
      pushUnique(sourcePaths, LUCK_OF_THE_SEA_ENCHANTMENT_PATH);
    }

    const attributesPath = join(root, ATTRIBUTES_SOURCE);
    if (await fileExists(attributesPath)) {
      const attributesSource = await readFile(attributesPath, "utf8");
      const attribute = attributesSource.match(
        /LUCK\s*=\s*register\(\s*"(\w+)"\s*,\s*new RangedAttribute\(\s*"[^"]*"\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/,
      );
      if (attribute) {
        luck.luckAttribute = {
          id: `minecraft:${attribute[1]}`,
          defaultValue: Number(attribute[2]),
          minValue: Number(attribute[3]),
          maxValue: Number(attribute[4]),
        };
      } else {
        warnings.push("The Attributes.LUCK RangedAttribute registration was not found in Attributes.java.");
      }
      luck.sourcePaths.push(ATTRIBUTES_SOURCE);
      pushUnique(sourcePaths, ATTRIBUTES_SOURCE);
    } else {
      warnings.push(`${ATTRIBUTES_SOURCE} was not found; the luck attribute bounds are unknown.`);
    }

    const amplifierExpression = await this.readAmplifierExpression(root, sourcePaths, warnings);
    const effectsPath = join(root, MOB_EFFECTS_SOURCE);
    if (await fileExists(effectsPath)) {
      const effectsSource = await readFile(effectsPath, "utf8");
      luck.luckEffect = this.readLuckEffect(effectsSource, "LUCK", amplifierExpression, warnings);
      luck.unluckEffect = this.readLuckEffect(effectsSource, "UNLUCK", amplifierExpression, warnings);
      luck.sourcePaths.push(MOB_EFFECTS_SOURCE);
      pushUnique(sourcePaths, MOB_EFFECTS_SOURCE);
    } else {
      warnings.push(`${MOB_EFFECTS_SOURCE} was not found; the Luck/Unluck effect magnitudes are unknown.`);
    }

    return luck;
  }

  /** Reads `MobEffect.AttributeTemplate.create`, which scales each modifier by `amplifier + 1`. */
  private async readAmplifierExpression(root: string, sourcePaths: string[], warnings: string[]): Promise<string | undefined> {
    const path = join(root, MOB_EFFECT_SOURCE);
    if (!(await fileExists(path))) {
      warnings.push(`${MOB_EFFECT_SOURCE} was not found; the effect amplifier scaling could not be derived.`);
      return undefined;
    }
    const source = await readFile(path, "utf8");
    const match = source.match(
      /new AttributeModifier\(\s*this\.id\s*,\s*(this\.amount\s*\*\s*\(\s*amplifier\s*\+\s*\d+\s*\))\s*,/,
    );
    pushUnique(sourcePaths, MOB_EFFECT_SOURCE);
    if (!match) {
      warnings.push("The AttributeTemplate.create amplifier scaling was not found in MobEffect.java.");
      return undefined;
    }
    return match[1]?.replace(/\s+/g, " ");
  }

  private readLuckEffect(
    effectsSource: string,
    symbol: "LUCK" | "UNLUCK",
    amplifierExpression: string | undefined,
    warnings: string[],
  ): FishingLuckEffect | undefined {
    const pattern = new RegExp(
      `\\b${symbol}\\s*=\\s*register\\(\\s*"(\\w+)"[\\s\\S]{0,400}?\\.addAttributeModifier\\(\\s*Attributes\\.(\\w+)\\s*,[^,]*,\\s*(-?[\\d.]+)\\s*,\\s*AttributeModifier\\.Operation\\.(\\w+)\\s*\\)`,
    );
    const match = effectsSource.match(pattern);
    if (!match) {
      warnings.push(`The MobEffects.${symbol} luck attribute modifier was not found in MobEffects.java.`);
      return undefined;
    }

    const amount = Number(match[3]);
    const effect: FishingLuckEffect = {
      id: `minecraft:${match[1]}`,
      attribute: `minecraft:${match[2]?.toLowerCase()}`,
      amount,
      operation: match[4],
      perLevel: [],
    };
    if (amplifierExpression) {
      effect.amplifierExpression = amplifierExpression;
      for (let amplifier = 0; amplifier < 3; amplifier++) {
        effect.perLevel.push({ level: amplifier + 1, amplifier, luckDelta: round4(amount * (amplifier + 1)) });
      }
    }
    return effect;
  }

  /**
   * Resolves the lure chain: the enchantment's seconds value, the `* 20` seconds-to-ticks conversion
   * in FishingRodItem, and the clamps in EnchantmentHelper and FishingHook.
   */
  private async readLureSources(
    root: string,
    hookSource: string,
    sourcePaths: string[],
    warnings: string[],
  ): Promise<FishingLureSources> {
    const lure: FishingLureSources = { perLevel: [], sourcePaths: [FISHING_HOOK_SOURCE] };

    const clamp = hookSource.match(/this\.lureSpeed\s*=\s*Math\.max\(\s*(-?\d+)\s*,\s*lureSpeed\s*\)\s*;/);
    if (clamp) {
      lure.hookClampMinimum = Number(clamp[1]);
      lure.hookClampSource = clamp[0];
    } else {
      warnings.push("The `this.lureSpeed = Math.max(0, lureSpeed)` clamp was not found in FishingHook.java.");
    }

    const rodPath = join(root, FISHING_ROD_SOURCE);
    if (await fileExists(rodPath)) {
      const rodSource = await readFile(rodPath, "utf8");
      const conversion = rodSource.match(
        /int\s+lureSpeed\s*=\s*\(int\)\(\s*EnchantmentHelper\.(getFishingTimeReduction)\([^)]*\)\s*\*\s*([\d.]+)F\s*\)\s*;/,
      );
      if (conversion) {
        lure.helperMethod = `EnchantmentHelper.${conversion[1]}`;
        lure.secondsToTicks = Number(conversion[2]);
        lure.conversionSource = conversion[0];
        lure.truncatesToInt = true;
      } else {
        warnings.push("The lureSpeed seconds-to-ticks conversion was not found in FishingRodItem.java.");
      }
      lure.sourcePaths.push(FISHING_ROD_SOURCE);
      pushUnique(sourcePaths, FISHING_ROD_SOURCE);
    } else {
      warnings.push(`${FISHING_ROD_SOURCE} was not found; the lureSpeed input to FishingHook could not be traced.`);
    }

    const helperPath = join(root, ENCHANTMENT_HELPER_SOURCE);
    if (await fileExists(helperPath)) {
      const helperSource = await readFile(helperPath, "utf8");
      const body = methodBody(helperSource, "public static float getFishingTimeReduction(");
      const helperClamp = body?.match(/Math\.max\(\s*(-?[\d.]+)F\s*,\s*\w+\.floatValue\(\)\s*\)/);
      if (helperClamp) {
        lure.helperClampMinimum = Number(helperClamp[1]);
      } else {
        warnings.push("The clamp inside EnchantmentHelper.getFishingTimeReduction() was not found.");
      }
      lure.sourcePaths.push(ENCHANTMENT_HELPER_SOURCE);
      pushUnique(sourcePaths, ENCHANTMENT_HELPER_SOURCE);
    } else {
      warnings.push(`${ENCHANTMENT_HELPER_SOURCE} was not found; the lure clamp could not be confirmed.`);
    }

    const enchantment = await this.readEnchantmentScaling(
      root,
      LURE_ENCHANTMENT_PATH,
      "minecraft:lure",
      "minecraft:fishing_time_reduction",
      warnings,
    );
    if (enchantment) {
      lure.enchantment = enchantment;
      lure.sourcePaths.push(LURE_ENCHANTMENT_PATH);
      pushUnique(sourcePaths, LURE_ENCHANTMENT_PATH);
    }

    return lure;
  }

  /** Turns the parsed lure levels plus the parsed wait roll into concrete per-level wait windows. */
  private fillLureWaitWindows(mechanics: FishingMechanics, warnings: string[]): void {
    const { lureSources, waitTime } = mechanics;
    const roll = waitTime.baseRoll;
    const secondsToTicks = lureSources.secondsToTicks;
    const enchantment = lureSources.enchantment;

    if (!roll || secondsToTicks === undefined || !enchantment || enchantment.maxLevel === undefined) {
      warnings.push(
        "Per-level lure wait windows were not derived; the wait roll, tick conversion, or lure enchantment is missing.",
      );
      return;
    }
    if (waitTime.lureApplication !== "initial_roll_subtraction") {
      warnings.push("Per-level lure wait windows assume lure subtracts from the initial roll; the parsed application differs.");
      return;
    }

    const levels: Array<{ level: number; seconds: number }> = [{ level: 0, seconds: 0 }];
    for (const entry of enchantment.perLevel) {
      levels.push({ level: entry.level, seconds: entry.value });
    }

    for (const { level, seconds } of levels) {
      const ticks = Math.max(lureSources.hookClampMinimum ?? 0, Math.trunc(seconds * secondsToTicks));
      const rawMin = roll.minTicks - ticks;
      const rawMax = roll.maxTicks - ticks;
      // A roll whose result is <= 0 fails the `timeUntilLured > 0` guard and is re-rolled.
      const discarded = clamp(Math.min(roll.maxTicks, ticks) - roll.minTicks + 1, 0, roll.outcomes);
      lureSources.perLevel.push({
        level,
        seconds,
        ticks,
        rawWaitMinTicks: rawMin,
        rawWaitMaxTicks: rawMax,
        effectiveWaitMinTicks: Math.max(1, rawMin),
        effectiveWaitMinSeconds: round4(Math.max(1, rawMin) / TICKS_PER_SECOND),
        effectiveWaitMaxTicks: rawMax,
        effectiveWaitMaxSeconds: round4(rawMax / TICKS_PER_SECOND),
        rerollChance: round4(discarded / roll.outcomes),
      });
    }
  }

  /** Reads a data-driven `add(linear(base, per_level_above_first))` enchantment value effect. */
  private async readEnchantmentScaling(
    root: string,
    relativePath: string,
    id: string,
    effectComponent: string,
    warnings: string[],
  ): Promise<FishingEnchantmentScaling | undefined> {
    const path = join(root, relativePath);
    if (!(await fileExists(path))) {
      warnings.push(`${relativePath} was not found; ${id} scaling could not be derived.`);
      return undefined;
    }

    let raw: RawEnchantment;
    try {
      raw = await readJsonFile<RawEnchantment>(path);
    } catch (error) {
      warnings.push(`Could not read ${relativePath}: ${(error as Error).message}.`);
      return undefined;
    }

    const scaling: FishingEnchantmentScaling = { id, effectComponent, perLevel: [], sourcePath: relativePath };

    if (typeof raw.max_level === "number") {
      scaling.maxLevel = raw.max_level;
    } else {
      warnings.push(`${relativePath} has no numeric max_level.`);
    }

    const entries = raw.effects?.[effectComponent];
    const first = Array.isArray(entries) ? entries[0] : undefined;
    const effect = isRecord(first) && isRecord(first.effect) ? first.effect : undefined;
    if (!effect) {
      warnings.push(`${relativePath} has no ${effectComponent} effect entry.`);
      return scaling;
    }

    if (typeof effect.type === "string") {
      scaling.effectType = effect.type;
    }
    const value = effect.value;
    if (!isRecord(value) || typeof value.base !== "number" || typeof value.per_level_above_first !== "number") {
      warnings.push(`${relativePath} has no linear { base, per_level_above_first } value for ${effectComponent}.`);
      return scaling;
    }

    scaling.valueType = typeof value.type === "string" ? value.type : undefined;
    scaling.base = value.base;
    scaling.perLevelAboveFirst = value.per_level_above_first;

    if (scaling.maxLevel !== undefined) {
      for (let level = 1; level <= scaling.maxLevel; level++) {
        scaling.perLevel.push({ level, value: round4(scaling.base + (level - 1) * scaling.perLevelAboveFirst) });
      }
    }

    return scaling;
  }

  /**
   * Parses the effective-weight formula that turns loot-context luck into a per-entry weight. The
   * exact Java on 26.2 is:
   *
   *   return Math.max(Mth.floor(LootPoolSingletonContainer.this.weight + LootPoolSingletonContainer.this.quality * luck), 0);
   *
   * `weight` and `quality` are ints and `luck` is a float, so `quality * luck` is float arithmetic,
   * the sum is float, and `Mth.floor` (which is `(int)Math.floor(v)`) truncates downwards before the
   * result is clamped to 0. Negative quality therefore rounds *down*, not toward zero.
   */
  private async readWeightFormula(root: string, sourcePaths: string[], warnings: string[]): Promise<FishingWeightFormula> {
    const formula: FishingWeightFormula = { sourcePaths: [] };

    let singletonSource: string | undefined;
    for (const candidate of LOOT_SINGLETON_SOURCES) {
      if (await fileExists(join(root, candidate))) {
        singletonSource = candidate;
        break;
      }
    }
    if (singletonSource !== undefined) {
      const source = await readFile(join(root, singletonSource), "utf8");
      const weightLine = source.match(
        /return\s+Math\.max\(\s*Mth\.floor\(\s*([\w.]*\bweight\b)\s*\+\s*([\w.]*\bquality\b)\s*\*\s*(\w+)\s*\)\s*,\s*(-?\d+)\s*\)\s*;/,
      );
      if (weightLine) {
        formula.javaSource = weightLine[0].replace(/\s+/g, " ");
        formula.components = { weight: weightLine[1]!, quality: weightLine[2]!, luck: weightLine[3]! };
        formula.expression = "max(floor(weight + quality * luck), 0)";
        formula.floors = true;
        formula.clampMinimum = Number(weightLine[4]);
        formula.arithmeticNotes =
          "weight and quality are ints, luck is a float: quality * luck is float arithmetic, the sum is float, and Mth.floor (int)Math.floor truncates downwards before the clamp.";
      } else {
        warnings.push(`The getWeight(float luck) formula was not found in ${singletonSource}.`);
      }

      const defaultWeight = source.match(/optionalFieldOf\(\s*"weight"\s*,\s*(-?\d+)\s*\)/);
      if (defaultWeight) {
        formula.defaultWeight = Number(defaultWeight[1]);
      } else {
        warnings.push(`The default loot entry weight was not found in ${singletonSource}.`);
      }

      const defaultQuality = source.match(/optionalFieldOf\(\s*"quality"\s*,\s*(-?\d+)\s*\)/);
      if (defaultQuality) {
        formula.defaultQuality = Number(defaultQuality[1]);
      } else {
        warnings.push(`The default loot entry quality was not found in ${singletonSource}.`);
      }

      formula.sourcePaths.push(singletonSource);
      pushUnique(sourcePaths, singletonSource);
    } else {
      warnings.push(
        `None of ${LOOT_SINGLETON_SOURCES.join(", ")} were found; the effective-weight formula could not be derived.`,
      );
    }

    const poolPath = join(root, LOOT_POOL_SOURCE);
    if (await fileExists(poolPath)) {
      const source = await readFile(poolPath, "utf8");

      const include = source.match(
        /int\s+weight\s*=\s*\w+\.getWeight\(\s*\w+\.getLuck\(\)\s*\)\s*;\s*if\s*\(\s*weight\s*>\s*(-?\d+)\s*\)/,
      );
      if (include) {
        formula.entryIncludedWhenWeightGreaterThan = Number(include[1]);
      } else {
        warnings.push("The `weight > 0` entry inclusion test was not found in LootPool.java.");
      }

      const selection = source.match(/int\s+index\s*=\s*\w+\.nextInt\(\s*\w+\.intValue\(\)\s*\)\s*;/);
      if (selection) {
        formula.selectionSource = selection[0].replace(/\s+/g, " ");
      } else {
        warnings.push("The uniform weight selection (random.nextInt(totalWeight)) was not found in LootPool.java.");
      }

      // 26.3 snapshots wrap rolls/bonusRolls in Holder, adding `.value()` before the getters.
      const bonusRolls = source.match(
        /this\.rolls(?:\.value\(\))?\.getInt\(\s*\w+\s*\)\s*\+\s*Mth\.floor\(\s*this\.bonusRolls(?:\.value\(\))?\.getFloat\(\s*\w+\s*\)\s*\*\s*\w+\.getLuck\(\)\s*\)/,
      );
      if (bonusRolls) {
        formula.bonusRollsSource = bonusRolls[0].replace(/\s+/g, " ");
      } else {
        warnings.push("The bonus-rolls luck term was not found in LootPool.java.");
      }

      formula.sourcePaths.push(LOOT_POOL_SOURCE);
      pushUnique(sourcePaths, LOOT_POOL_SOURCE);
    } else {
      warnings.push(`${LOOT_POOL_SOURCE} was not found; the pool selection details could not be derived.`);
    }

    return formula;
  }

  /** Reads the loot table key and context params from `retrieve`, plus the table's own pool shape. */
  private async readLootTable(
    root: string,
    retrieve: string,
    sourcePaths: string[],
    warnings: string[],
  ): Promise<FishingLootTableInfo> {
    const info: FishingLootTableInfo = { contextParams: [], pools: [], sourcePaths: [FISHING_HOOK_SOURCE] };

    for (const match of retrieve.matchAll(/\.withParameter\(\s*LootContextParams\.(\w+)\s*,/g)) {
      info.contextParams.push(match[1]!);
    }
    if (info.contextParams.length === 0) {
      warnings.push("No LootContextParams were parsed from FishingHook.retrieve().");
    }

    const paramSet = retrieve.match(/\.create\(\s*LootContextParamSets\.(\w+)\s*\)/);
    if (paramSet) {
      info.paramSet = `minecraft:${paramSet[1]!.toLowerCase()}`;
    } else {
      warnings.push("The LootContextParamSets used by FishingHook.retrieve() was not found.");
    }

    const tableSymbol = retrieve.match(/getLootTable\(\s*BuiltInLootTables\.(\w+)\s*\)/);
    if (tableSymbol) {
      const tablesPath = join(root, BUILT_IN_LOOT_TABLES_SOURCE);
      if (await fileExists(tablesPath)) {
        const tablesSource = await readFile(tablesPath, "utf8");
        const registration = tablesSource.match(new RegExp(`\\b${tableSymbol[1]}\\s*=\\s*register\\(\\s*"([^"]+)"\\s*\\)`));
        if (registration) {
          info.id = `minecraft:${registration[1]}`;
        } else {
          warnings.push(`BuiltInLootTables.${tableSymbol[1]} has no register("...") entry in BuiltInLootTables.java.`);
        }
        info.sourcePaths.push(BUILT_IN_LOOT_TABLES_SOURCE);
        pushUnique(sourcePaths, BUILT_IN_LOOT_TABLES_SOURCE);
      } else {
        warnings.push(`${BUILT_IN_LOOT_TABLES_SOURCE} was not found; the fishing loot table id could not be resolved.`);
      }
    } else {
      warnings.push("The BuiltInLootTables reference was not found in FishingHook.retrieve().");
    }

    const tablePath = join(root, FISHING_LOOT_TABLE_PATH);
    if (await fileExists(tablePath)) {
      let raw: RawLootTable;
      try {
        raw = await readJsonFile<RawLootTable>(tablePath);
      } catch (error) {
        warnings.push(`Could not read ${FISHING_LOOT_TABLE_PATH}: ${(error as Error).message}.`);
        return info;
      }

      for (const rawPool of Array.isArray(raw.pools) ? raw.pools : []) {
        if (!isRecord(rawPool)) {
          continue;
        }
        const pool: FishingLootPool = { entries: [] };
        if (typeof rawPool.rolls === "number") {
          pool.rolls = rawPool.rolls;
        }
        if (typeof rawPool.bonus_rolls === "number") {
          pool.bonusRolls = rawPool.bonus_rolls;
        }
        for (const rawEntry of Array.isArray(rawPool.entries) ? rawPool.entries : []) {
          if (!isRecord(rawEntry)) {
            continue;
          }
          pool.entries.push({
            type: typeof rawEntry.type === "string" ? rawEntry.type : "unknown",
            ...(typeof rawEntry.value === "string" ? { value: rawEntry.value } : {}),
            ...(typeof rawEntry.weight === "number" ? { weight: rawEntry.weight } : {}),
            ...(typeof rawEntry.quality === "number" ? { quality: rawEntry.quality } : {}),
            requiresOpenWater: JSON.stringify(rawEntry.conditions ?? []).includes('"in_open_water":true'),
          });
        }
        info.pools.push(pool);
      }

      if (info.pools.length === 0) {
        warnings.push(`No pools were parsed from ${FISHING_LOOT_TABLE_PATH}.`);
      }
      info.sourcePaths.push(FISHING_LOOT_TABLE_PATH);
      pushUnique(sourcePaths, FISHING_LOOT_TABLE_PATH);
    } else {
      warnings.push(`${FISHING_LOOT_TABLE_PATH} was not found; the fishing pool shape is unknown.`);
    }

    return info;
  }

  /** Parses the XP orb roll, the rod durability costs, and the item pull physics from `retrieve`. */
  private readXpReward(retrieve: string, warnings: string[]): FishingXpReward {
    const xp: FishingXpReward = { sourcePath: FISHING_HOOK_SOURCE };

    const orb = retrieve.match(/new ExperienceOrb\([\s\S]*?this\.random\.nextInt\((\d+)\)\s*\+\s*(\d+)\s*\)/);
    if (orb) {
      const span = Number(orb[1]);
      const offset = Number(orb[2]);
      xp.minPerCatch = offset;
      xp.maxPerCatch = span - 1 + offset;
      xp.expression = `random.nextInt(${span}) + ${offset}`;
      xp.awardedPerCaughtStack = /for\s*\(ItemStack[\s\S]*?new ExperienceOrb/.test(retrieve);
    } else {
      warnings.push("The ExperienceOrb amount roll was not found in FishingHook.retrieve().");
    }

    const entityDamage = retrieve.match(/dmg\s*=\s*this\.hookedIn instanceof ItemEntity\s*\?\s*(\d+)\s*:\s*(\d+)\s*;/);
    if (entityDamage) {
      xp.rodDamageOnItemEntity = Number(entityDamage[1]);
      xp.rodDamageOnEntity = Number(entityDamage[2]);
    } else {
      warnings.push("The hooked-entity rod damage values were not found in FishingHook.retrieve().");
    }

    const catchDamage = retrieve.match(/dmg\s*=\s*(\d+)\s*;\s*\}\s*if\s*\(this\.onGround\(\)\)\s*\{\s*dmg\s*=\s*(\d+)\s*;/);
    if (catchDamage) {
      xp.rodDamageOnCatch = Number(catchDamage[1]);
      xp.rodDamageOnGround = Number(catchDamage[2]);
    } else {
      warnings.push("The successful-catch and on-ground rod damage values were not found in FishingHook.retrieve().");
    }

    const pull = retrieve.match(
      /entity\.setDeltaMovement\(\s*\w+\s*\*\s*([\d.]+)\s*,\s*\w+\s*\*\s*[\d.]+\s*\+\s*Math\.sqrt\(Math\.sqrt\([^)]*\)\)\s*\*\s*([\d.]+)\s*,/,
    );
    if (pull) {
      xp.itemPullSpeed = Number(pull[1]);
      xp.itemPullArcMultiplier = Number(pull[2]);
    } else {
      warnings.push("The caught-item pull physics were not found in FishingHook.retrieve().");
    }

    return xp;
  }
}

/** Extracts a balanced `{ ... }` method body starting at the first occurrence of `signature`. */
function methodBody(source: string, signature: string): string | undefined {
  const start = source.indexOf(signature);
  if (start < 0) {
    return undefined;
  }
  const open = source.indexOf("{", start);
  if (open < 0) {
    return undefined;
  }

  let depth = 0;
  for (let index = open; index < source.length; index++) {
    const character = source[index];
    if (character === "{") {
      depth++;
    } else if (character === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(open, index + 1);
      }
    }
  }
  return undefined;
}

function tickRange(minTicks: number, maxTicks: number): FishingTickRange {
  return {
    minTicks,
    maxTicks,
    minSeconds: round4(minTicks / TICKS_PER_SECOND),
    maxSeconds: round4(maxTicks / TICKS_PER_SECOND),
    outcomes: maxTicks - minTicks + 1,
  };
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
