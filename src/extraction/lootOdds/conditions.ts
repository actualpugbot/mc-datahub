/**
 * Compiling vanilla loot conditions into exact boolean expressions.
 *
 * A condition resolves to one of three things:
 *  - a constant (`killed_by_player` when the context says so),
 *  - a probabilistic *atom* (`random_chance`, `table_bonus`, ...), or
 *  - an unresolved condition, which is reported and treated as pass-through.
 *
 * Every occurrence of a probabilistic condition becomes its own atom, because
 * vanilla re-rolls `context.getRandom()` on every single `test(context)` call.
 * That makes the atoms independent, so `probabilityOf` can multiply directly,
 * and the pool evaluator can enumerate all `2^atoms` scenarios exactly.
 */

import type { LootOddsData } from "./data.js";
import { resolveFloatProvider, resolveLevelBasedValue } from "./numbers.js";
import type { ConditionSummary, Json, OddsContext } from "./types.js";

/** A boolean expression over probabilistic atoms. */
export type ConditionExpr =
  | { kind: "const"; value: boolean }
  | { kind: "atom"; index: number }
  | { kind: "not"; term: ConditionExpr }
  | { kind: "and"; terms: ConditionExpr[] }
  | { kind: "or"; terms: ConditionExpr[] };

/** The result of compiling one `conditions` list. */
export interface CompiledConditions {
  expr: ConditionExpr;
  summaries: ConditionSummary[];
  unresolved: string[];
}

/** Context with every default filled in. */
export interface ResolvedOddsContext extends OddsContext {
  luck: number;
  inOpenWater: boolean;
  killedByPlayer: boolean;
  raining: boolean;
  thundering: boolean;
  toolPresent: boolean;
  unresolvedConditionsPass: boolean;
  maxTrackedCount: number;
  maxConditionScenarios: number;
}

export const ALWAYS: ConditionExpr = { kind: "const", value: true };
export const NEVER: ConditionExpr = { kind: "const", value: false };

/** Fill in every default so the rest of the engine never has to guard. */
export function resolveContext(context: OddsContext = {}): ResolvedOddsContext {
  return {
    ...context,
    luck: context.luck ?? 0,
    inOpenWater: context.inOpenWater ?? true,
    killedByPlayer: context.killedByPlayer ?? false,
    raining: context.raining ?? false,
    thundering: context.thundering ?? false,
    toolPresent: context.toolPresent ?? true,
    unresolvedConditionsPass: context.unresolvedConditionsPass ?? true,
    maxTrackedCount: context.maxTrackedCount ?? 1024,
    maxConditionScenarios: context.maxConditionScenarios ?? 4096,
  };
}

function asRecord(value: Json | undefined): Record<string, Json> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Json>) : undefined;
}

function namespaced(id: string): string {
  return id.includes(":") ? id : `minecraft:${id}`;
}

function compactJson(value: Json | undefined): string {
  const text = JSON.stringify(value ?? null);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/** Stable, content-derived identity for a condition, usable as an override key. */
function signatureOf(type: string, raw: Record<string, Json>): string {
  const rest: Record<string, Json> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "condition") continue;
    rest[key] = value;
  }
  const keys = Object.keys(rest).sort();
  const canonical: Record<string, Json> = {};
  for (const key of keys) canonical[key] = rest[key] as Json;
  return `${type}:${compactJson(canonical)}`;
}

type Leaf =
  | { kind: "true"; detail?: string }
  | { kind: "false"; detail?: string }
  | { kind: "random"; probability: number; detail?: string }
  | { kind: "unresolved"; detail: string };

/** Compiles condition JSON into expressions, collecting atoms and summaries. */
export class ConditionCompiler {
  /** Probability of each atom, indexed by atom id. */
  readonly atoms: number[] = [];
  readonly warnings: string[] = [];

  constructor(
    private readonly data: LootOddsData,
    private readonly context: ResolvedOddsContext,
  ) {}

  /** Compile a `conditions` array (implicitly ANDed, matching `Util.allOf`). */
  compileAll(conditions: Json | undefined): CompiledConditions {
    const summaries: ConditionSummary[] = [];
    const unresolved: string[] = [];
    if (!Array.isArray(conditions) || conditions.length === 0) {
      return { expr: ALWAYS, summaries, unresolved };
    }
    const terms = conditions.map((condition) => this.compileOne(condition, summaries, unresolved));
    return { expr: simplifyAnd(terms), summaries, unresolved };
  }

  private compileOne(raw: Json, summaries: ConditionSummary[], unresolved: string[]): ConditionExpr {
    const object = asRecord(raw);
    if (!object) {
      this.warnings.push(`malformed condition: ${compactJson(raw)}`);
      return this.context.unresolvedConditionsPass ? ALWAYS : NEVER;
    }
    const type = namespaced(typeof object.condition === "string" ? object.condition : "unknown");
    const signature = signatureOf(type, object);

    // Composite conditions recurse before any leaf handling.
    if (type === "minecraft:inverted") {
      const inner = this.compileOne(object.term as Json, summaries, unresolved);
      return simplifyNot(inner);
    }
    if (type === "minecraft:any_of" || type === "minecraft:all_of") {
      const terms = Array.isArray(object.terms) ? object.terms : [];
      const compiled = terms.map((term) => this.compileOne(term, summaries, unresolved));
      return type === "minecraft:any_of" ? simplifyOr(compiled) : simplifyAnd(compiled);
    }

    const override = this.context.conditionOverrides?.[signature];
    const leaf: Leaf =
      override === undefined ? this.resolveLeaf(type, object) : { kind: override ? "true" : "false", detail: "context override" };

    switch (leaf.kind) {
      case "true":
        summaries.push({ type, signature, status: "always", detail: leaf.detail });
        return ALWAYS;
      case "false":
        summaries.push({ type, signature, status: "never", detail: leaf.detail });
        return NEVER;
      case "random": {
        summaries.push({ type, signature, status: "random", probability: leaf.probability, detail: leaf.detail });
        if (leaf.probability <= 0) return NEVER;
        if (leaf.probability >= 1) return ALWAYS;
        this.atoms.push(leaf.probability);
        return { kind: "atom", index: this.atoms.length - 1 };
      }
      default: {
        summaries.push({ type, signature, status: "unresolved", detail: leaf.detail });
        unresolved.push(signature);
        this.warnings.push(`unresolved condition ${signature} (${leaf.detail})`);
        return this.context.unresolvedConditionsPass ? ALWAYS : NEVER;
      }
    }
  }

  private enchantmentLevel(id: Json | undefined): number {
    if (typeof id !== "string") return 0;
    return this.context.enchantmentLevels?.[namespaced(id)] ?? 0;
  }

  private resolveLeaf(type: string, object: Record<string, Json>): Leaf {
    switch (type) {
      case "minecraft:random_chance": {
        const chance = resolveFloatProvider(object.chance);
        if (!chance.resolved) return { kind: "unresolved", detail: chance.note ?? "unreadable chance" };
        // Averaging over a non-constant chance provider is exact by the law of total probability.
        return { kind: "random", probability: clamp01(chance.expected), detail: `chance ${chance.expected}` };
      }
      case "minecraft:random_chance_with_enchanted_bonus": {
        const level = this.enchantmentLevel(object.enchantment);
        const unenchanted = typeof object.unenchanted_chance === "number" ? object.unenchanted_chance : undefined;
        if (unenchanted === undefined) return { kind: "unresolved", detail: "missing unenchanted_chance" };
        if (level <= 0) {
          return { kind: "random", probability: clamp01(unenchanted), detail: `unenchanted chance ${unenchanted}` };
        }
        const enchanted = resolveLevelBasedValue(object.enchanted_chance, level);
        if (enchanted === undefined) return { kind: "unresolved", detail: "unreadable enchanted_chance" };
        return {
          kind: "random",
          probability: clamp01(enchanted),
          detail: `${String(object.enchantment)} ${level} -> ${enchanted}`,
        };
      }
      case "minecraft:table_bonus": {
        const chances = Array.isArray(object.chances) ? object.chances : undefined;
        if (!chances || chances.length === 0) return { kind: "unresolved", detail: "missing chances" };
        const level = this.enchantmentLevel(object.enchantment);
        const index = Math.min(Math.max(level, 0), chances.length - 1);
        const chance = chances[index];
        if (typeof chance !== "number") return { kind: "unresolved", detail: "unreadable chances" };
        return { kind: "random", probability: clamp01(chance), detail: `${String(object.enchantment)} ${level} -> ${chance}` };
      }
      case "minecraft:killed_by_player":
        return {
          kind: this.context.killedByPlayer ? "true" : "false",
          detail: `killed_by_player = ${this.context.killedByPlayer}`,
        };
      case "minecraft:survives_explosion": {
        const radius = this.context.explosionRadius;
        if (radius === undefined) return { kind: "true", detail: "no explosion" };
        return { kind: "random", probability: clamp01(1 / radius), detail: `explosion radius ${radius}` };
      }
      case "minecraft:weather_check": {
        const wantsRain = typeof object.raining === "boolean" ? object.raining : undefined;
        const wantsThunder = typeof object.thundering === "boolean" ? object.thundering : undefined;
        if (wantsRain !== undefined && wantsRain !== this.context.raining) {
          return { kind: "false", detail: `raining = ${this.context.raining}` };
        }
        if (wantsThunder !== undefined && wantsThunder !== this.context.thundering) {
          return { kind: "false", detail: `thundering = ${this.context.thundering}` };
        }
        return { kind: "true", detail: "weather matches" };
      }
      case "minecraft:entity_properties":
        return this.resolveEntityProperties(object);
      case "minecraft:block_state_property": {
        const properties = asRecord(object.properties);
        const state = this.context.blockState;
        if (!properties || !state) return { kind: "unresolved", detail: "no block state in context" };
        for (const [key, expected] of Object.entries(properties)) {
          const actual = state[key];
          if (actual === undefined) return { kind: "unresolved", detail: `block state ${key} not in context` };
          if (typeof expected === "string" && actual !== expected) {
            return { kind: "false", detail: `${key} = ${actual}` };
          }
        }
        return { kind: "true", detail: "block state matches" };
      }
      case "minecraft:match_tool":
        if (this.context.matchesTool === undefined) return { kind: "unresolved", detail: "no tool predicate in context" };
        return { kind: this.context.matchesTool ? "true" : "false", detail: `matchesTool = ${this.context.matchesTool}` };
      case "minecraft:location_check":
        return this.resolveLocationCheck(object);
      default:
        return { kind: "unresolved", detail: `unsupported condition ${type}` };
    }
  }

  private resolveEntityProperties(object: Record<string, Json>): Leaf {
    const predicate = asRecord(object.predicate);
    if (!predicate) return { kind: "unresolved", detail: "missing predicate" };
    const fishingHook = asRecord(predicate["minecraft:type_specific/fishing_hook"]);
    const openWater = fishingHook?.in_open_water;
    if (typeof openWater === "boolean") {
      const matches = openWater === this.context.inOpenWater;
      return { kind: matches ? "true" : "false", detail: `in_open_water = ${this.context.inOpenWater}` };
    }
    return { kind: "unresolved", detail: `entity ${String(object.entity ?? "this")} ${compactJson(object.predicate)}` };
  }

  private resolveLocationCheck(object: Record<string, Json>): Leaf {
    const predicate = asRecord(object.predicate);
    const biome = this.context.biome;
    if (!predicate || biome === undefined) return { kind: "unresolved", detail: "no biome in context" };
    const biomes = predicate.biomes;
    if (biomes === undefined) return { kind: "unresolved", detail: compactJson(object.predicate) };
    const wanted = new Set<string>();
    const push = (value: Json): void => {
      if (typeof value !== "string") return;
      if (value.startsWith("#")) {
        // Biome tags live in the worldgen registry, which this engine does not index.
        wanted.add(value);
        return;
      }
      wanted.add(namespaced(value));
    };
    if (Array.isArray(biomes)) biomes.forEach(push);
    else push(biomes);
    if ([...wanted].some((value) => value.startsWith("#"))) {
      return { kind: "unresolved", detail: `biome tag ${compactJson(biomes)}` };
    }
    const matches = wanted.has(namespaced(biome));
    return { kind: matches ? "true" : "false", detail: `biome ${biome}` };
  }

  /** Exact probability of an expression, using atom independence. */
  probabilityOf(expr: ConditionExpr): number {
    switch (expr.kind) {
      case "const":
        return expr.value ? 1 : 0;
      case "atom":
        return this.atoms[expr.index] ?? 0;
      case "not":
        return 1 - this.probabilityOf(expr.term);
      case "and":
        return expr.terms.reduce((total, term) => total * this.probabilityOf(term), 1);
      case "or":
        return 1 - expr.terms.reduce((total, term) => total * (1 - this.probabilityOf(term)), 1);
    }
  }

  /** Unused data handle kept for future condition types that need registry lookups. */
  protected get dataset(): LootOddsData {
    return this.data;
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Evaluate a compiled expression under a concrete atom assignment. */
export function evaluateExpr(expr: ConditionExpr, assignment: readonly boolean[]): boolean {
  switch (expr.kind) {
    case "const":
      return expr.value;
    case "atom":
      return assignment[expr.index] ?? false;
    case "not":
      return !evaluateExpr(expr.term, assignment);
    case "and":
      return expr.terms.every((term) => evaluateExpr(term, assignment));
    case "or":
      return expr.terms.some((term) => evaluateExpr(term, assignment));
  }
}

/** Every atom index an expression depends on. */
export function atomsOf(expr: ConditionExpr, out: Set<number> = new Set()): Set<number> {
  switch (expr.kind) {
    case "atom":
      out.add(expr.index);
      break;
    case "not":
      atomsOf(expr.term, out);
      break;
    case "and":
    case "or":
      for (const term of expr.terms) atomsOf(term, out);
      break;
    default:
      break;
  }
  return out;
}

function simplifyAnd(terms: ConditionExpr[]): ConditionExpr {
  const kept: ConditionExpr[] = [];
  for (const term of terms) {
    if (term.kind === "const") {
      if (!term.value) return NEVER;
      continue;
    }
    kept.push(term);
  }
  if (kept.length === 0) return ALWAYS;
  if (kept.length === 1) return kept[0] as ConditionExpr;
  return { kind: "and", terms: kept };
}

function simplifyOr(terms: ConditionExpr[]): ConditionExpr {
  const kept: ConditionExpr[] = [];
  for (const term of terms) {
    if (term.kind === "const") {
      if (term.value) return ALWAYS;
      continue;
    }
    kept.push(term);
  }
  if (kept.length === 0) return NEVER;
  if (kept.length === 1) return kept[0] as ConditionExpr;
  return { kind: "or", terms: kept };
}

function simplifyNot(term: ConditionExpr): ConditionExpr {
  if (term.kind === "const") return term.value ? NEVER : ALWAYS;
  if (term.kind === "not") return term.term;
  return { kind: "not", term };
}
