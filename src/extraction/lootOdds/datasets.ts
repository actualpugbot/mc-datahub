/**
 * The two shipped "what are the odds?" datasets.
 *
 * `fishing-odds.json` is the flagship: the parsed fishing loop, the full luck x open-water odds
 * grid, a curated set of human scenarios, and a wait-time model derived from the parsed timers.
 * `loot-odds.json` is the general catalogue: bartering, archaeology, gifts, mob drops per looting
 * level, and chest loot.
 *
 * Every number here is either copied straight out of the extractor or computed in closed form from
 * extracted values. Anything that cannot be derived becomes a warning instead of a guess.
 */

import type {
  FishingHookWindow,
  FishingMechanics,
  FishingTickRange,
  FishingWaitTime,
  FishingWeatherEffects,
} from "../../domain/types.js";
import type { LootOddsData } from "./data.js";
import { evaluateLootTable } from "./evaluator.js";
import { computeFishingOdds, DEFAULT_LUCK_VALUES, FISHING_TABLE_ID } from "./fishing.js";
import type { CategoryOdds, DamageRange, EnchantMetadata, FishingOdds, LootOutcome, NumberStats, OddsContext } from "./types.js";

const SECONDS_PER_HOUR = 3600;
const BARTERING_TABLE_ID = "minecraft:gameplay/piglin_bartering";
const LOOTING_ENCHANTMENT = "minecraft:looting";

/** Looting levels every `minecraft:entities/*` table is evaluated at. */
export const DEFAULT_LOOTING_LEVELS: number[] = [0, 1, 2, 3];

/* --- fishing-odds.json --- */

/** One weather/sky combination and the exact per-tick countdown decrement it produces. */
export interface FishingSpeedCombination {
  /** Matches the keys of `mechanics.rain.expectedSpeed`. */
  key: "clearSkyVisible" | "rainingSkyVisible" | "clearSkyObstructed" | "rainingSkyObstructed";
  label: string;
  raining: boolean;
  skyVisible: boolean;
  /** Exact distribution of `fishingSpeed`, as `[decrement, probability]`. */
  decrementDistribution: Array<[number, number]>;
  expectedDecrement: number;
}

/** Expected timings for one Lure level under one weather/sky combination. */
export interface FishingTimingRow {
  lureLevel: number;
  /** `lureSpeed` in ticks, subtracted once from each fresh wait roll. */
  lureTicks: number;
  combination: FishingSpeedCombination["key"];
  /** Probability a single wait roll comes out non-positive and is discarded. */
  rerollChance: number;
  /** Expected number of wait rolls per catch, each of which costs one tick. */
  expectedRollsPerCycle: number;
  expectedWaitTicks: number;
  expectedWaitSeconds: number;
  expectedApproachTicks: number;
  expectedApproachSeconds: number;
  /** Wait + approach: cast to bite, assuming the rod is reeled in the moment the bobber dips. */
  expectedCycleTicks: number;
  expectedCycleSeconds: number;
  expectedCatchesPerHour: number;
  expectedXpPerHour: number;
}

/** The derived wait-time model: how long a catch actually takes. */
export interface FishingTiming {
  ticksPerSecond: number;
  combinations: FishingSpeedCombination[];
  rows: FishingTimingRow[];
  /** `timeUntilHooked`: how long the fish swims towards the bobber once the wait expires. */
  approachWindow?: FishingTickRange;
  /** `nibble`: the window in which reeling in actually rolls the loot table. */
  nibbleWindow?: FishingTickRange;
  /** Ticks the nibble window loses per tick; unlike the other two timers it ignores `fishingSpeed`. */
  nibbleDecrementPerTick?: number;
  expectedXpPerCatch?: number;
  /** Plain-English statement of the model the rows were computed with. */
  model: string[];
  warnings: string[];
}

/** A named preset a guide can render without recomputing anything. */
export interface FishingScenario {
  id: string;
  label: string;
  /** Luck of the Sea level, 0 for an unenchanted rod. */
  lotsLevel: number;
  /** Luck potion level (1-3) when one is active. */
  luckPotionLevel?: number;
  /** The matching effect amplifier, i.e. `level - 1`. */
  luckPotionAmplifier?: number;
  /** Bad Luck (Unluck) potion level (1-3) when one is active. */
  unluckPotionLevel?: number;
  unluckPotionAmplifier?: number;
  /** Total `LootContext.getLuck()`: the enchantment bonus plus the player's Luck attribute. */
  luck: number;
  inOpenWater: boolean;
  /** Index into `oddsGrid.cells`, where the full per-item odds live. */
  gridIndex: number;
  /** Inlined so a preset card renders without touching the grid. */
  categories: CategoryOdds[];
  /** Expected item stacks per catch, summed over the flattened per-item odds. */
  expectedItemsPerCatch: number;
}

/** Everything a fishing guide page needs, in one file. */
export interface FishingOddsDataset {
  tableId: string;
  mechanics: FishingMechanics;
  oddsGrid: FishingOdds;
  scenarios: FishingScenario[];
  timing: FishingTiming;
  warnings: string[];
}

/* --- loot-odds.json --- */

/** One evaluation context, named by the knobs that actually change the answer. */
export interface LootOddsContextKey {
  looting?: number;
  killedByPlayer?: boolean;
  luck?: number;
}

/** A per-item row, trimmed to what a guide renders. */
export interface LootOddsItem {
  itemId: string;
  displayName: string;
  kind: "item" | "dynamic";
  /** Probability of getting at least one per evaluation of the table. */
  probability: number;
  /** Expected number of items per evaluation of the table. */
  expectedCount: number;
  /** Count summary conditioned on the item dropping at all. */
  count: NumberStats;
  /** Full exact count distribution. Only carried where the file-size budget allows. */
  countDistribution?: Array<[number, number]>;
  damage?: DamageRange;
  enchantments?: EnchantMetadata[];
  potions?: string[];
  smelted?: boolean;
  /** Signatures of conditions the engine could not resolve; these rows were computed as if they passed. */
  unresolvedConditions?: string[];
  annotations?: string[];
}

/**
 * The odds for one or more contexts that produce byte-identical numbers.
 *
 * Most mob tables do not react to looting at all, so a table typically collapses to a single cell
 * listing every context it covers.
 */
export interface LootOddsCell {
  contexts: LootOddsContextKey[];
  items: LootOddsItem[];
  warnings: string[];
}

export interface LootOddsTable {
  tableId: string;
  /** Last path segment, e.g. `zombie`. */
  name: string;
  tableType: string;
  cells: LootOddsCell[];
  warnings: string[];
}

/** Bartering, expressed per gold ingot handed to a piglin. */
export interface BarteringOdds {
  tableId: string;
  items: Array<LootOddsItem & { expectedCountPerIngot: number; expectedIngotsPerItem: number }>;
  warnings: string[];
}

/** Curated general-purpose odds. Fishing is deliberately absent; it lives in `fishing-odds.json`. */
export interface LootOddsDataset {
  /** Where the fishing odds went. */
  fishing: { tableId: string; dataset: string };
  lootingLevels: number[];
  chestLuck: number;
  bartering: BarteringOdds;
  archaeology: LootOddsTable[];
  gifts: LootOddsTable[];
  mobDrops: LootOddsTable[];
  chests: LootOddsTable[];
  warnings: string[];
}

export interface BuildFishingOddsOptions {
  data: LootOddsData;
  mechanics: FishingMechanics;
  /** Luck values the grid covers. Defaults to every integer in `[-4, 10]`. */
  luckValues?: number[];
}

export interface BuildLootOddsOptions {
  data: LootOddsData;
  lootingLevels?: number[];
  chestLuck?: number;
  /** Carry the full count distributions. On by default; drop them if a future version blows the file-size budget. */
  includeCountDistribution?: boolean;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/* --- the wait-time model --- */

/**
 * Fold one independent per-tick modifier into a `fishingSpeed` distribution.
 *
 * `catchingFish` rolls rain and sky separately every tick, so the two modifiers convolve rather than
 * combine into a single branch.
 */
function applyModifier(distribution: Array<[number, number]>, chance: number, delta: number): Array<[number, number]> {
  const merged = new Map<number, number>();
  for (const [value, probability] of distribution) {
    merged.set(value + delta, (merged.get(value + delta) ?? 0) + probability * chance);
    merged.set(value, (merged.get(value) ?? 0) + probability * (1 - chance));
  }
  return [...merged.entries()].sort((left, right) => left[0] - right[0]);
}

function expectedValue(distribution: Array<[number, number]>): number {
  return distribution.reduce((total, [value, probability]) => total + value * probability, 0);
}

/**
 * Expected ticks to count a timer down from `start` to zero or below.
 *
 * `T(w) = 1 + sum_k P(step = k) * T(w - k)`, with `T(w <= 0) = 0`. A step of zero (a tick the
 * obstructed-sky roll cancels out) leaves the timer where it was, so it is folded into the left-hand
 * side: `T(w) = (1 + sum_{k>0} P(k) T(w - k)) / (1 - P(0))`. The result is exact, not a mean-rate
 * approximation, so the overshoot a step of 2 can cause is accounted for.
 */
function buildCountdownTable(maxStart: number, distribution: Array<[number, number]>): number[] | undefined {
  if (distribution.some(([step]) => step < 0)) return undefined;
  const stall = distribution.reduce((total, [step, probability]) => (step <= 0 ? total + probability : total), 0);
  if (stall >= 1) return undefined;

  const table = new Array<number>(maxStart + 1).fill(0);
  for (let remaining = 1; remaining <= maxStart; remaining += 1) {
    let expected = 1;
    for (const [step, probability] of distribution) {
      if (step <= 0) continue;
      expected += probability * (table[remaining - step] ?? 0);
    }
    table[remaining] = expected / (1 - stall);
  }
  return table;
}

/** Mean of `table[value]` over every integer in an inclusive tick range. */
function averageOverRange(table: number[], min: number, max: number): number {
  let total = 0;
  for (let value = min; value <= max; value += 1) total += table[value] ?? 0;
  return total / (max - min + 1);
}

function buildSpeedCombinations(rain: FishingWeatherEffects, warnings: string[]): FishingSpeedCombination[] {
  const baseSpeed = rain.baseSpeed;
  if (baseSpeed === undefined || !rain.rain || !rain.obstructedSky) {
    warnings.push("No timing rows were derived: the base fishingSpeed or one of its weather/sky modifiers is missing.");
    return [];
  }

  const combinations: FishingSpeedCombination[] = [];
  for (const raining of [false, true]) {
    for (const skyVisible of [true, false]) {
      let distribution: Array<[number, number]> = [[baseSpeed, 1]];
      if (raining) distribution = applyModifier(distribution, rain.rain.chance, rain.rain.speedDelta);
      if (!skyVisible) distribution = applyModifier(distribution, rain.obstructedSky.chance, rain.obstructedSky.speedDelta);
      const key = (raining ? "raining" : "clear") + (skyVisible ? "SkyVisible" : "SkyObstructed");
      combinations.push({
        key: key as FishingSpeedCombination["key"],
        label: `${raining ? "Raining" : "Clear"}, sky ${skyVisible ? "visible" : "obstructed"}`,
        raining,
        skyVisible,
        decrementDistribution: distribution.map(([step, probability]) => [step, round(probability, 6)]),
        expectedDecrement: round(expectedValue(distribution), 6),
      });
    }
  }

  // The extractor publishes its own expected speeds; disagreeing with them means one of us is wrong.
  const expected = rain.expectedSpeed;
  if (expected) {
    for (const combination of combinations) {
      const reference = expected[combination.key];
      if (Math.abs(reference - combination.expectedDecrement) > 1e-6) {
        warnings.push(
          `The derived per-tick decrement for ${combination.key} (${combination.expectedDecrement}) does not match the extracted expectedSpeed (${reference}).`,
        );
      }
    }
  } else {
    warnings.push(
      "The extracted expectedSpeed table was missing, so the derived per-tick decrements could not be cross-checked.",
    );
  }

  return combinations;
}

/**
 * Build the timing table: expected seconds per catch for every Lure level under every weather/sky
 * combination, plus the derived catches and XP per hour.
 */
export function buildFishingTiming(mechanics: FishingMechanics): FishingTiming {
  const warnings: string[] = [];
  const model: string[] = [];
  const waitTime: FishingWaitTime = mechanics.waitTime;
  const hookWindow: FishingHookWindow = mechanics.hookWindow;
  const ticksPerSecond = mechanics.lureSources.secondsToTicks ?? 20;
  if (mechanics.lureSources.secondsToTicks === undefined) {
    warnings.push("The seconds-to-ticks conversion was missing, so 20 ticks per second was assumed for the timing rows.");
  }

  const combinations = buildSpeedCombinations(mechanics.rain, warnings);
  const baseRoll = waitTime.baseRoll;
  const approachRoll = hookWindow.approachRoll;
  const lureLevels = mechanics.lureSources.perLevel;

  model.push(
    "A cycle is one cast: roll the wait timer, count it down, then count the fish's approach down. The rod is assumed to be reeled in the moment the bobber dips, so the nibble window adds nothing.",
    "`timeUntilLured` is rolled uniformly over the base roll and `lureSpeed` is subtracted once. A roll that lands at or below zero is discarded and re-rolled on the next tick, which costs exactly one tick.",
    "Each tick the countdown loses `fishingSpeed`, which is re-rolled every tick: +1 with the rain chance while it is raining above the bobber, -1 with the sky chance while the sky is obstructed. The two rolls are independent, so a covered bobber in the rain can lose 0, 1 or 2 ticks.",
    "Expected tick counts are solved exactly by recurrence rather than by dividing by the mean rate, so the overshoot a decrement of 2 causes is included.",
  );

  const approachSharesSpeed =
    hookWindow.approachDecrementVariable !== undefined && hookWindow.approachDecrementVariable === waitTime.countdownVariable;
  if (approachSharesSpeed) {
    model.push(
      `The approach timer subtracts the same \`${waitTime.countdownVariable}\` as the wait countdown, so rain and sky shorten it too.`,
    );
  } else {
    warnings.push(
      "The approach timer's per-tick decrement could not be matched to the wait countdown's, so the approach was counted at the base speed.",
    );
  }

  const rows: FishingTimingRow[] = [];
  if (baseRoll && approachRoll && combinations.length > 0 && lureLevels.length > 0) {
    const maxStart = Math.max(baseRoll.maxTicks, approachRoll.maxTicks);
    const baseTable = buildCountdownTable(maxStart, [[waitTime.countdownBaseSpeed ?? 1, 1]]);
    if (waitTime.countdownBaseSpeed === undefined) {
      warnings.push("The base countdown speed was missing, so a decrement of 1 tick was assumed for the base-speed approach.");
    }

    for (const combination of combinations) {
      const table = buildCountdownTable(maxStart, combination.decrementDistribution);
      if (!table) {
        warnings.push(`No timing rows were derived for ${combination.key}: its countdown can stall forever or run backwards.`);
        continue;
      }

      const approachTable = approachSharesSpeed ? table : baseTable;
      if (!approachTable) continue;
      const expectedApproachTicks = averageOverRange(approachTable, approachRoll.minTicks, approachRoll.maxTicks);

      for (const level of lureLevels) {
        const firstGoodRoll = Math.max(baseRoll.minTicks, level.ticks + 1);
        const goodRolls = baseRoll.maxTicks - firstGoodRoll + 1;
        if (goodRolls <= 0) {
          warnings.push(`No timing row was derived for Lure ${level.level}: every wait roll is discarded.`);
          continue;
        }

        const rerollChance = (baseRoll.outcomes - goodRolls) / baseRoll.outcomes;
        if (Math.abs(rerollChance - level.rerollChance) > 1e-3) {
          warnings.push(
            `The derived reroll chance for Lure ${level.level} (${round(rerollChance, 6)}) does not match the extracted rerollChance (${level.rerollChance}).`,
          );
        }

        let countdownTotal = 0;
        for (let roll = firstGoodRoll; roll <= baseRoll.maxTicks; roll += 1) countdownTotal += table[roll - level.ticks] ?? 0;
        const expectedRollsPerCycle = 1 / (1 - rerollChance);
        const expectedWaitTicks = expectedRollsPerCycle + countdownTotal / goodRolls;
        const expectedCycleTicks = expectedWaitTicks + expectedApproachTicks;
        const expectedCycleSeconds = expectedCycleTicks / ticksPerSecond;
        const catchesPerHour = SECONDS_PER_HOUR / expectedCycleSeconds;
        const xpPerCatch = expectedXpPerCatch(mechanics);

        rows.push({
          lureLevel: level.level,
          lureTicks: level.ticks,
          combination: combination.key,
          rerollChance: round(rerollChance, 6),
          expectedRollsPerCycle: round(expectedRollsPerCycle, 4),
          expectedWaitTicks: round(expectedWaitTicks, 3),
          expectedWaitSeconds: round(expectedWaitTicks / ticksPerSecond, 3),
          expectedApproachTicks: round(expectedApproachTicks, 3),
          expectedApproachSeconds: round(expectedApproachTicks / ticksPerSecond, 3),
          expectedCycleTicks: round(expectedCycleTicks, 3),
          expectedCycleSeconds: round(expectedCycleSeconds, 3),
          expectedCatchesPerHour: round(catchesPerHour, 2),
          expectedXpPerHour: xpPerCatch === undefined ? 0 : round(catchesPerHour * xpPerCatch, 2),
        });
      }
    }
  } else {
    warnings.push("No timing rows were derived: the wait roll, the approach roll or the Lure levels were missing.");
  }

  if (expectedXpPerCatch(mechanics) === undefined) {
    warnings.push("The XP-per-catch bounds were missing, so expected XP per hour was reported as zero.");
  }

  return {
    ticksPerSecond,
    combinations,
    rows,
    approachWindow: hookWindow.approachRoll,
    nibbleWindow: hookWindow.catchableRoll,
    nibbleDecrementPerTick: hookWindow.nibbleDecrementPerTick,
    expectedXpPerCatch: expectedXpPerCatch(mechanics),
    model,
    warnings,
  };
}

/** The orb `retrieve` spawns is a uniform integer roll, so its mean is the midpoint. */
function expectedXpPerCatch(mechanics: FishingMechanics): number | undefined {
  const { minPerCatch, maxPerCatch } = mechanics.xp;
  if (minPerCatch === undefined || maxPerCatch === undefined) return undefined;
  return round((minPerCatch + maxPerCatch) / 2, 4);
}

/* --- scenarios --- */

interface ScenarioSeed {
  id: string;
  label: string;
  lotsLevel: number;
  luckPotionLevel?: number;
  unluckPotionLevel?: number;
}

function buildScenarioSeeds(mechanics: FishingMechanics, warnings: string[]): ScenarioSeed[] {
  const lots = mechanics.luckSources.enchantment;
  const maxLots = lots?.maxLevel ?? 0;
  if (!lots) warnings.push("No Luck of the Sea scaling was extracted, so the scenarios cover an unenchanted rod only.");

  const seeds: ScenarioSeed[] = [{ id: "no_enchants", label: "Unenchanted rod", lotsLevel: 0 }];
  for (let level = 1; level <= maxLots; level += 1) {
    seeds.push({ id: `lots_${level}`, label: `Luck of the Sea ${roman(level)}`, lotsLevel: level });
  }

  const luckLevels = mechanics.luckSources.luckEffect?.perLevel ?? [];
  if (luckLevels.length === 0) warnings.push("No Luck potion levels were extracted, so no potion scenarios were built.");
  for (const potion of luckLevels) {
    seeds.push({
      id: `luck_${potion.level}`,
      label: `Luck ${roman(potion.level)} potion, unenchanted rod`,
      lotsLevel: 0,
      luckPotionLevel: potion.level,
    });
    if (maxLots > 0) {
      seeds.push({
        id: `lots_${maxLots}_luck_${potion.level}`,
        label: `Luck of the Sea ${roman(maxLots)} + Luck ${roman(potion.level)}`,
        lotsLevel: maxLots,
        luckPotionLevel: potion.level,
      });
    }
  }

  for (const potion of mechanics.luckSources.unluckEffect?.perLevel ?? []) {
    seeds.push({
      id: `unluck_${potion.level}`,
      label: `Bad Luck ${roman(potion.level)}`,
      lotsLevel: 0,
      unluckPotionLevel: potion.level,
    });
  }

  return seeds;
}

function roman(level: number): string {
  return ["", "I", "II", "III", "IV", "V"][level] ?? String(level);
}

function buildScenarios(mechanics: FishingMechanics, grid: FishingOdds, warnings: string[]): FishingScenario[] {
  const lotsPerLevel = new Map((mechanics.luckSources.enchantment?.perLevel ?? []).map((entry) => [entry.level, entry.value]));
  const luckPerLevel = new Map((mechanics.luckSources.luckEffect?.perLevel ?? []).map((entry) => [entry.level, entry]));
  const unluckPerLevel = new Map((mechanics.luckSources.unluckEffect?.perLevel ?? []).map((entry) => [entry.level, entry]));

  const scenarios: FishingScenario[] = [];
  for (const seed of buildScenarioSeeds(mechanics, warnings)) {
    const enchantmentLuck = seed.lotsLevel === 0 ? 0 : (lotsPerLevel.get(seed.lotsLevel) ?? 0);
    const luckPotion = seed.luckPotionLevel === undefined ? undefined : luckPerLevel.get(seed.luckPotionLevel);
    const unluckPotion = seed.unluckPotionLevel === undefined ? undefined : unluckPerLevel.get(seed.unluckPotionLevel);
    const luck = enchantmentLuck + (luckPotion?.luckDelta ?? 0) + (unluckPotion?.luckDelta ?? 0);

    for (const inOpenWater of [true, false]) {
      const gridIndex = grid.cells.findIndex((cell) => cell.luck === luck && cell.inOpenWater === inOpenWater);
      const cell = grid.cells[gridIndex];
      if (!cell) {
        warnings.push(`The ${seed.id} scenario was dropped: luck ${luck} is outside the grid.`);
        continue;
      }

      scenarios.push({
        id: `${seed.id}_${inOpenWater ? "open" : "closed"}_water`,
        label: `${seed.label}, ${inOpenWater ? "open water" : "not open water"}`,
        lotsLevel: seed.lotsLevel,
        luckPotionLevel: luckPotion?.level,
        luckPotionAmplifier: luckPotion?.amplifier,
        unluckPotionLevel: unluckPotion?.level,
        unluckPotionAmplifier: unluckPotion?.amplifier,
        luck,
        inOpenWater,
        gridIndex,
        categories: cell.categories,
        expectedItemsPerCatch: round(
          cell.items.reduce((total, item) => total + item.expectedCount, 0),
          6,
        ),
      });
    }
  }

  return scenarios;
}

/** Assemble `fishing-odds.json`. */
export function buildFishingOddsDataset(options: BuildFishingOddsOptions): FishingOddsDataset {
  const { data, mechanics } = options;
  const warnings: string[] = [];
  const oddsGrid = computeFishingOdds(data, { luckValues: options.luckValues ?? DEFAULT_LUCK_VALUES });
  const timing = buildFishingTiming(mechanics);
  const scenarios = buildScenarios(mechanics, oddsGrid, warnings);

  for (const warning of mechanics.warnings) warnings.push(`mechanics: ${warning}`);
  for (const warning of oddsGrid.warnings) warnings.push(`odds: ${warning}`);
  for (const warning of timing.warnings) warnings.push(`timing: ${warning}`);

  return {
    tableId: FISHING_TABLE_ID,
    mechanics,
    oddsGrid,
    scenarios,
    timing,
    warnings: [...new Set(warnings)],
  };
}

/* --- loot-odds.json --- */

function trimOutcome(outcome: LootOutcome, includeCountDistribution: boolean): LootOddsItem {
  const item: LootOddsItem = {
    itemId: outcome.itemId,
    displayName: outcome.displayName,
    kind: outcome.kind,
    probability: outcome.probability,
    expectedCount: outcome.expectedCount,
    count: outcome.count,
  };
  if (includeCountDistribution) item.countDistribution = outcome.countDistribution;
  if (outcome.damage) item.damage = outcome.damage;
  if (outcome.enchantments?.length) item.enchantments = outcome.enchantments;
  if (outcome.potions?.length) item.potions = outcome.potions;
  if (outcome.smelted) item.smelted = true;
  if (outcome.unresolvedConditions.length > 0) item.unresolvedConditions = outcome.unresolvedConditions;
  if (outcome.annotations.length > 0) item.annotations = outcome.annotations;
  return item;
}

function tableIds(data: LootOddsData, prefix: string): string[] {
  return [...data.tables.keys()].filter((id) => id.startsWith(prefix)).sort();
}

interface EvaluatedContext {
  key: LootOddsContextKey;
  items: LootOddsItem[];
  warnings: string[];
}

function evaluateContext(
  data: LootOddsData,
  tableId: string,
  key: LootOddsContextKey,
  context: OddsContext,
  includeCountDistribution: boolean,
  warnings: string[],
): EvaluatedContext | undefined {
  let result;
  try {
    result = evaluateLootTable(tableId, { ...context, data });
  } catch (error) {
    warnings.push(`${tableId}: evaluation failed (${error instanceof Error ? error.message : String(error)}).`);
    return undefined;
  }

  return {
    key,
    items: result.items.map((outcome) => trimOutcome(outcome, includeCountDistribution)),
    warnings: result.warnings,
  };
}

/** Collapse contexts that produce identical numbers into one cell listing all of them. */
function collapseCells(evaluated: EvaluatedContext[]): LootOddsCell[] {
  const cells: LootOddsCell[] = [];
  const bySignature = new Map<string, LootOddsCell>();
  for (const entry of evaluated) {
    const signature = JSON.stringify(entry.items);
    const existing = bySignature.get(signature);
    if (existing) {
      existing.contexts.push(entry.key);
      continue;
    }

    const cell: LootOddsCell = { contexts: [entry.key], items: entry.items, warnings: entry.warnings };
    bySignature.set(signature, cell);
    cells.push(cell);
  }
  return cells;
}

function buildTable(data: LootOddsData, tableId: string, evaluated: EvaluatedContext[], warnings: string[]): LootOddsTable {
  const record = data.tables.get(tableId);
  const cells = collapseCells(evaluated);
  const tableWarnings = [...new Set(cells.flatMap((cell) => cell.warnings))];
  for (const warning of tableWarnings) warnings.push(`${tableId}: ${warning}`);
  return {
    tableId,
    name: tableId.split("/").pop() ?? tableId,
    tableType: record?.type ?? "minecraft:generic",
    cells,
    warnings: tableWarnings,
  };
}

/** Evaluate a set of tables once each, at a single fixed context. */
function buildSimpleSection(
  data: LootOddsData,
  ids: string[],
  key: LootOddsContextKey,
  context: OddsContext,
  includeCountDistribution: boolean,
  warnings: string[],
): LootOddsTable[] {
  const tables: LootOddsTable[] = [];
  for (const tableId of ids) {
    const evaluated = evaluateContext(data, tableId, key, context, includeCountDistribution, warnings);
    if (!evaluated) continue;
    tables.push(buildTable(data, tableId, [evaluated], warnings));
  }
  return tables;
}

/**
 * Mob drops, evaluated at every looting level.
 *
 * Whether the kill was a player's matters to a table only if it changes the numbers, so each table
 * is probed both ways first. Tables that react (`minecraft:killed_by_player` somewhere on the path)
 * publish both variants; the rest publish one set of contexts with the flag left off entirely,
 * because stamping it on would imply a distinction the table does not make.
 */
function buildMobDrops(
  data: LootOddsData,
  lootingLevels: number[],
  includeCountDistribution: boolean,
  warnings: string[],
): LootOddsTable[] {
  const tables: LootOddsTable[] = [];
  const lowestLooting = lootingLevels[0] ?? 0;

  for (const tableId of tableIds(data, "minecraft:entities/")) {
    const probes = [false, true].map((killedByPlayer) =>
      evaluateContext(
        data,
        tableId,
        { looting: lowestLooting, killedByPlayer },
        { killedByPlayer, enchantmentLevels: { [LOOTING_ENCHANTMENT]: lowestLooting } },
        includeCountDistribution,
        warnings,
      ),
    );
    const [mobKill, playerKill] = probes;
    if (!mobKill || !playerKill) continue;
    const playerGated = JSON.stringify(mobKill.items) !== JSON.stringify(playerKill.items);

    const evaluated: EvaluatedContext[] = [];
    for (const killedByPlayer of playerGated ? [false, true] : [false]) {
      for (const looting of lootingLevels) {
        const key: LootOddsContextKey = playerGated ? { looting, killedByPlayer } : { looting };
        const entry = evaluateContext(
          data,
          tableId,
          key,
          { killedByPlayer, enchantmentLevels: { [LOOTING_ENCHANTMENT]: looting } },
          includeCountDistribution,
          warnings,
        );
        if (entry) evaluated.push(entry);
      }
    }
    tables.push(buildTable(data, tableId, evaluated, warnings));
  }
  return tables;
}

function buildBartering(data: LootOddsData, includeCountDistribution: boolean, warnings: string[]): BarteringOdds {
  const record = data.tables.get(BARTERING_TABLE_ID);
  if (!record) {
    warnings.push(`${BARTERING_TABLE_ID} is not in this dataset, so the bartering section is empty.`);
    return { tableId: BARTERING_TABLE_ID, items: [], warnings: ["The bartering loot table was missing."] };
  }

  const result = evaluateLootTable(BARTERING_TABLE_ID, { data });
  for (const warning of result.warnings) warnings.push(`${BARTERING_TABLE_ID}: ${warning}`);
  return {
    tableId: BARTERING_TABLE_ID,
    // One evaluation of the table is one gold ingot handed to a piglin, so the per-evaluation
    // numbers are already per-ingot.
    items: result.items.map((outcome) => {
      const item = trimOutcome(outcome, includeCountDistribution);
      return {
        ...item,
        expectedCountPerIngot: outcome.expectedCount,
        expectedIngotsPerItem: outcome.expectedCount > 0 ? round(1 / outcome.expectedCount, 4) : Number.POSITIVE_INFINITY,
      };
    }),
    warnings: result.warnings,
  };
}

/** Assemble `loot-odds.json`. */
export function buildLootOddsDataset(options: BuildLootOddsOptions): LootOddsDataset {
  const { data } = options;
  const lootingLevels = options.lootingLevels ?? DEFAULT_LOOTING_LEVELS;
  const chestLuck = options.chestLuck ?? 0;
  const includeCountDistribution = options.includeCountDistribution ?? true;
  const warnings: string[] = [];

  // Fishing keeps its own file, so the fishing table and its three sub-tables stay out of the gifts
  // section even though they live under `gameplay/`.
  const giftIds = tableIds(data, "minecraft:gameplay/").filter(
    (id) => id !== BARTERING_TABLE_ID && id !== FISHING_TABLE_ID && !id.startsWith(`${FISHING_TABLE_ID}/`),
  );

  return {
    fishing: { tableId: FISHING_TABLE_ID, dataset: "fishing-odds.json" },
    lootingLevels: [...lootingLevels],
    chestLuck,
    bartering: buildBartering(data, includeCountDistribution, warnings),
    archaeology: buildSimpleSection(data, tableIds(data, "minecraft:archaeology/"), {}, {}, includeCountDistribution, warnings),
    gifts: buildSimpleSection(data, giftIds, {}, {}, includeCountDistribution, warnings),
    mobDrops: buildMobDrops(data, lootingLevels, includeCountDistribution, warnings),
    chests: buildSimpleSection(
      data,
      tableIds(data, "minecraft:chests/"),
      { luck: chestLuck },
      { luck: chestLuck },
      includeCountDistribution,
      warnings,
    ),
    warnings: [...new Set(warnings)],
  };
}
