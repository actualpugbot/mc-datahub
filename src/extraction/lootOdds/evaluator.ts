/**
 * The exact loot-table evaluator.
 *
 * No sampling anywhere: pools are solved in closed form. The only enumeration
 * is over the *scenarios* created by probabilistic conditions
 * (`random_chance`, `table_bonus`, ...), which is exact rather than approximate
 * because those conditions decide which entries are even in the weighted pool.
 *
 * The effective-weight formula comes straight from the decompiled
 * `LootPoolSingletonContainer.EntryBase`:
 *
 *   public int getWeight(final float luck) {
 *      return Math.max(Mth.floor(LootPoolSingletonContainer.this.weight
 *                                + LootPoolSingletonContainer.this.quality * luck), 0);
 *   }
 *
 * and `LootPool.addRandomItem` only keeps entries whose weight is `> 0`.
 */

import { ConditionCompiler, evaluateExpr, resolveContext, type ConditionExpr, type ResolvedOddsContext } from "./conditions.js";
import { itemDisplayName, type LootOddsData, type LootTableRecord } from "./data.js";
import { convolve, convolveTimes, fromPairs, mix, statsOf, summarise, toPairs, toPairsWithZero, trim } from "./distribution.js";
import { applyFunctionChain, createItemBuild, type FunctionEnv, type ItemBuild } from "./functions.js";
import { resolveFloatProvider, resolveIntProvider } from "./numbers.js";
import type {
  CategoryOdds,
  ConditionSummary,
  DamageRange,
  EnchantMetadata,
  EntryOdds,
  Json,
  LootOutcome,
  LootTableOdds,
  OddsContext,
  PoolOdds,
} from "./types.js";

/** How outcomes are keyed: one row per entry path, or one row per item id. */
export type OutcomeGrain = "outcome" | "item";

/** Context plus the dataset the engine reads from. */
export interface EvaluationContext extends OddsContext {
  data: LootOddsData;
}

type DistMap = Map<string, number[]>;

interface KeyMeta {
  key: string;
  kind: "item" | "dynamic";
  itemId: string;
  tablePaths: Set<string>;
  entryPaths: Set<string>;
  poolIndices: Set<number>;
  damage?: DamageRange;
  enchantments: EnchantMetadata[];
  potions: Set<string>;
  smelted: boolean;
  conditions: Map<string, ConditionSummary>;
  unresolved: Set<string>;
  annotations: Set<string>;
  perRollByPool: Map<number, number>;
}

interface EntryNode {
  type: string;
  raw: Record<string, Json>;
  expr: ConditionExpr;
  summaries: ConditionSummary[];
  unresolved: string[];
  weight: number;
  quality: number;
  path: string;
  children: EntryNode[];
  /** Item ids a `minecraft:tag` entry expands to. */
  tagItems: string[];
  tagExpand: boolean;
}

interface ExpandedEntry {
  node: EntryNode;
  itemOverride?: string;
}

interface PoolEvaluation {
  perRoll: DistMap;
  odds: PoolOdds;
}

const COMPOSITE_TYPES = new Set(["minecraft:alternatives", "minecraft:group", "minecraft:sequence"]);
const MAX_TABLE_DEPTH = 24;

function asRecord(value: Json | undefined): Record<string, Json> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Json>) : undefined;
}

function asArray(value: Json | undefined): Json[] {
  return Array.isArray(value) ? value : [];
}

function namespaced(id: string): string {
  return id.includes(":") ? id : `minecraft:${id}`;
}

/**
 * `Math.max(Mth.floor(weight + quality * luck), 0)` -- the exact vanilla formula.
 * Note it floors the *sum*, not `quality * luck` on its own, which only differs
 * for fractional luck (Luck potions stack in whole points, but attributes can
 * be fractional).
 */
export function effectiveWeight(weight: number, quality: number, luck: number): number {
  return Math.max(Math.floor(weight + quality * luck), 0);
}

class Evaluator {
  readonly warnings: string[] = [];
  readonly meta = new Map<string, KeyMeta>();

  constructor(
    private readonly data: LootOddsData,
    private readonly context: ResolvedOddsContext,
    private readonly grain: OutcomeGrain,
  ) {}

  private get functionEnv(): FunctionEnv {
    return { data: this.data, context: this.context, warnings: this.warnings };
  }

  /** Evaluate a whole table into a count distribution per outcome key. */
  evaluateTable(
    tableId: string,
    pending: ReadonlyArray<Json[]>,
    stack: readonly string[],
    tablePath: readonly string[],
    pathPrefix: string,
    poolIndexForMeta: number | undefined,
    collectPools: boolean,
  ): { dist: DistMap; pools: PoolOdds[] } {
    if (stack.includes(tableId)) {
      this.warnings.push(`loot table cycle detected at ${tableId}`);
      return { dist: new Map(), pools: [] };
    }
    if (stack.length >= MAX_TABLE_DEPTH) {
      this.warnings.push(`loot table nesting deeper than ${MAX_TABLE_DEPTH} at ${tableId}`);
      return { dist: new Map(), pools: [] };
    }
    const record = this.data.tables.get(tableId);
    if (!record) {
      this.warnings.push(`missing loot table ${tableId}`);
      return { dist: new Map(), pools: [] };
    }
    return this.evaluateTableRecord(record, pending, [...stack, tableId], tablePath, pathPrefix, poolIndexForMeta, collectPools);
  }

  private evaluateTableRecord(
    record: LootTableRecord,
    pending: ReadonlyArray<Json[]>,
    stack: readonly string[],
    tablePath: readonly string[],
    pathPrefix: string,
    poolIndexForMeta: number | undefined,
    collectPools: boolean,
  ): { dist: DistMap; pools: PoolOdds[] } {
    const tableFunctions = asArray(record.raw.functions) as Json[];
    const chainTail: Json[][] = [tableFunctions, ...pending.map((list) => [...list])];
    let total: DistMap = new Map();
    const pools: PoolOdds[] = [];

    asArray(record.raw.pools).forEach((rawPool, poolIndex) => {
      const pool = asRecord(rawPool);
      if (!pool) return;
      const metaPoolIndex = collectPools ? poolIndex : poolIndexForMeta;
      const evaluation = this.evaluatePool(
        pool,
        poolIndex,
        chainTail,
        stack,
        tablePath,
        `${pathPrefix}#${poolIndex}`,
        metaPoolIndex,
      );
      if (collectPools) pools.push(evaluation.odds);

      const poolDist = this.combineRolls(evaluation, metaPoolIndex, collectPools);
      total = convolveMaps(total, poolDist, this.context.maxTrackedCount);
    });

    return { dist: total, pools };
  }

  /** Fold the per-roll distribution into a whole-pool distribution. */
  private combineRolls(evaluation: PoolEvaluation, metaPoolIndex: number | undefined, recordPerRoll: boolean): DistMap {
    const maxCount = this.context.maxTrackedCount;
    const rollPairs = evaluation.odds.rollsDistribution;
    const poolProbability = evaluation.odds.poolConditionProbability;
    const out: DistMap = new Map();

    for (const [key, perRoll] of evaluation.perRoll) {
      if (recordPerRoll && metaPoolIndex !== undefined) {
        const meta = this.meta.get(key);
        if (meta) {
          const existing = meta.perRollByPool.get(metaPoolIndex) ?? 0;
          meta.perRollByPool.set(metaPoolIndex, existing + (1 - (perRoll[0] ?? 0)) * poolProbability);
        }
      }
      const branches = rollPairs
        .filter(([rolls]) => rolls > 0)
        .map(([rolls, probability]) => ({
          probability: probability * poolProbability,
          distribution: convolveTimes(perRoll, rolls, maxCount),
        }));
      const zeroMass = 1 - branches.reduce((sum, branch) => sum + branch.probability, 0);
      if (zeroMass > 0) branches.push({ probability: zeroMass, distribution: [1] });
      out.set(key, trim(mix(branches, maxCount)));
    }
    return out;
  }

  private evaluatePool(
    pool: Record<string, Json>,
    poolIndex: number,
    chainTail: ReadonlyArray<Json[]>,
    stack: readonly string[],
    tablePath: readonly string[],
    pathPrefix: string,
    metaPoolIndex: number | undefined,
  ): PoolEvaluation {
    const maxCount = this.context.maxTrackedCount;
    const poolFunctions = asArray(pool.functions) as Json[];
    const entryChain: Json[][] = [poolFunctions, ...chainTail.map((list) => [...list])];

    // Pool conditions are tested once per pool, so they get their own compiler.
    const poolCompiler = new ConditionCompiler(this.data, this.context);
    const poolConditions = poolCompiler.compileAll(pool.conditions);
    const poolConditionProbability = poolCompiler.probabilityOf(poolConditions.expr);
    this.warnings.push(...poolCompiler.warnings);

    // Entry conditions are re-tested on every roll, so they are enumerated per roll.
    const entryCompiler = new ConditionCompiler(this.data, this.context);
    const nodes = asArray(pool.entries).map((raw, index) => this.buildNode(raw, entryCompiler, `${pathPrefix}[${index}]`));
    this.warnings.push(...entryCompiler.warnings);

    const atomCount = entryCompiler.atoms.length;
    const scenarioCount = 2 ** atomCount;
    const capped = scenarioCount > this.context.maxConditionScenarios;
    if (capped) {
      this.warnings.push(
        `pool ${pathPrefix} has ${atomCount} probabilistic conditions (${scenarioCount} scenarios); capped at ${this.context.maxConditionScenarios}`,
      );
    }
    const scenarioList: Array<{ assignment: boolean[]; probability: number }> = [];
    if (capped) {
      // Fall back to the same pass-through stance used for unresolved conditions.
      scenarioList.push({ assignment: new Array<boolean>(atomCount).fill(true), probability: 1 });
    } else {
      for (let scenario = 0; scenario < scenarioCount; scenario += 1) {
        const assignment: boolean[] = [];
        let probability = 1;
        for (let atom = 0; atom < atomCount; atom += 1) {
          const value = ((scenario >> atom) & 1) === 1;
          assignment.push(value);
          const atomProbability = entryCompiler.atoms[atom] ?? 0;
          probability *= value ? atomProbability : 1 - atomProbability;
        }
        if (probability > 0) scenarioList.push({ assignment, probability });
      }
    }

    const produceCache = new Map<string, DistMap>();
    const perRollParts = new Map<string, Array<{ probability: number; distribution: readonly number[] }>>();
    const entrySelection = new Map<string, number>();
    let expectedTotalWeight = 0;

    for (const { assignment, probability: scenarioProbability } of scenarioList) {
      const expanded: ExpandedEntry[] = [];
      for (const node of nodes) expandNode(node, assignment, expanded);

      const weighted = expanded
        .map((entry) => ({ entry, weight: effectiveWeight(entry.node.weight, entry.node.quality, this.context.luck) }))
        .filter((item) => item.weight > 0);
      const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
      expectedTotalWeight += scenarioProbability * totalWeight;
      if (totalWeight === 0) continue;

      for (const { entry, weight } of weighted) {
        const selection = weight / totalWeight;
        const rootPath = rootPathOf(entry.node, nodes);
        entrySelection.set(rootPath, (entrySelection.get(rootPath) ?? 0) + scenarioProbability * selection);

        const cacheKey = `${entry.node.path}|${entry.itemOverride ?? ""}`;
        let produced = produceCache.get(cacheKey);
        if (!produced) {
          produced = this.produce(entry, entryChain, stack, tablePath, metaPoolIndex);
          produceCache.set(cacheKey, produced);
        }
        for (const [key, distribution] of produced) {
          const parts = perRollParts.get(key) ?? [];
          parts.push({ probability: scenarioProbability * selection, distribution });
          perRollParts.set(key, parts);
        }
      }
    }

    const perRoll: DistMap = new Map();
    for (const [key, parts] of perRollParts) {
      const covered = parts.reduce((sum, part) => sum + part.probability, 0);
      const branches = [...parts];
      if (covered < 1) branches.push({ probability: 1 - covered, distribution: [1] });
      perRoll.set(key, trim(mix(branches, maxCount)));
      // Pool-level conditions gate every outcome the pool can produce, so they
      // belong on each outcome's condition list too.
      const meta = this.meta.get(key);
      if (meta) {
        for (const summary of poolConditions.summaries) {
          if (!meta.conditions.has(summary.signature)) meta.conditions.set(summary.signature, summary);
        }
        for (const signature of poolConditions.unresolved) meta.unresolved.add(signature);
      }
    }

    const rollsResolved = resolveIntProvider(pool.rolls ?? 1, maxCount);
    if (!rollsResolved.resolved) {
      this.warnings.push(`pool ${pathPrefix} rolls provider unresolved (${rollsResolved.note ?? "?"})`);
    }
    const rollsDistribution = this.applyBonusRolls(rollsResolved.distribution, pool.bonus_rolls, pathPrefix);

    const entries: EntryOdds[] = nodes.map((node) => ({
      type: node.type,
      ...(targetIdOf(node) === undefined ? {} : { targetId: targetIdOf(node) }),
      weight: node.weight,
      quality: node.quality,
      effectiveWeight: effectiveWeight(node.weight, node.quality, this.context.luck),
      probabilityPerRoll: entrySelection.get(node.path) ?? 0,
      conditionProbability: entryCompiler.probabilityOf(node.expr),
    }));

    return {
      perRoll,
      odds: {
        index: poolIndex,
        rollsDistribution: toPairsWithZero(rollsDistribution),
        rolls: statsOf(rollsDistribution),
        poolConditionProbability,
        totalWeight: atomCount === 0 ? Math.round(expectedTotalWeight) : expectedTotalWeight,
        totalWeightExact: atomCount === 0,
        entries,
      },
    };
  }

  /**
   * `LootPool.addRandomItems`:
   *   int count = this.rolls.getInt(context) + Mth.floor(this.bonusRolls.getFloat(context) * context.getLuck());
   */
  private applyBonusRolls(rolls: readonly number[], bonusRolls: Json | undefined, pathPrefix: string): number[] {
    if (bonusRolls === undefined) return [...rolls];
    const provider = resolveFloatProvider(bonusRolls);
    if (!provider.resolved) {
      this.warnings.push(`pool ${pathPrefix} bonus_rolls unresolved`);
      return [...rolls];
    }
    const luck = this.context.luck;
    const offsets: Array<[number, number]> = provider.continuous
      ? flooredScaledPairs(provider.min * luck, provider.max * luck)
      : [[Math.floor(provider.min * luck), 1]];
    return mix(
      offsets.map(([offset, probability]) => ({
        probability,
        distribution: fromPairs(
          toPairsWithZero(rolls).map(([value, p]) => [Math.max(0, value + offset), p] as [number, number]),
          this.context.maxTrackedCount,
        ),
      })),
      this.context.maxTrackedCount,
    );
  }

  /** Compile one entry (and, recursively, composite children) into a node. */
  private buildNode(raw: Json, compiler: ConditionCompiler, path: string): EntryNode {
    const object = asRecord(raw) ?? {};
    const type = namespaced(typeof object.type === "string" ? object.type : "minecraft:empty");
    const compiled = compiler.compileAll(object.conditions);
    const node: EntryNode = {
      type,
      raw: object,
      expr: compiled.expr,
      summaries: compiled.summaries,
      unresolved: compiled.unresolved,
      weight: typeof object.weight === "number" ? object.weight : 1,
      quality: typeof object.quality === "number" ? object.quality : 0,
      path,
      children: [],
      tagItems: [],
      tagExpand: false,
    };
    if (COMPOSITE_TYPES.has(type)) {
      node.children = asArray(object.children).map((child, index) => this.buildNode(child, compiler, `${path}/c${index}`));
    } else if (type === "minecraft:tag") {
      const tagId = typeof object.name === "string" ? namespaced(object.name) : undefined;
      node.tagExpand = object.expand === true;
      node.tagItems = tagId ? [...(this.data.itemTags.get(tagId) ?? [])] : [];
      if (tagId && node.tagItems.length === 0) this.warnings.push(`item tag ${tagId} is empty or unknown`);
    }
    return node;
  }

  /** The count distribution one selected entry produces, per outcome key. */
  private produce(
    entry: ExpandedEntry,
    entryChain: ReadonlyArray<Json[]>,
    stack: readonly string[],
    tablePath: readonly string[],
    metaPoolIndex: number | undefined,
  ): DistMap {
    const node = entry.node;
    const entryFunctions = asArray(node.raw.functions) as Json[];
    const chain: Json[][] = [entryFunctions, ...entryChain.map((list) => [...list])];

    switch (node.type) {
      case "minecraft:empty":
        return new Map();
      case "minecraft:item": {
        const itemId = typeof node.raw.name === "string" ? namespaced(node.raw.name) : undefined;
        if (!itemId) {
          this.warnings.push(`item entry without a name at ${node.path}`);
          return new Map();
        }
        return this.buildItemDist(itemId, "item", chain, node, tablePath, metaPoolIndex);
      }
      case "minecraft:tag": {
        const items = entry.itemOverride ? [entry.itemOverride] : node.tagItems;
        let out: DistMap = new Map();
        for (const itemId of items) {
          out = convolveMaps(
            out,
            this.buildItemDist(namespaced(itemId), "item", chain, node, tablePath, metaPoolIndex),
            this.context.maxTrackedCount,
          );
        }
        return out;
      }
      case "minecraft:dynamic": {
        const name = typeof node.raw.name === "string" ? namespaced(node.raw.name) : "minecraft:unknown";
        const build = createItemBuild(name, "dynamic");
        build.annotations.push("dynamic drops are decided by the block entity at runtime");
        this.warnings.push(`dynamic entry ${name} at ${node.path} is annotated, not computed`);
        return this.branchesToDist([{ probability: 1, build }], node, tablePath, metaPoolIndex);
      }
      case "minecraft:loot_table": {
        const value = node.raw.value;
        if (typeof value === "string") {
          const nestedId = namespaced(value);
          return this.evaluateTable(
            nestedId,
            chain,
            stack,
            [...tablePath, nestedId],
            `${node.path}>${nestedId}`,
            metaPoolIndex,
            false,
          ).dist;
        }
        const inline = asRecord(value);
        if (!inline) {
          this.warnings.push(`loot_table entry at ${node.path} has no value`);
          return new Map();
        }
        return this.evaluateTableRecord(
          { id: `${node.path}->{inline}`, raw: inline },
          chain,
          stack,
          [...tablePath, "{inline}"],
          `${node.path}>{inline}`,
          metaPoolIndex,
          false,
        ).dist;
      }
      default:
        this.warnings.push(`unsupported entry type ${node.type} at ${node.path}`);
        return new Map();
    }
  }

  private buildItemDist(
    itemId: string,
    kind: "item" | "dynamic",
    chain: ReadonlyArray<Json[]>,
    node: EntryNode,
    tablePath: readonly string[],
    metaPoolIndex: number | undefined,
  ): DistMap {
    const branches = applyFunctionChain(createItemBuild(itemId, kind), chain, this.functionEnv);
    return this.branchesToDist(branches, node, tablePath, metaPoolIndex);
  }

  private branchesToDist(
    branches: ReadonlyArray<{ probability: number; build: ItemBuild }>,
    node: EntryNode,
    tablePath: readonly string[],
    metaPoolIndex: number | undefined,
  ): DistMap {
    const out: DistMap = new Map();
    for (const branch of branches) {
      if (branch.probability === 0) continue;
      const key = this.registerMeta(branch.build, node, tablePath, metaPoolIndex);
      const existing = out.get(key) ?? [0];
      const counts = branch.build.counts;
      const merged =
        existing.length >= counts.length
          ? [...existing]
          : [...existing, ...new Array<number>(counts.length - existing.length).fill(0)];
      for (let i = 0; i < counts.length; i += 1) merged[i] = (merged[i] ?? 0) + branch.probability * (counts[i] ?? 0);
      out.set(key, merged);
    }
    // Any probability mass not covered by a branch means "this key did not drop".
    for (const [key, dist] of out) {
      const covered = dist.reduce((sum, value) => sum + value, 0);
      if (covered < 1) dist[0] = (dist[0] ?? 0) + (1 - covered);
      out.set(key, trim(dist));
    }
    return out;
  }

  private registerMeta(
    build: ItemBuild,
    node: EntryNode,
    tablePath: readonly string[],
    metaPoolIndex: number | undefined,
  ): string {
    const signature = metadataSignature(build);
    const key = this.grain === "item" ? build.itemId : `${node.path}|${build.itemId}|${signature}`;
    let meta = this.meta.get(key);
    if (!meta) {
      meta = {
        key,
        kind: build.kind,
        itemId: build.itemId,
        tablePaths: new Set(),
        entryPaths: new Set(),
        poolIndices: new Set(),
        enchantments: [],
        potions: new Set(),
        smelted: false,
        conditions: new Map(),
        unresolved: new Set(),
        annotations: new Set(),
        perRollByPool: new Map(),
      };
      this.meta.set(key, meta);
    }
    meta.tablePaths.add(tablePath.join(" > "));
    meta.entryPaths.add(node.path);
    if (metaPoolIndex !== undefined) meta.poolIndices.add(metaPoolIndex);
    if (build.damage) {
      meta.damage = meta.damage
        ? {
            minDamageFraction: Math.min(meta.damage.minDamageFraction, build.damage.minDamageFraction),
            maxDamageFraction: Math.max(meta.damage.maxDamageFraction, build.damage.maxDamageFraction),
            expectedDamageFraction: (meta.damage.expectedDamageFraction + build.damage.expectedDamageFraction) / 2,
            ...(build.damage.maxDurability === undefined ? {} : { maxDurability: build.damage.maxDurability }),
          }
        : build.damage;
    }
    for (const enchantment of build.enchantments) {
      const exists = meta.enchantments.some(
        (existing) =>
          existing.source === enchantment.source &&
          existing.possibleEnchantments.length === enchantment.possibleEnchantments.length &&
          existing.levels?.expected === enchantment.levels?.expected,
      );
      if (!exists) meta.enchantments.push(enchantment);
    }
    for (const potion of build.potions) meta.potions.add(potion);
    if (build.smelted) meta.smelted = true;
    for (const summary of [...node.summaries, ...build.conditions]) {
      if (!meta.conditions.has(summary.signature)) meta.conditions.set(summary.signature, summary);
    }
    for (const signatureText of [...node.unresolved, ...build.unresolved]) meta.unresolved.add(signatureText);
    for (const annotation of build.annotations) meta.annotations.add(annotation);
    return key;
  }

  /** Turn the accumulated metadata plus a distribution map into public outcomes. */
  toOutcomes(dist: DistMap): LootOutcome[] {
    const outcomes: LootOutcome[] = [];
    for (const [key, distribution] of dist) {
      const meta = this.meta.get(key);
      if (!meta) continue;
      const stats = summarise(distribution);
      if (stats.probability <= 0) continue;
      const perRollValues = [...meta.perRollByPool.values()];
      outcomes.push({
        key,
        kind: meta.kind,
        itemId: meta.itemId,
        displayName: meta.kind === "item" ? itemDisplayName(this.data, meta.itemId) : meta.itemId,
        probability: stats.probability,
        ...(perRollValues.length === 1 ? { probabilityPerRoll: perRollValues[0] as number } : {}),
        expectedCount: stats.expected,
        count: stats.count,
        countDistribution: toPairs(distribution),
        tablePath: [...meta.tablePaths].sort()[0]?.split(" > ").filter(Boolean) ?? [],
        entryPaths: [...meta.entryPaths].sort(),
        poolIndices: [...meta.poolIndices].sort((a, b) => a - b),
        ...(meta.damage ? { damage: meta.damage } : {}),
        ...(meta.enchantments.length > 0 ? { enchantments: meta.enchantments } : {}),
        ...(meta.potions.size > 0 ? { potions: [...meta.potions].sort() } : {}),
        ...(meta.smelted ? { smelted: true } : {}),
        conditions: [...meta.conditions.values()],
        unresolvedConditions: [...meta.unresolved].sort(),
        annotations: [...meta.annotations].sort(),
      });
    }
    outcomes.sort((a, b) => b.probability - a.probability || a.itemId.localeCompare(b.itemId));
    return outcomes;
  }
}

function metadataSignature(build: ItemBuild): string {
  const parts: string[] = [];
  if (build.damage) parts.push(`d${build.damage.minDamageFraction.toFixed(4)}-${build.damage.maxDamageFraction.toFixed(4)}`);
  for (const enchantment of build.enchantments) {
    parts.push(`e${enchantment.source}:${enchantment.levels?.expected ?? ""}:${enchantment.possibleEnchantments.length}`);
  }
  if (build.potions.length > 0) parts.push(`p${build.potions.join(",")}`);
  if (build.smelted) parts.push("smelted");
  return parts.join("+");
}

function targetIdOf(node: EntryNode): string | undefined {
  const value = node.raw.value ?? node.raw.name;
  return typeof value === "string" ? namespaced(value) : undefined;
}

function rootPathOf(node: EntryNode, roots: readonly EntryNode[]): string {
  for (const root of roots) {
    if (node.path === root.path || node.path.startsWith(`${root.path}/`)) return root.path;
  }
  return node.path;
}

/**
 * Mirrors `LootPoolEntryContainer.expand` / `CompositeEntryBase.expand`:
 *  - `alternatives` stops at the first child that expands successfully,
 *  - `group` expands every child and always succeeds,
 *  - `sequence` expands children in order and stops at the first failure,
 *    keeping whatever earlier children already emitted.
 */
function expandNode(node: EntryNode, assignment: readonly boolean[], out: ExpandedEntry[]): boolean {
  if (!evaluateExpr(node.expr, assignment)) return false;

  if (COMPOSITE_TYPES.has(node.type)) {
    const children = node.children;
    switch (node.type) {
      case "minecraft:alternatives": {
        for (const child of children) {
          if (expandNode(child, assignment, out)) return true;
        }
        return false;
      }
      case "minecraft:group": {
        for (const child of children) expandNode(child, assignment, out);
        return true;
      }
      default: {
        for (const child of children) {
          if (!expandNode(child, assignment, out)) return false;
        }
        return true;
      }
    }
  }

  if (node.type === "minecraft:tag" && node.tagExpand) {
    for (const itemId of node.tagItems) out.push({ node, itemOverride: itemId });
    return true;
  }

  out.push({ node });
  return true;
}

function convolveMaps(a: DistMap, b: DistMap, maxCount: number): DistMap {
  if (a.size === 0) return new Map(b);
  const out: DistMap = new Map(a);
  for (const [key, dist] of b) {
    const existing = out.get(key);
    out.set(key, existing ? convolve(existing, dist, maxCount) : [...dist]);
  }
  return out;
}

/** Distribution of `Math.floor(X)` for `X` uniform on `[lo, hi)`. */
function flooredScaledPairs(a: number, b: number): Array<[number, number]> {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (hi <= lo) return [[Math.floor(lo), 1]];
  const span = hi - lo;
  const pairs: Array<[number, number]> = [];
  for (let bucket = Math.floor(lo); bucket <= Math.floor(hi); bucket += 1) {
    const overlap = Math.min(hi, bucket + 1) - Math.max(lo, bucket);
    if (overlap > 0) pairs.push([bucket, overlap / span]);
  }
  return pairs;
}

/**
 * Evaluate a loot table into an exact probability distribution over outcomes.
 *
 * Runs twice internally: once keyed by entry path (`outcomes`, so a guide can
 * show "cod from the fish table"), once keyed by item id (`items`, the
 * flattened view). Merging path-keyed rows after the fact would be wrong --
 * entries in the same pool are mutually exclusive within a roll but
 * independent across rolls -- so the flattening happens inside the maths.
 */
export function evaluateLootTable(tableId: string, context: EvaluationContext): LootTableOdds {
  const resolved = resolveContext(context);
  const data = context.data;
  const record = data.tables.get(tableId);

  const outcomeRun = runGrain(data, resolved, tableId, "outcome");
  const itemRun = runGrain(data, resolved, tableId, "item");

  const categories: CategoryOdds[] = [];
  for (const pool of outcomeRun.pools) {
    for (const entry of pool.entries) {
      if (entry.type !== "minecraft:loot_table" || !entry.targetId) continue;
      categories.push({
        tableId: entry.targetId,
        name: entry.targetId.split("/").pop() ?? entry.targetId,
        poolIndex: pool.index,
        weight: entry.weight,
        quality: entry.quality,
        effectiveWeight: entry.effectiveWeight,
        probability: entry.probabilityPerRoll,
      });
    }
  }

  return {
    tableId,
    tableType: record?.type ?? "minecraft:generic",
    context: resolved,
    pools: outcomeRun.pools,
    categories,
    outcomes: outcomeRun.outcomes,
    items: itemRun.outcomes,
    warnings: [...new Set([...outcomeRun.warnings, ...itemRun.warnings])],
  };
}

function runGrain(
  data: LootOddsData,
  context: ResolvedOddsContext,
  tableId: string,
  grain: OutcomeGrain,
): { outcomes: LootOutcome[]; pools: PoolOdds[]; warnings: string[] } {
  const evaluator = new Evaluator(data, context, grain);
  const result = evaluator.evaluateTable(tableId, [], [], [tableId], tableId, undefined, true);
  return {
    outcomes: evaluator.toOutcomes(result.dist),
    pools: result.pools,
    warnings: [...new Set(evaluator.warnings)],
  };
}

/** Convenience wrapper so a caller can bind the dataset once. */
export function createLootOddsEngine(data: LootOddsData): {
  evaluate: (tableId: string, context?: OddsContext) => LootTableOdds;
  data: LootOddsData;
} {
  return {
    data,
    evaluate: (tableId, context = {}) => evaluateLootTable(tableId, { ...context, data }),
  };
}
