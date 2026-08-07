/**
 * Dataset plumbing for the loot-odds engine.
 *
 * The engine never touches the filesystem itself; it takes a {@link LootOddsData}
 * bundle so it can be driven from an already-loaded dataset, from the CLI, or
 * from tests.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Json } from "./types.js";

/** One row of `loot-tables.json`. */
export interface LootTableRecord {
  id: string;
  type?: string;
  sourcePath?: string;
  raw: Record<string, Json>;
}

/** One row of `enchantments.json`, trimmed to what the odds engine needs. */
export interface EnchantmentRecord {
  id: string;
  displayName?: string;
  maxLevel?: number;
  tags?: string[];
}

/** Everything the engine needs to evaluate any loot table exactly. */
export interface LootOddsData {
  /** Loot tables by id, e.g. `minecraft:gameplay/fishing`. */
  tables: Map<string, LootTableRecord>;
  /** Fully resolved item tags (nested `#tag` references flattened), keyed `minecraft:planks`. */
  itemTags: Map<string, string[]>;
  /** Enchantment ids per enchantment tag, keyed `minecraft:on_random_loot`. */
  enchantmentTags: Map<string, string[]>;
  /** Enchantment definitions by id. */
  enchantments: Map<string, EnchantmentRecord>;
  /** Translation key -> localised English string. */
  translations: Map<string, string>;
  /** Item id -> max durability, for turning `set_damage` fractions into real numbers. */
  durability: Map<string, number>;
  /** Item id -> max stack size, used by `furnace_smelt`. */
  stackSize: Map<string, number>;
  /** Smelting input item id -> smelted result. */
  smelting: Map<string, { itemId: string; count: number }>;
}

/** Raw dataset JSON as read off disk. Every field is optional so tests can supply a subset. */
export interface LootOddsDataInput {
  lootTables: unknown;
  tags?: unknown;
  enchantments?: unknown;
  translations?: unknown;
  itemStats?: unknown;
  recipes?: unknown;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Resolve one registry's tags, flattening nested `#tag` references.
 * Tag ids repeat across registries (`minecraft:anvil` is both a block and an
 * item tag), so tags are indexed per registry.
 */
function resolveTagRegistry(rows: unknown[], registry: string): Map<string, string[]> {
  const raw = new Map<string, string[]>();
  for (const row of rows) {
    const record = asRecord(row);
    if (asString(record.registry) !== registry) continue;
    const id = asString(record.id);
    if (!id) continue;
    const values = asArray(record.values)
      .map(asString)
      .filter((value): value is string => value !== undefined);
    const existing = raw.get(id);
    raw.set(id, existing ? [...existing, ...values] : values);
  }

  const resolved = new Map<string, string[]>();
  const resolving = new Set<string>();
  const resolve = (id: string): string[] => {
    const cached = resolved.get(id);
    if (cached) return cached;
    if (resolving.has(id)) return [];
    resolving.add(id);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of raw.get(id) ?? []) {
      const members = value.startsWith("#") ? resolve(value.slice(1)) : [value];
      for (const member of members) {
        if (seen.has(member)) continue;
        seen.add(member);
        out.push(member);
      }
    }
    resolving.delete(id);
    resolved.set(id, out);
    return out;
  };
  for (const id of raw.keys()) resolve(id);
  return resolved;
}

/** Build the engine's data bundle from already-parsed dataset JSON. */
export function createLootOddsData(input: LootOddsDataInput): LootOddsData {
  const tables = new Map<string, LootTableRecord>();
  for (const row of asArray(input.lootTables)) {
    const record = asRecord(row);
    const id = asString(record.id);
    if (!id) continue;
    tables.set(id, {
      id,
      type: asString(record.type),
      sourcePath: asString(record.sourcePath),
      raw: asRecord(record.raw) as Record<string, Json>,
    });
  }

  const tagRows = asArray(input.tags);
  const itemTags = resolveTagRegistry(tagRows, "item");
  const enchantmentTags = resolveTagRegistry(tagRows, "enchantment");

  const enchantments = new Map<string, EnchantmentRecord>();
  for (const row of asArray(input.enchantments)) {
    const record = asRecord(row);
    const id = asString(record.id);
    if (!id) continue;
    enchantments.set(id, {
      id,
      displayName: asString(record.displayName),
      maxLevel: typeof record.maxLevel === "number" ? record.maxLevel : undefined,
      tags: asArray(record.tags).filter((value): value is string => typeof value === "string"),
    });
  }

  const translations = new Map<string, string>();
  const translationRows = asArray(asRecord(input.translations).translations);
  for (const row of translationRows) {
    const record = asRecord(row);
    const key = asString(record.key);
    const value = asString(record.value);
    if (key && value !== undefined) translations.set(key, value);
  }

  const durability = new Map<string, number>();
  const stackSize = new Map<string, number>();
  for (const row of asArray(input.itemStats)) {
    const record = asRecord(row);
    const id = asString(record.id);
    if (!id) continue;
    if (typeof record.durability === "number") durability.set(id, record.durability);
    if (typeof record.stackSize === "number") stackSize.set(id, record.stackSize);
  }

  const smelting = new Map<string, { itemId: string; count: number }>();
  for (const row of asArray(input.recipes)) {
    const record = asRecord(row);
    if (asString(record.type) !== "minecraft:smelting") continue;
    const raw = asRecord(record.raw);
    const result = asRecord(raw.result);
    const resultId = asString(result.id);
    if (!resultId) continue;
    const count = typeof result.count === "number" ? result.count : 1;
    const ingredient = raw.ingredient;
    const inputs: string[] = [];
    if (typeof ingredient === "string") inputs.push(ingredient);
    else if (Array.isArray(ingredient)) {
      for (const value of ingredient) {
        const asText = asString(value);
        if (asText) inputs.push(asText);
      }
    }
    for (const inputId of inputs) {
      if (inputId.startsWith("#")) {
        for (const member of itemTags.get(inputId.slice(1)) ?? []) {
          if (!smelting.has(member)) smelting.set(member, { itemId: resultId, count });
        }
      } else if (!smelting.has(inputId)) {
        smelting.set(inputId, { itemId: resultId, count });
      }
    }
  }

  return { tables, itemTags, enchantmentTags, enchantments, translations, durability, stackSize, smelting };
}

async function readOptionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Load the bundle from a dataset directory such as
 * `workspace/datasets/26.2`. Only `loot-tables.json` is required.
 */
export async function loadLootOddsData(datasetDir: string): Promise<LootOddsData> {
  const [lootTables, tags, enchantments, translations, itemStats, recipes] = await Promise.all([
    readFile(join(datasetDir, "loot-tables.json"), "utf8").then((text) => JSON.parse(text) as unknown),
    readOptionalJson(join(datasetDir, "tags.json")),
    readOptionalJson(join(datasetDir, "enchantments.json")),
    readOptionalJson(join(datasetDir, "translations.json")),
    readOptionalJson(join(datasetDir, "item-stats.json")),
    readOptionalJson(join(datasetDir, "recipes.json")),
  ]);
  return createLootOddsData({ lootTables, tags, enchantments, translations, itemStats, recipes });
}

/** Localised item name, falling back through `item.*` then `block.*` then the raw id. */
export function itemDisplayName(data: LootOddsData, itemId: string): string {
  const [namespace = "minecraft", path = itemId] = itemId.includes(":") ? itemId.split(":", 2) : ["minecraft", itemId];
  return (
    data.translations.get(`item.${namespace}.${path}`) ??
    data.translations.get(`block.${namespace}.${path}`) ??
    data.translations.get(`entity.${namespace}.${path}`) ??
    itemId
  );
}

/** Every enchantment id belonging to an enchantment tag or a plain id list. */
export function resolveEnchantmentOptions(data: LootOddsData, options: Json | undefined): string[] {
  if (options === undefined || options === null) {
    return [...data.enchantments.keys()].sort();
  }
  if (typeof options === "string") {
    if (options.startsWith("#")) return [...(data.enchantmentTags.get(options.slice(1)) ?? [])];
    return [options];
  }
  if (Array.isArray(options)) {
    const out: string[] = [];
    for (const value of options) {
      if (typeof value === "string") out.push(...resolveEnchantmentOptions(data, value));
    }
    return out;
  }
  return [];
}
