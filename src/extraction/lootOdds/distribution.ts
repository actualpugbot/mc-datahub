/**
 * Exact discrete count distributions.
 *
 * A distribution is a dense array indexed by count: `dist[k]` is the
 * probability of exactly `k` items. `dist[0]` is therefore "did not drop".
 * Everything here is closed-form arithmetic on doubles; there is no sampling
 * anywhere in this module.
 */

import type { NumberStats } from "./types.js";

export type Distribution = readonly number[];

/** Default ceiling on tracked counts, so a pathological table cannot blow up memory. */
export const DEFAULT_MAX_COUNT = 1024;

/** The distribution "nothing dropped". */
export const NOTHING: Distribution = [1];

/** A point mass at `value`. */
export function pointMass(value: number, maxCount = DEFAULT_MAX_COUNT): number[] {
  const clamped = Math.max(0, Math.min(maxCount, Math.round(value)));
  const out = new Array<number>(clamped + 1).fill(0);
  out[clamped] = 1;
  return out;
}

/** Build a dense distribution from `value -> probability` pairs. */
export function fromPairs(pairs: Iterable<readonly [number, number]>, maxCount = DEFAULT_MAX_COUNT): number[] {
  const out: number[] = [0];
  for (const [value, probability] of pairs) {
    if (probability === 0) continue;
    const index = Math.max(0, Math.min(maxCount, value));
    while (out.length <= index) out.push(0);
    out[index] = (out[index] ?? 0) + probability;
  }
  return out;
}

/** Inclusive uniform integer distribution over `[min, max]`. */
export function uniformInclusive(min: number, max: number, maxCount = DEFAULT_MAX_COUNT): number[] {
  if (min >= max) return pointMass(min, maxCount);
  const span = max - min + 1;
  const pairs: Array<[number, number]> = [];
  for (let value = min; value <= max; value += 1) pairs.push([value, 1 / span]);
  return fromPairs(pairs, maxCount);
}

/** Binomial(n, p). */
export function binomial(n: number, p: number, maxCount = DEFAULT_MAX_COUNT): number[] {
  if (n <= 0) return pointMass(0, maxCount);
  const probability = Math.min(1, Math.max(0, p));
  const out = new Array<number>(Math.min(n, maxCount) + 1).fill(0);
  let term = Math.pow(1 - probability, n);
  for (let k = 0; k <= n; k += 1) {
    const index = Math.min(k, maxCount);
    out[index] = (out[index] ?? 0) + term;
    if (probability >= 1) {
      // All mass sits at k = n; avoid dividing by zero below.
      term = k === n - 1 ? 1 : 0;
      continue;
    }
    term = (term * (n - k) * probability) / ((k + 1) * (1 - probability));
  }
  return out;
}

/** Sum of two independent counts. */
export function convolve(a: Distribution, b: Distribution, maxCount = DEFAULT_MAX_COUNT): number[] {
  if (a.length === 1 && (a[0] ?? 0) === 1) return [...b];
  if (b.length === 1 && (b[0] ?? 0) === 1) return [...a];
  const limit = Math.min(maxCount, a.length + b.length - 2);
  const out = new Array<number>(limit + 1).fill(0);
  for (let i = 0; i < a.length; i += 1) {
    const pa = a[i] ?? 0;
    if (pa === 0) continue;
    for (let j = 0; j < b.length; j += 1) {
      const pb = b[j] ?? 0;
      if (pb === 0) continue;
      const index = Math.min(limit, i + j);
      out[index] = (out[index] ?? 0) + pa * pb;
    }
  }
  return out;
}

/** Sum of `n` i.i.d. copies, by binary exponentiation. */
export function convolveTimes(dist: Distribution, n: number, maxCount = DEFAULT_MAX_COUNT): number[] {
  if (n <= 0) return [1];
  let result: number[] = [1];
  let base: number[] = [...dist];
  let remaining = n;
  while (remaining > 0) {
    if ((remaining & 1) === 1) result = convolve(result, base, maxCount);
    remaining >>= 1;
    if (remaining > 0) base = convolve(base, base, maxCount);
  }
  return result;
}

/** Probability-weighted mixture of mutually exclusive branches. */
export function mix(
  parts: ReadonlyArray<{ probability: number; distribution: Distribution }>,
  maxCount = DEFAULT_MAX_COUNT,
): number[] {
  const out: number[] = [0];
  for (const part of parts) {
    if (part.probability === 0) continue;
    const dist = part.distribution;
    const limit = Math.min(maxCount, dist.length - 1);
    while (out.length <= limit) out.push(0);
    for (let i = 0; i <= limit; i += 1) {
      out[i] = (out[i] ?? 0) + part.probability * (dist[i] ?? 0);
    }
    // Anything beyond the tracked ceiling piles up on the last bucket.
    if (dist.length - 1 > limit) {
      let tail = 0;
      for (let i = limit + 1; i < dist.length; i += 1) tail += dist[i] ?? 0;
      out[limit] = (out[limit] ?? 0) + part.probability * tail;
    }
  }
  return out;
}

/** Add a deterministic offset to every outcome, clamping at zero. */
export function shift(dist: Distribution, offset: number, maxCount = DEFAULT_MAX_COUNT): number[] {
  if (offset === 0) return [...dist];
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < dist.length; i += 1) {
    const p = dist[i] ?? 0;
    if (p !== 0) pairs.push([Math.max(0, i + offset), p]);
  }
  return fromPairs(pairs, maxCount);
}

/** Clamp every outcome into `[min, max]` (either bound optional). */
export function clampCounts(dist: Distribution, min: number | undefined, max: number | undefined): number[] {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < dist.length; i += 1) {
    const p = dist[i] ?? 0;
    if (p === 0) continue;
    let value = i;
    if (min !== undefined) value = Math.max(value, min);
    if (max !== undefined) value = Math.min(value, max);
    pairs.push([Math.max(0, value), p]);
  }
  return fromPairs(pairs);
}

/** Multiply every outcome by a constant factor. */
export function scaleCounts(dist: Distribution, factor: number, maxCount = DEFAULT_MAX_COUNT): number[] {
  if (factor === 1) return [...dist];
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < dist.length; i += 1) {
    const p = dist[i] ?? 0;
    if (p !== 0) pairs.push([Math.max(0, Math.round(i * factor)), p]);
  }
  return fromPairs(pairs, maxCount);
}

/** Drop trailing zero buckets. */
export function trim(dist: Distribution): number[] {
  let end = dist.length - 1;
  while (end > 0 && (dist[end] ?? 0) === 0) end -= 1;
  return dist.slice(0, end + 1);
}

/** Probability of at least one, expected count, and min/max conditioned on dropping. */
export function summarise(dist: Distribution): { probability: number; expected: number; count: NumberStats } {
  let probability = 0;
  let expected = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (let i = 1; i < dist.length; i += 1) {
    const p = dist[i] ?? 0;
    if (p === 0) continue;
    probability += p;
    expected += i * p;
    if (i < min) min = i;
    if (i > max) max = i;
  }
  const resolvedMin = Number.isFinite(min) ? min : 0;
  return {
    probability,
    expected,
    count: {
      min: resolvedMin,
      max,
      expected: probability > 0 ? expected / probability : 0,
    },
  };
}

/** `[count, probability]` pairs for counts >= 1, sorted ascending. */
export function toPairs(dist: Distribution): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let i = 1; i < dist.length; i += 1) {
    const p = dist[i] ?? 0;
    if (p !== 0) pairs.push([i, p]);
  }
  return pairs;
}

/** `[value, probability]` pairs including zero, sorted ascending. */
export function toPairsWithZero(dist: Distribution): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < dist.length; i += 1) {
    const p = dist[i] ?? 0;
    if (p !== 0) pairs.push([i, p]);
  }
  return pairs;
}

/** Min / max / expected of a distribution treated as a plain integer variable. */
export function statsOf(dist: Distribution): NumberStats {
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  let expected = 0;
  let total = 0;
  for (let i = 0; i < dist.length; i += 1) {
    const p = dist[i] ?? 0;
    if (p === 0) continue;
    total += p;
    expected += i * p;
    if (i < min) min = i;
    if (i > max) max = i;
  }
  return {
    min: Number.isFinite(min) ? min : 0,
    max,
    expected: total > 0 ? expected / total : 0,
  };
}
