import type {
  EnchantmentCostFormula,
  EnchantmentDefinition,
  JsonValue,
  TagDefinition,
  TranslationEntry,
} from "../domain/types.js";
import { normalizeMinecraftId } from "./normalizers.js";

// Vanilla enchantment JSON allows a single id, a tag reference ("#minecraft:…"),
// or an inline array of ids anywhere a holder set is expected.
function entryList(value: JsonValue | undefined): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  return [];
}

function costFormula(value: JsonValue | undefined): EnchantmentCostFormula | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const base = value.base;
  if (typeof base !== "number") {
    return undefined;
  }

  const perLevel = value.per_level_above_first;
  return { base, perLevelAboveFirst: typeof perLevel === "number" ? perLevel : 0 };
}

class TagResolver {
  private readonly byKey = new Map<string, TagDefinition>();
  private readonly resolved = new Map<string, string[]>();

  constructor(tags: TagDefinition[]) {
    for (const tag of tags) {
      this.byKey.set(`${tag.registry}|${tag.id}`, tag);
    }
  }

  /** Concrete ids for an entry list, expanding `#tag` references recursively. */
  resolveEntries(registry: string, entries: string[], seen = new Set<string>()): string[] {
    const ids = new Set<string>();
    for (const entry of entries) {
      if (entry.startsWith("#")) {
        for (const id of this.resolveTag(registry, normalizeMinecraftId(entry), seen)) {
          ids.add(id);
        }
      } else {
        ids.add(normalizeMinecraftId(entry));
      }
    }

    return Array.from(ids).sort();
  }

  private resolveTag(registry: string, tagId: string, seen: Set<string>): string[] {
    const key = `${registry}|${tagId}`;
    const cached = this.resolved.get(key);
    if (cached) {
      return cached;
    }

    if (seen.has(key)) {
      return [];
    }

    seen.add(key);
    const tag = this.byKey.get(key);
    const values = tag ? this.resolveEntries(registry, tag.values, seen) : [];
    this.resolved.set(key, values);
    return values;
  }
}

/**
 * Fill the derived enchantment fields that need cross-collection context:
 * resolved supported/primary item ids, resolved exclusive sets, en_us display
 * names, table cost formulas, and enchantment-registry tag memberships.
 */
export function enrichEnchantments(
  enchantments: EnchantmentDefinition[],
  tags: TagDefinition[],
  translations: TranslationEntry[],
): EnchantmentDefinition[] {
  const resolver = new TagResolver(tags);
  const names = new Map(translations.map((entry) => [entry.key, entry.value]));

  const memberships = new Map<string, string[]>();
  for (const tag of tags) {
    if (tag.registry !== "enchantment") {
      continue;
    }

    for (const enchantId of resolver.resolveEntries("enchantment", tag.values)) {
      const list = memberships.get(enchantId) ?? [];
      list.push(tag.id);
      memberships.set(enchantId, list);
    }
  }

  return enchantments.map((enchantment) => {
    const raw = enchantment.raw;
    const rawObject = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const supported = entryList(rawObject.supported_items);
    const primary = entryList(rawObject.primary_items);
    const exclusive = entryList(rawObject.exclusive_set);

    return {
      ...enchantment,
      displayName: enchantment.descriptionKey ? names.get(enchantment.descriptionKey) : undefined,
      supportedItemIds: supported.length > 0 ? resolver.resolveEntries("item", supported) : undefined,
      primaryItemIds: primary.length > 0 ? resolver.resolveEntries("item", primary) : undefined,
      exclusiveSetIds:
        exclusive.length > 0
          ? resolver.resolveEntries("enchantment", exclusive).filter((id) => id !== enchantment.id)
          : undefined,
      minCost: costFormula(rawObject.min_cost),
      maxCost: costFormula(rawObject.max_cost),
      tags: memberships.get(enchantment.id)?.sort(),
    };
  });
}
