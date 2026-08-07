/**
 * Loot functions.
 *
 * Functions never change *which* entry a pool picks -- they only reshape the
 * stack that entry produces. So everything here operates on an {@link ItemBuild}:
 * an item id plus an exact distribution over stack sizes plus metadata.
 *
 * A function may carry its own `conditions`. Those are independent of the entry
 * conditions (vanilla rolls fresh randomness for each `test`), so they are
 * compiled with a throwaway compiler and used to split the build into weighted
 * branches rather than joining the pool's scenario enumeration.
 */

import { ConditionCompiler, type ResolvedOddsContext } from "./conditions.js";
import { itemDisplayName, resolveEnchantmentOptions, type LootOddsData } from "./data.js";
import {
  binomial,
  clampCounts,
  convolve,
  fromPairs,
  mix,
  pointMass,
  scaleCounts,
  statsOf,
  uniformInclusive,
} from "./distribution.js";
import { resolveFloatProvider, resolveIntProvider, roundedScaledPairs } from "./numbers.js";
import type { ConditionSummary, DamageRange, EnchantMetadata, Json } from "./types.js";

/** An item stack in progress: id, exact count distribution, and metadata. */
export interface ItemBuild {
  itemId: string;
  kind: "item" | "dynamic";
  counts: number[];
  damage?: DamageRange;
  enchantments: EnchantMetadata[];
  potions: string[];
  smelted: boolean;
  annotations: string[];
  conditions: ConditionSummary[];
  unresolved: string[];
}

/** A weighted branch produced by a conditional function. */
export interface BuildBranch {
  probability: number;
  build: ItemBuild;
}

export interface FunctionEnv {
  data: LootOddsData;
  context: ResolvedOddsContext;
  warnings: string[];
}

/** A fresh single-item build of `itemId` with count 1. */
export function createItemBuild(itemId: string, kind: "item" | "dynamic" = "item"): ItemBuild {
  return {
    itemId,
    kind,
    counts: pointMass(1),
    enchantments: [],
    potions: [],
    smelted: false,
    annotations: [],
    conditions: [],
    unresolved: [],
  };
}

function cloneBuild(build: ItemBuild): ItemBuild {
  return {
    ...build,
    counts: [...build.counts],
    enchantments: build.enchantments.map((entry) => ({ ...entry })),
    potions: [...build.potions],
    annotations: [...build.annotations],
    conditions: [...build.conditions],
    unresolved: [...build.unresolved],
  };
}

function asRecord(value: Json | undefined): Record<string, Json> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Json>) : undefined;
}

function namespaced(id: string): string {
  return id.includes(":") ? id : `minecraft:${id}`;
}

/**
 * Apply nested function lists in vanilla order.
 *
 * `LootItemFunction.decorate` wraps the *output* consumer, so the innermost
 * decoration runs first: entry functions, then pool functions, then table
 * functions, then any functions inherited from an enclosing table entry.
 */
export function applyFunctionChain(base: ItemBuild, chain: ReadonlyArray<Json[]>, env: FunctionEnv): BuildBranch[] {
  let branches: BuildBranch[] = [{ probability: 1, build: base }];
  for (const list of chain) {
    for (const raw of list) {
      branches = applyOne(branches, raw, env);
    }
  }
  return branches;
}

const MAX_BRANCHES = 64;

function applyOne(branches: BuildBranch[], raw: Json, env: FunctionEnv): BuildBranch[] {
  const object = asRecord(raw);
  if (!object) {
    env.warnings.push(`malformed loot function: ${JSON.stringify(raw)}`);
    return branches;
  }
  const compiler = new ConditionCompiler(env.data, env.context);
  const compiled = compiler.compileAll(object.conditions);
  const probability = compiler.probabilityOf(compiled.expr);
  env.warnings.push(...compiler.warnings);

  const next: BuildBranch[] = [];
  for (const branch of branches) {
    if (probability > 0) {
      const applied = cloneBuild(branch.build);
      applied.conditions.push(...compiled.summaries);
      applied.unresolved.push(...compiled.unresolved);
      runFunction(applied, object, env);
      next.push({ probability: branch.probability * probability, build: applied });
    }
    if (probability < 1) {
      const skipped = cloneBuild(branch.build);
      skipped.conditions.push(...compiled.summaries);
      skipped.unresolved.push(...compiled.unresolved);
      next.push({ probability: branch.probability * (1 - probability), build: skipped });
    }
  }
  if (next.length > MAX_BRANCHES) {
    env.warnings.push(`function branch explosion capped at ${MAX_BRANCHES} branches`);
    return next.slice(0, MAX_BRANCHES);
  }
  return next;
}

function enchantmentLevel(env: FunctionEnv, id: Json | undefined): number {
  if (typeof id !== "string") return 0;
  return env.context.enchantmentLevels?.[namespaced(id)] ?? 0;
}

function runFunction(build: ItemBuild, object: Record<string, Json>, env: FunctionEnv): void {
  const type = namespaced(typeof object.function === "string" ? object.function : "unknown");
  const maxCount = env.context.maxTrackedCount;

  switch (type) {
    case "minecraft:set_count": {
      const resolved = resolveIntProvider(object.count, maxCount);
      if (!resolved.resolved) {
        build.annotations.push(`set_count could not be resolved (${resolved.note ?? "unknown provider"})`);
        env.warnings.push(`set_count unresolved: ${JSON.stringify(object.count)}`);
        return;
      }
      build.counts = object.add === true ? convolve(build.counts, resolved.distribution, maxCount) : [...resolved.distribution];
      return;
    }
    case "minecraft:limit_count": {
      const limit = object.limit;
      let min: number | undefined;
      let max: number | undefined;
      if (typeof limit === "number") {
        min = limit;
        max = limit;
      } else {
        const range = asRecord(limit);
        if (range) {
          if (range.min !== undefined) min = statsOf(resolveIntProvider(range.min, maxCount).distribution).max;
          if (range.max !== undefined) max = statsOf(resolveIntProvider(range.max, maxCount).distribution).max;
        }
      }
      build.counts = clampCounts(build.counts, min, max);
      return;
    }
    case "minecraft:enchanted_count_increase":
    case "minecraft:looting_enchant": {
      const level = enchantmentLevel(env, object.enchantment ?? "minecraft:looting");
      if (level <= 0) return;
      const provider = resolveFloatProvider(object.count);
      if (!provider.resolved) {
        build.annotations.push("enchanted_count_increase count could not be resolved");
        env.warnings.push(`enchanted_count_increase unresolved: ${JSON.stringify(object.count)}`);
        return;
      }
      const offsets = roundedScaledPairs(provider, level);
      build.counts = mix(
        offsets.map(([offset, probability]) => ({
          probability,
          distribution: shiftCounts(build.counts, offset, maxCount),
        })),
        maxCount,
      );
      const limit = typeof object.limit === "number" ? object.limit : 0;
      if (limit > 0) build.counts = clampCounts(build.counts, undefined, limit);
      return;
    }
    case "minecraft:apply_bonus": {
      if (!env.context.toolPresent) {
        build.annotations.push("apply_bonus skipped: no tool in context");
        return;
      }
      applyBonus(build, object, env);
      return;
    }
    case "minecraft:explosion_decay": {
      const radius = env.context.explosionRadius;
      if (radius === undefined) {
        build.annotations.push("explosion_decay is a no-op outside explosions");
        return;
      }
      const survival = Math.min(1, 1 / radius);
      build.counts = mix(
        build.counts.map((probability, count) => ({ probability, distribution: binomial(count, survival, maxCount) })),
        maxCount,
      );
      return;
    }
    case "minecraft:set_damage": {
      const provider = resolveFloatProvider(object.damage);
      if (!provider.resolved) {
        build.annotations.push("set_damage could not be resolved");
        return;
      }
      const maxDurability = env.data.durability.get(build.itemId);
      build.damage = {
        minDamageFraction: 1 - Math.min(1, Math.max(0, provider.max)),
        maxDamageFraction: 1 - Math.min(1, Math.max(0, provider.min)),
        expectedDamageFraction: 1 - Math.min(1, Math.max(0, provider.expected)),
        ...(maxDurability === undefined ? {} : { maxDurability }),
      };
      return;
    }
    case "minecraft:furnace_smelt": {
      const smelted = env.data.smelting.get(build.itemId);
      if (!smelted) {
        build.annotations.push(`furnace_smelt has no smelting recipe for ${build.itemId}`);
        return;
      }
      const stackSize = env.data.stackSize.get(smelted.itemId) ?? 64;
      build.itemId = smelted.itemId;
      build.smelted = true;
      build.counts = clampCounts(scaleCounts(build.counts, smelted.count, maxCount), undefined, stackSize);
      return;
    }
    case "minecraft:set_potion": {
      const id = typeof object.id === "string" ? namespaced(object.id) : undefined;
      if (id && id !== "minecraft:empty") build.potions.push(id);
      return;
    }
    case "minecraft:enchant_with_levels": {
      const levels = resolveIntProvider(object.levels, maxCount);
      build.enchantments.push({
        source: "enchant_with_levels",
        levels: statsOf(levels.distribution),
        possibleEnchantments: resolveEnchantmentOptions(env.data, object.options),
      });
      convertBookToEnchantedBook(build, env);
      return;
    }
    case "minecraft:enchant_randomly": {
      build.enchantments.push({
        source: "enchant_randomly",
        possibleEnchantments: resolveEnchantmentOptions(env.data, object.options),
        onlyCompatible: object.only_compatible === undefined ? true : object.only_compatible === true,
      });
      convertBookToEnchantedBook(build, env);
      return;
    }
    case "minecraft:set_enchantments": {
      const enchantments = asRecord(object.enchantments) ?? {};
      const fixedLevels: Record<string, number> = {};
      for (const [id, value] of Object.entries(enchantments)) {
        const level = resolveIntProvider(value, maxCount);
        fixedLevels[namespaced(id)] = statsOf(level.distribution).expected;
      }
      build.enchantments.push({
        source: "set_enchantments",
        possibleEnchantments: Object.keys(fixedLevels),
        fixedLevels,
      });
      return;
    }
    case "minecraft:copy_components":
    case "minecraft:copy_custom_data":
    case "minecraft:copy_name":
    case "minecraft:copy_state":
    case "minecraft:exploration_map":
    case "minecraft:fill_player_head":
    case "minecraft:modify_contents":
    case "minecraft:set_attributes":
    case "minecraft:set_banner_pattern":
    case "minecraft:set_book_cover":
    case "minecraft:set_components":
    case "minecraft:set_contents":
    case "minecraft:set_custom_data":
    case "minecraft:set_custom_model_data":
    case "minecraft:set_firework_explosion":
    case "minecraft:set_fireworks":
    case "minecraft:set_instrument":
    case "minecraft:set_loot_table":
    case "minecraft:set_lore":
    case "minecraft:set_name":
    case "minecraft:set_ominous_bottle_amplifier":
    case "minecraft:set_stew_effect":
    case "minecraft:set_writable_book_pages":
    case "minecraft:set_written_book_pages":
    case "minecraft:toggle_tooltips":
      build.annotations.push(`${type} affects item metadata only`);
      return;
    case "minecraft:set_random_dyes":
    case "minecraft:set_random_potion":
      build.annotations.push(`${type} randomises item metadata; not modelled per-variant`);
      return;
    case "minecraft:filtered":
    case "minecraft:sequence":
    case "minecraft:reference":
      build.annotations.push(`${type} wraps other functions; nested effects are not modelled`);
      env.warnings.push(`function ${type} is not expanded`);
      return;
    case "minecraft:discard_item":
      build.annotations.push("discard_item may remove this drop entirely");
      env.warnings.push("function minecraft:discard_item is not modelled");
      return;
    default:
      build.annotations.push(`unknown function ${type}`);
      env.warnings.push(`unknown loot function ${type}`);
      return;
  }
}

function shiftCounts(counts: readonly number[], offset: number, maxCount: number): number[] {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < counts.length; i += 1) {
    const probability = counts[i] ?? 0;
    if (probability !== 0) pairs.push([Math.max(0, i + offset), probability]);
  }
  return fromPairs(pairs, maxCount);
}

function convertBookToEnchantedBook(build: ItemBuild, env: FunctionEnv): void {
  if (build.itemId !== "minecraft:book") return;
  // EnchantmentHelper.enchantItem: `if (itemStack.is(Items.BOOK)) itemStack = new ItemStack(Items.ENCHANTED_BOOK);`
  build.itemId = "minecraft:enchanted_book";
  build.annotations.push(`enchanting turns ${itemDisplayName(env.data, "minecraft:book")} into an Enchanted Book`);
}

function applyBonus(build: ItemBuild, object: Record<string, Json>, env: FunctionEnv): void {
  const maxCount = env.context.maxTrackedCount;
  const level = enchantmentLevel(env, object.enchantment);
  const formulaRaw = typeof object.formula === "string" ? namespaced(object.formula) : undefined;
  const parameters = asRecord(object.parameters) ?? {};

  switch (formulaRaw) {
    case "minecraft:uniform_bonus_count": {
      const multiplier = typeof parameters.bonusMultiplier === "number" ? parameters.bonusMultiplier : 1;
      // count + random.nextInt(bonusMultiplier * level + 1)
      const bonus = uniformInclusive(0, Math.max(0, multiplier * level), maxCount);
      build.counts = convolve(build.counts, bonus, maxCount);
      return;
    }
    case "minecraft:binomial_with_bonus_count": {
      const extra = typeof parameters.extra === "number" ? parameters.extra : 0;
      const probability = typeof parameters.probability === "number" ? parameters.probability : 0;
      build.counts = convolve(build.counts, binomial(level + extra, probability, maxCount), maxCount);
      return;
    }
    case "minecraft:ore_drops": {
      if (level <= 0) return;
      // bonus = max(0, random.nextInt(level + 2) - 1); count *= bonus + 1
      const span = level + 2;
      const multipliers: Array<[number, number]> = [[1, 2 / span]];
      for (let bonus = 1; bonus <= level; bonus += 1) multipliers.push([bonus + 1, 1 / span]);
      build.counts = mix(
        multipliers.map(([multiplier, probability]) => ({
          probability,
          distribution: scaleCounts(build.counts, multiplier, maxCount),
        })),
        maxCount,
      );
      return;
    }
    default:
      build.annotations.push(`apply_bonus formula ${formulaRaw ?? "?"} is not modelled`);
      env.warnings.push(`unknown apply_bonus formula ${formulaRaw ?? "?"}`);
  }
}
