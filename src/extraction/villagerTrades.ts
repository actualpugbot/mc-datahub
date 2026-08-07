import type { ArchiveSource } from "../archive/archiveSource.js";
import type {
  JsonValue,
  TranslationEntry,
  VillagerTradeDataset,
  VillagerTradeDefinition,
  VillagerTradeItem,
  VillagerTradePool,
} from "../domain/types.js";

const TRADE_PREFIX = "data/minecraft/villager_trade/";
const TRADE_SET_PREFIX = "data/minecraft/trade_set/";
const TRADE_TAG_PREFIX = "data/minecraft/tags/villager_trade/";

type JsonRecord = { [key: string]: JsonValue };

/**
 * Reads the data-driven villager-trade registries introduced in Java 26.2.
 *
 * A useful guide needs all three registries together: villager_trade contains the offer,
 * villager_trade tags form its candidate pool (and may include other tags), and trade_set says
 * how many candidates are selected. Joining them here keeps consumers from guessing selection
 * odds or overlooking shared smith trades.
 */
export async function buildVillagerTrades(
  paths: string[],
  source: ArchiveSource,
  translations: TranslationEntry[],
): Promise<VillagerTradeDataset | undefined> {
  const tradePaths = paths.filter((path) => path.startsWith(TRADE_PREFIX) && path.endsWith(".json")).sort();
  const tradeSetPaths = paths.filter((path) => path.startsWith(TRADE_SET_PREFIX) && path.endsWith(".json")).sort();
  if (tradePaths.length === 0 || tradeSetPaths.length === 0) {
    return undefined;
  }

  const warnings: string[] = [];
  const translationMap = new Map(translations.map((entry) => [entry.key, entry.value] as const));
  const trades: VillagerTradeDefinition[] = [];
  const tradeById = new Map<string, VillagerTradeDefinition>();

  for (const path of tradePaths) {
    const raw = await source.readJson<JsonValue>(path);
    if (!isRecord(raw) || !isRecord(raw.wants) || !isRecord(raw.gives)) {
      warnings.push(`Skipped malformed villager trade ${path}.`);
      continue;
    }
    const id = idFromPath(TRADE_PREFIX, path);
    const wants = readTradeItem(raw.wants, translationMap);
    const gives = readTradeItem(raw.gives, translationMap, customOutputName(raw, translationMap));
    if (!wants || !gives) {
      warnings.push(`Skipped villager trade ${id}; wants or gives did not name an item.`);
      continue;
    }

    // Releases: `given_item_modifiers` entries keyed by `function`; 26.3 snapshots renamed the
    // list to singular `given_item_modifier` with entries keyed by `type`.
    const rawModifiers = Array.isArray(raw.given_item_modifiers)
      ? raw.given_item_modifiers
      : Array.isArray(raw.given_item_modifier)
        ? raw.given_item_modifier
        : [];
    const modifierFunctions = unique(
      rawModifiers
        .filter(isRecord)
        .map((modifier) => modifier.function ?? modifier.type)
        .filter((value): value is string => typeof value === "string")
        .map(localId),
    );
    const definition: VillagerTradeDefinition = {
      id,
      wants,
      gives,
      maxUses: positiveInteger(raw.max_uses, 4),
      villagerXp: nonNegativeInteger(raw.xp, 1),
      reputationDiscount: nonNegativeNumber(raw.reputation_discount, 0),
      modifierFunctions,
      dynamicPrice:
        modifierFunctions.some((modifier) => modifier === "enchant_randomly" || modifier === "enchant_with_levels") &&
        wants.count === 0,
      sourcePath: path,
      raw,
    };
    if (isRecord(raw.additional_wants)) {
      definition.additionalWants = readTradeItem(raw.additional_wants, translationMap);
    }
    if (typeof raw.double_trade_price_enchantments === "string") {
      definition.doubleTradePriceEnchantments = raw.double_trade_price_enchantments;
    }
    trades.push(definition);
    tradeById.set(id, definition);
  }

  const tagValues = await readTradeTags(paths, source, warnings);
  const pools: VillagerTradePool[] = [];
  for (const path of tradeSetPaths) {
    const raw = await source.readJson<JsonValue>(path);
    if (!isRecord(raw) || typeof raw.trades !== "string") {
      warnings.push(`Skipped malformed trade set ${path}.`);
      continue;
    }
    const id = idFromPath(TRADE_SET_PREFIX, path);
    const tradeIds = raw.trades.startsWith("#")
      ? resolveTradeTag(normalizeId(raw.trades.slice(1)), tagValues, warnings)
      : [normalizeId(raw.trades)];
    const existingTradeIds = unique(tradeIds.filter((tradeId) => tradeById.has(tradeId)));
    for (const missing of tradeIds.filter((tradeId) => !tradeById.has(tradeId))) {
      warnings.push(`Trade set ${id} references missing trade ${missing}.`);
    }
    const amount = positiveInteger(raw.amount, 1);
    const allowDuplicates = raw.allow_duplicates === true;
    const { profession, level, category } = poolIdentity(id);
    pools.push({
      id,
      profession,
      level,
      category,
      amount,
      allowDuplicates,
      tradeIds: existingTradeIds,
      selectionChance:
        existingTradeIds.length === 0
          ? 0
          : allowDuplicates
            ? 1 - (1 - 1 / existingTradeIds.length) ** amount
            : Math.min(1, amount / existingTradeIds.length),
      sourcePath: path,
      raw,
    });
  }

  return {
    edition: "java",
    trades: trades.sort((left, right) => left.id.localeCompare(right.id)),
    pools: pools.sort(comparePools),
    warnings: unique(warnings),
  };
}

async function readTradeTags(paths: string[], source: ArchiveSource, warnings: string[]): Promise<Map<string, string[]>> {
  const tags = new Map<string, string[]>();
  for (const path of paths.filter((entry) => entry.startsWith(TRADE_TAG_PREFIX) && entry.endsWith(".json")).sort()) {
    const raw = await source.readJson<JsonValue>(path);
    if (!isRecord(raw) || !Array.isArray(raw.values)) {
      warnings.push(`Skipped malformed villager trade tag ${path}.`);
      continue;
    }
    const values = raw.values
      .map((value) =>
        typeof value === "string" ? value : isRecord(value) && typeof value.id === "string" ? value.id : undefined,
      )
      .filter((value): value is string => value !== undefined)
      .map((value) => (value.startsWith("#") ? `#${normalizeId(value.slice(1))}` : normalizeId(value)));
    tags.set(idFromPath(TRADE_TAG_PREFIX, path), values);
  }
  return tags;
}

function resolveTradeTag(tagId: string, tags: Map<string, string[]>, warnings: string[], visiting = new Set<string>()): string[] {
  if (visiting.has(tagId)) {
    warnings.push(`Villager trade tag cycle detected at ${tagId}.`);
    return [];
  }
  const values = tags.get(tagId);
  if (!values) {
    warnings.push(`Missing villager trade tag ${tagId}.`);
    return [];
  }
  const nextVisiting = new Set(visiting).add(tagId);
  return unique(
    values.flatMap((value) => (value.startsWith("#") ? resolveTradeTag(value.slice(1), tags, warnings, nextVisiting) : [value])),
  );
}

function readTradeItem(raw: JsonRecord, translations: Map<string, string>, customName?: string): VillagerTradeItem | undefined {
  if (typeof raw.id !== "string") {
    return undefined;
  }
  const id = normalizeId(raw.id);
  const item: VillagerTradeItem = {
    id,
    name: customName ?? itemName(id, translations),
    count: nonNegativeInteger(raw.count, 1),
  };
  if (isRecord(raw.components)) {
    item.components = raw.components;
  }
  return item;
}

function customOutputName(raw: JsonRecord, translations: Map<string, string>): string | undefined {
  const modifiers = Array.isArray(raw.given_item_modifiers)
    ? raw.given_item_modifiers
    : Array.isArray(raw.given_item_modifier)
      ? raw.given_item_modifier
      : undefined;
  if (!modifiers) {
    return undefined;
  }
  for (const modifier of modifiers) {
    if (!isRecord(modifier)) {
      continue;
    }
    const kind = modifier.function ?? modifier.type;
    if (localId(typeof kind === "string" ? kind : "") !== "set_name") {
      continue;
    }
    if (isRecord(modifier.name) && typeof modifier.name.translate === "string") {
      return translations.get(modifier.name.translate) ?? titleCase(localId(modifier.name.translate));
    }
  }
  return undefined;
}

function itemName(id: string, translations: Map<string, string>): string {
  const local = localId(id);
  return translations.get(`item.minecraft.${local}`) ?? translations.get(`block.minecraft.${local}`) ?? titleCase(local);
}

function poolIdentity(id: string): { profession: string; level?: number; category?: string } {
  const parts = localId(id).split("/");
  const profession = parts[0] ?? "unknown";
  const levelMatch = (parts[1] ?? "").match(/^level_(\d+)$/);
  return {
    profession,
    level: levelMatch ? Number(levelMatch[1]) : undefined,
    category: levelMatch ? undefined : parts[1],
  };
}

function comparePools(left: VillagerTradePool, right: VillagerTradePool): number {
  return (
    left.profession.localeCompare(right.profession) ||
    (left.level ?? Number.MAX_SAFE_INTEGER) - (right.level ?? Number.MAX_SAFE_INTEGER) ||
    (left.category ?? "").localeCompare(right.category ?? "")
  );
}

function idFromPath(prefix: string, path: string): string {
  return `minecraft:${path.slice(prefix.length, -".json".length)}`;
}

function normalizeId(value: string): string {
  return value.includes(":") ? value : `minecraft:${value}`;
}

function localId(value: string): string {
  const colon = value.indexOf(":");
  return colon === -1 ? value : value.slice(colon + 1);
}

function titleCase(value: string): string {
  return value
    .split(/[._/]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function positiveInteger(value: JsonValue | undefined, fallback: number): number {
  return Math.max(1, Math.floor(typeof value === "number" ? value : fallback));
}

function nonNegativeInteger(value: JsonValue | undefined, fallback: number): number {
  return Math.max(0, Math.floor(typeof value === "number" ? value : fallback));
}

function nonNegativeNumber(value: JsonValue | undefined, fallback: number): number {
  return Math.max(0, typeof value === "number" ? value : fallback);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isRecord(value: JsonValue | undefined): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
