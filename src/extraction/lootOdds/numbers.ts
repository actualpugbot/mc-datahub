/**
 * Exact resolution of vanilla `NumberProvider`s and `LevelBasedValue`s.
 *
 * The integer path mirrors `NumberProvider.getInt` (which defaults to
 * `Math.round(getFloat(context))`) and `UniformGenerator.getInt`
 * (`Mth.nextInt(random, min.getInt, max.getInt)`, inclusive on both ends).
 * The float path mirrors `Mth.nextFloat(random, min, max)`, which is a
 * *continuous* uniform over `[min, max)` -- that distinction matters for
 * `enchanted_count_increase`, where the float is scaled then rounded.
 */

import { binomial, fromPairs, pointMass, DEFAULT_MAX_COUNT } from "./distribution.js";
import type { Json } from "./types.js";

/** A number provider resolved to an exact integer distribution. */
export interface ResolvedIntProvider {
  distribution: number[];
  resolved: boolean;
  note?: string;
}

/** A number provider resolved as a float range. `continuous` distinguishes `[min,max)` from a point. */
export interface ResolvedFloatProvider {
  min: number;
  max: number;
  expected: number;
  continuous: boolean;
  resolved: boolean;
  note?: string;
}

function record(value: Json | undefined): Record<string, Json> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Json>) : undefined;
}

function providerType(value: Record<string, Json>): string | undefined {
  const type = value.type;
  if (typeof type !== "string") return undefined;
  return type.includes(":") ? type : `minecraft:${type}`;
}

/** Resolve a number provider the way `NumberProvider.getFloat` would, as a range. */
export function resolveFloatProvider(raw: Json | undefined): ResolvedFloatProvider {
  if (typeof raw === "number") {
    return { min: raw, max: raw, expected: raw, continuous: false, resolved: true };
  }
  const object = record(raw);
  if (!object) {
    return { min: 0, max: 0, expected: 0, continuous: false, resolved: false, note: "missing number provider" };
  }
  const type = providerType(object);
  if (type === "minecraft:constant") {
    const value = typeof object.value === "number" ? object.value : 0;
    return { min: value, max: value, expected: value, continuous: false, resolved: typeof object.value === "number" };
  }
  if (type === "minecraft:uniform" || (type === undefined && ("min" in object || "max" in object))) {
    const min = resolveFloatProvider(object.min);
    const max = resolveFloatProvider(object.max);
    // Mth.nextFloat returns `min` when min >= max.
    if (min.expected >= max.expected) {
      return { ...min, continuous: false, resolved: min.resolved && max.resolved };
    }
    return {
      min: min.expected,
      max: max.expected,
      expected: (min.expected + max.expected) / 2,
      continuous: true,
      resolved: min.resolved && max.resolved,
    };
  }
  if (type === "minecraft:binomial") {
    const n = resolveFloatProvider(object.n);
    const p = resolveFloatProvider(object.p);
    return {
      min: 0,
      max: n.expected,
      expected: n.expected * p.expected,
      continuous: false,
      resolved: n.resolved && p.resolved,
    };
  }
  return { min: 0, max: 0, expected: 0, continuous: false, resolved: false, note: `unsupported number provider ${type ?? "?"}` };
}

/** Resolve a number provider the way `NumberProvider.getInt` would, as an exact distribution. */
export function resolveIntProvider(raw: Json | undefined, maxCount = DEFAULT_MAX_COUNT): ResolvedIntProvider {
  if (typeof raw === "number") {
    return { distribution: pointMass(Math.round(raw), maxCount), resolved: true };
  }
  const object = record(raw);
  if (!object) {
    return { distribution: pointMass(0, maxCount), resolved: false, note: "missing number provider" };
  }
  const type = providerType(object);
  if (type === "minecraft:constant") {
    const value = typeof object.value === "number" ? object.value : 0;
    return { distribution: pointMass(Math.round(value), maxCount), resolved: typeof object.value === "number" };
  }
  if (type === "minecraft:uniform" || (type === undefined && ("min" in object || "max" in object))) {
    const min = resolveIntProvider(object.min, maxCount);
    const max = resolveIntProvider(object.max, maxCount);
    const minValue = firstValue(min.distribution);
    const maxValue = lastValue(max.distribution);
    const distribution =
      minValue >= maxValue ? pointMass(minValue, maxCount) : fromPairs(uniformPairs(minValue, maxValue), maxCount);
    return { distribution, resolved: min.resolved && max.resolved };
  }
  if (type === "minecraft:binomial") {
    const n = resolveIntProvider(object.n, maxCount);
    const p = resolveFloatProvider(object.p);
    return {
      distribution: binomial(lastValue(n.distribution), p.expected, maxCount),
      resolved: n.resolved && p.resolved,
    };
  }
  if (type === "minecraft:sum") {
    const summands = Array.isArray(object.summands) ? object.summands : [];
    let total = 0;
    let resolved = true;
    for (const summand of summands) {
      const value = resolveFloatProvider(summand);
      total += value.expected;
      if (!value.resolved) resolved = false;
    }
    // Sum.getInt floors the accumulated float.
    return { distribution: pointMass(Math.floor(total), maxCount), resolved };
  }
  return {
    distribution: pointMass(1, maxCount),
    resolved: false,
    note: `unsupported number provider ${type ?? "?"}`,
  };
}

function uniformPairs(min: number, max: number): Array<[number, number]> {
  const span = max - min + 1;
  const pairs: Array<[number, number]> = [];
  for (let value = min; value <= max; value += 1) pairs.push([value, 1 / span]);
  return pairs;
}

function firstValue(dist: readonly number[]): number {
  for (let i = 0; i < dist.length; i += 1) if ((dist[i] ?? 0) > 0) return i;
  return 0;
}

function lastValue(dist: readonly number[]): number {
  for (let i = dist.length - 1; i >= 0; i -= 1) if ((dist[i] ?? 0) > 0) return i;
  return 0;
}

/**
 * Distribution of `Math.round(scale * X)` where `X` is the value a float
 * provider yields. Returns `[offset, probability]` pairs; offsets may be
 * negative, which the caller clamps when it applies them to a stack size.
 *
 * Java rounds with `Math.round(float)` == `floor(x + 0.5)`, so a continuous
 * uniform gives half weight to each endpoint bucket -- the reason a looting-3
 * bonus of "0 to 3" is really 1/6, 1/3, 1/3, 1/6 rather than four equal sixths.
 */
export function roundedScaledPairs(provider: ResolvedFloatProvider, scale: number): Array<[number, number]> {
  if (!provider.continuous || provider.min === provider.max) {
    return [[Math.round(provider.min * scale), 1]];
  }
  const a = provider.min * scale;
  const b = provider.max * scale;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const span = hi - lo;
  if (span <= 0) return [[Math.round(lo), 1]];
  const pairs: Array<[number, number]> = [];
  const firstBucket = Math.round(lo);
  const lastBucket = Math.round(hi);
  for (let k = firstBucket; k <= lastBucket; k += 1) {
    const overlap = Math.min(hi, k + 0.5) - Math.max(lo, k - 0.5);
    if (overlap > 0) pairs.push([k, overlap / span]);
  }
  return pairs;
}

/** Evaluate a `LevelBasedValue` at a concrete enchantment level. */
export function resolveLevelBasedValue(raw: Json | undefined, level: number): number | undefined {
  if (typeof raw === "number") return raw;
  const object = record(raw);
  if (!object) return undefined;
  const type = providerType(object);
  switch (type) {
    case "minecraft:constant":
      return typeof object.value === "number" ? object.value : undefined;
    case "minecraft:linear": {
      const base = typeof object.base === "number" ? object.base : undefined;
      const perLevel = typeof object.per_level_above_first === "number" ? object.per_level_above_first : undefined;
      if (base === undefined || perLevel === undefined) return undefined;
      return base + perLevel * (level - 1);
    }
    case "minecraft:clamped": {
      const inner = resolveLevelBasedValue(object.value, level);
      const min = typeof object.min === "number" ? object.min : undefined;
      const max = typeof object.max === "number" ? object.max : undefined;
      if (inner === undefined || min === undefined || max === undefined) return undefined;
      return Math.min(max, Math.max(min, inner));
    }
    case "minecraft:fraction": {
      const numerator = resolveLevelBasedValue(object.numerator, level);
      const denominator = resolveLevelBasedValue(object.denominator, level);
      if (numerator === undefined || denominator === undefined) return undefined;
      return denominator === 0 ? 0 : numerator / denominator;
    }
    case "minecraft:levels_squared": {
      const added = typeof object.added === "number" ? object.added : undefined;
      return added === undefined ? undefined : level * level + added;
    }
    case "minecraft:exponent": {
      const base = resolveLevelBasedValue(object.base, level);
      const power = resolveLevelBasedValue(object.power, level);
      if (base === undefined || power === undefined) return undefined;
      return Math.pow(base, power);
    }
    case "minecraft:lookup": {
      const values = Array.isArray(object.values) ? object.values : undefined;
      if (!values) return undefined;
      if (level <= values.length) {
        const value = values[level - 1];
        return typeof value === "number" ? value : undefined;
      }
      return resolveLevelBasedValue(object.fallback, level);
    }
    default:
      return undefined;
  }
}
