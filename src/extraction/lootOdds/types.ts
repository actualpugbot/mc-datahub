/**
 * Public types for the exact loot-table odds engine.
 *
 * Everything in here is consumer-facing: the shapes below are what a public
 * "what are the odds?" guide renders, so they are deliberately flat, JSON-safe
 * and free of engine internals.
 */

/** A JSON value as it appears verbatim inside a vanilla loot table. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * The knobs the engine uses to turn loot-table conditions into probabilities.
 *
 * Anything the engine cannot resolve from this context is reported through
 * {@link ConditionSummary} with status `"unresolved"` and treated as
 * pass-through (see {@link OddsContext.unresolvedConditionsPass}), never
 * silently dropped.
 */
export interface OddsContext {
  /**
   * `LootContext.getLuck()`. Luck of the Sea / Luck / Bad Luck all feed this.
   * Defaults to `0`.
   */
  luck?: number;
  /** `fishing_hook.in_open_water` for `minecraft:entity_properties`. Defaults to `true`. */
  inOpenWater?: boolean;
  /** `minecraft:killed_by_player`. Defaults to `false`. */
  killedByPlayer?: boolean;
  /** `minecraft:weather_check` rain flag. Defaults to `false`. */
  raining?: boolean;
  /** `minecraft:weather_check` thunder flag. Defaults to `false`. */
  thundering?: boolean;
  /**
   * Whether `LootContextParams.TOOL` is present. `minecraft:apply_bonus` is a
   * no-op without it. Defaults to `true`.
   */
  toolPresent?: boolean;
  /** Blanket answer for `minecraft:match_tool`. Left unresolved when omitted. */
  matchesTool?: boolean;
  /**
   * `LootContextParams.EXPLOSION_RADIUS`. When omitted (the normal case for a
   * player mining a block) `minecraft:survives_explosion` is always true and
   * `minecraft:explosion_decay` is a no-op, exactly as in vanilla.
   */
  explosionRadius?: number;
  /** Biome id used to resolve `minecraft:location_check` biome predicates. */
  biome?: string;
  /** Block-state values used to resolve `minecraft:block_state_property`. */
  blockState?: Record<string, string>;
  /**
   * Enchantment levels held by the player/tool, e.g.
   * `{ "minecraft:looting": 3, "minecraft:fortune": 3 }`. Missing entries are 0.
   */
  enchantmentLevels?: Record<string, number>;
  /**
   * Manual answers for conditions the engine could not resolve, keyed by the
   * `signature` reported on the corresponding {@link ConditionSummary}.
   */
  conditionOverrides?: Record<string, boolean>;
  /**
   * How to treat conditions the engine cannot resolve. `true` (the default)
   * computes probabilities as if they passed; `false` removes those entries.
   * Either way the condition is reported, never dropped silently.
   */
  unresolvedConditionsPass?: boolean;
  /** Highest item count tracked in a count distribution. Defaults to 1024. */
  maxTrackedCount?: number;
  /** Largest number of probabilistic-condition scenarios enumerated per pool. Defaults to 4096. */
  maxConditionScenarios?: number;
}

/** How the engine resolved one loot condition under the supplied context. */
export interface ConditionSummary {
  /** The `condition` field verbatim, e.g. `"minecraft:random_chance"`. */
  type: string;
  /** Stable identity usable as a key in {@link OddsContext.conditionOverrides}. */
  signature: string;
  /** `always` / `never` are deterministic, `random` carries a probability. */
  status: "always" | "never" | "random" | "unresolved";
  /** Present when `status === "random"`. */
  probability?: number;
  /** Human-readable explanation, e.g. `"in_open_water = true"`. */
  detail?: string;
}

/**
 * How worn an item comes out, as a fraction of its max durability.
 *
 * Careful: the `damage` field inside `minecraft:set_damage` is *inverted*.
 * `SetItemDamageFunction.run` does
 * `setDamageValue(Mth.floor((1 - clamp(damage, 0, 1)) * maxDamage))`, so the
 * JSON value is the fraction of durability the item *keeps*. These fields
 * report the fraction of durability *consumed*, which is what a guide shows.
 */
export interface DamageRange {
  /** Lowest fraction of max durability already consumed. */
  minDamageFraction: number;
  /** Highest fraction of max durability already consumed. */
  maxDamageFraction: number;
  /** Expected fraction of max durability already consumed. */
  expectedDamageFraction: number;
  /** Max durability of the item when known from `item-stats.json`. */
  maxDurability?: number;
}

/** Structured description of an enchantment roll applied by a loot function. */
export interface EnchantMetadata {
  source: "enchant_with_levels" | "enchant_randomly" | "set_enchantments";
  /** Enchanting-table level cost for `enchant_with_levels`. */
  levels?: NumberStats;
  /** Every enchantment id the roll can pick from (options tag fully expanded). */
  possibleEnchantments: string[];
  /** `enchant_randomly.only_compatible`. */
  onlyCompatible?: boolean;
  /** Fixed levels for `set_enchantments`. */
  fixedLevels?: Record<string, number>;
}

/** Min / max / expected summary of an integer-valued quantity. */
export interface NumberStats {
  min: number;
  max: number;
  expected: number;
}

/** A single distinct thing a loot table can hand you. */
export interface LootOutcome {
  /** Stable key: entry path + item + metadata signature (or just the item id in the flattened view). */
  key: string;
  /** `item` for real item stacks, `dynamic` for `minecraft:dynamic` drops resolved by the game. */
  kind: "item" | "dynamic";
  /** e.g. `minecraft:cod`. For `dynamic` outcomes this is the dynamic drop name. */
  itemId: string;
  /** Localised name from `translations.json`, falling back to the id. */
  displayName: string;
  /** Probability of getting at least one, per full evaluation of the table. */
  probability: number;
  /**
   * Probability of getting at least one in a single roll of the pool it lives
   * in. Undefined when the outcome is produced by more than one pool.
   */
  probabilityPerRoll?: number;
  /** Expected number of items per full evaluation of the table. */
  expectedCount: number;
  /** Count summary conditioned on the outcome happening at all. */
  count: NumberStats;
  /** Full exact count distribution: `[count, probability]`, count >= 1. */
  countDistribution: Array<[number, number]>;
  /** Chain of loot tables the outcome came through, outermost first. */
  tablePath: string[];
  /** Human-readable entry paths, e.g. `minecraft:gameplay/fishing#0[1]/…#0[4]`. */
  entryPaths: string[];
  /** Indices of the top-level pools this outcome can come from. */
  poolIndices: number[];
  damage?: DamageRange;
  enchantments?: EnchantMetadata[];
  /** `minecraft:set_potion` ids. */
  potions?: string[];
  /** `minecraft:furnace_smelt` was applied. */
  smelted?: boolean;
  /** Every condition on the path to this outcome. */
  conditions: ConditionSummary[];
  /** Signatures of the conditions the engine could not resolve. */
  unresolvedConditions: string[];
  /** Notes about functions or entry types that were recognised but not modelled numerically. */
  annotations: string[];
}

/** One entry of a top-level pool, with its luck-adjusted weight. */
export interface EntryOdds {
  /** The `type` field, e.g. `minecraft:loot_table`. */
  type: string;
  /** `name` / `value` of the entry when it has one. */
  targetId?: string;
  /** Raw `weight` (default 1). */
  weight: number;
  /** Raw `quality` (default 0). */
  quality: number;
  /** `max(floor(weight + quality * luck), 0)`. */
  effectiveWeight: number;
  /** Probability this entry wins a single roll of the pool. */
  probabilityPerRoll: number;
  /** Probability the entry is even eligible (its conditions passing). */
  conditionProbability: number;
}

/** Everything about one pool of the evaluated table. */
export interface PoolOdds {
  index: number;
  /** Exact distribution of the roll count, `[rolls, probability]`. */
  rollsDistribution: Array<[number, number]>;
  rolls: NumberStats;
  /** Probability the pool's own conditions pass. */
  poolConditionProbability: number;
  /**
   * Sum of effective weights of eligible entries. Reported as an exact integer
   * when the eligible set is deterministic, otherwise the expected value.
   */
  totalWeight: number;
  /** True when every entry's eligibility was deterministic under the context. */
  totalWeightExact: boolean;
  entries: EntryOdds[];
}

/** Category odds: a top-level entry that is itself a loot table (fish / junk / treasure). */
export interface CategoryOdds {
  /** Referenced loot-table id. */
  tableId: string;
  /** Last path segment, e.g. `treasure`. */
  name: string;
  poolIndex: number;
  weight: number;
  quality: number;
  effectiveWeight: number;
  probability: number;
}

/** The full result of evaluating one loot table under one context. */
export interface LootTableOdds {
  tableId: string;
  /** The loot-table `type`, e.g. `minecraft:fishing`. */
  tableType: string;
  /** The context actually used, with defaults filled in. */
  context: Required<Pick<OddsContext, "luck" | "inOpenWater" | "killedByPlayer" | "unresolvedConditionsPass">> & OddsContext;
  pools: PoolOdds[];
  /** Present when the top-level pool entries are nested loot tables. */
  categories: CategoryOdds[];
  /** One row per distinct entry path + metadata. */
  outcomes: LootOutcome[];
  /** Same probabilities flattened to one row per item id. */
  items: LootOutcome[];
  warnings: string[];
}

/** One cell of the fishing odds grid. */
export interface FishingOddsCell {
  luck: number;
  inOpenWater: boolean;
  categories: CategoryOdds[];
  items: LootOutcome[];
  outcomes: LootOutcome[];
  pools: PoolOdds[];
  warnings: string[];
}

/** The whole fishing odds structure: every luck value x open/closed water. */
export interface FishingOdds {
  tableId: string;
  luckValues: number[];
  cells: FishingOddsCell[];
  warnings: string[];
}
