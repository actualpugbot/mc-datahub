import type { Json } from "./types.js";

/** Modern loot codecs use one condition/modifier, which may itself be a list. */
export function lootCondition(container: Record<string, Json>): Json | undefined {
  return container.condition ?? container.conditions;
}

export function lootModifiers(container: Record<string, Json>): Json[] {
  const value = container.modifier ?? container.functions;
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
