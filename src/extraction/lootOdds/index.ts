/**
 * Exact loot-table odds.
 *
 * Everything in this module is closed-form probability: weighted-pool selection
 * solved algebraically, multi-roll counts solved by convolution, probabilistic
 * conditions solved by exhaustive scenario enumeration. There is no Monte Carlo
 * anywhere, so the numbers a guide renders are exact, not estimates.
 *
 * ```ts
 * const data = await loadLootOddsData("workspace/datasets/26.2");
 * const odds = evaluateLootTable("minecraft:gameplay/fishing", { data, luck: 3 });
 * const fishing = computeFishingOdds(data);
 * ```
 */

export {
  createLootOddsData,
  itemDisplayName,
  loadLootOddsData,
  resolveEnchantmentOptions,
  type EnchantmentRecord,
  type LootOddsData,
  type LootOddsDataInput,
  type LootTableRecord,
} from "./data.js";

export {
  createLootOddsEngine,
  effectiveWeight,
  evaluateLootTable,
  type EvaluationContext,
  type OutcomeGrain,
} from "./evaluator.js";

export {
  computeFishingOdds,
  findFishingCell,
  DEFAULT_LUCK_VALUES,
  FISHING_TABLE_ID,
  type FishingOddsOptions,
} from "./fishing.js";

export {
  buildFishingOddsDataset,
  buildFishingTiming,
  buildLootOddsDataset,
  DEFAULT_LOOTING_LEVELS,
  type BarteringOdds,
  type BuildFishingOddsOptions,
  type BuildLootOddsOptions,
  type FishingOddsDataset,
  type FishingScenario,
  type FishingSpeedCombination,
  type FishingTiming,
  type FishingTimingRow,
  type LootOddsCell,
  type LootOddsContextKey,
  type LootOddsDataset,
  type LootOddsItem,
  type LootOddsTable,
} from "./datasets.js";

export { resolveContext, type ResolvedOddsContext } from "./conditions.js";

export type {
  CategoryOdds,
  ConditionSummary,
  DamageRange,
  EnchantMetadata,
  EntryOdds,
  FishingOdds,
  FishingOddsCell,
  Json,
  LootOutcome,
  LootTableOdds,
  NumberStats,
  OddsContext,
  PoolOdds,
} from "./types.js";
