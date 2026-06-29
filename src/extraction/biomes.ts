import type { ArchiveSource } from "../archive/archiveSource.js";
import type {
  BiomeDefinition,
  BiomeEffectColors,
  BiomeYRange,
  JsonValue,
  TagDefinition,
  TranslationEntry,
} from "../domain/types.js";

const BIOME_PREFIX = "data/minecraft/worldgen/biome/";
const BIOME_TAG_ID_PREFIX = "minecraft:biome/";
const DIMENSION_TYPE_PATHS = new Map<BiomeDefinition["dimension"], string>([
  ["overworld", "data/minecraft/dimension_type/overworld.json"],
  ["nether", "data/minecraft/dimension_type/the_nether.json"],
  ["end", "data/minecraft/dimension_type/the_end.json"],
]);

/**
 * Build the biome dataset from the vanilla data pack: one entry per
 * `data/minecraft/worldgen/biome/<key>.json`, enriched with the localized name
 * from `en_us`, the `worldgen/biome` tags the biome belongs to, and derived
 * dimension, category, and placement metadata for map/search consumers.
 */
export async function buildBiomes(
  paths: string[],
  source: ArchiveSource,
  tags: TagDefinition[],
  translations: TranslationEntry[],
): Promise<BiomeDefinition[]> {
  const biomePaths = paths.filter((path) => path.startsWith(BIOME_PREFIX) && path.endsWith(".json")).sort();
  const names = new Map(translations.map((entry) => [entry.key, entry.value] as const));
  const tagsByBiome = indexBiomeTags(tags);
  const dimensionYRanges = await readDimensionYRanges(paths, source);

  const biomes: BiomeDefinition[] = [];
  for (const path of biomePaths) {
    const raw = await source.readJson<JsonValue>(path);
    if (Array.isArray(raw) || !raw || typeof raw !== "object") {
      continue;
    }

    const key = path.slice(BIOME_PREFIX.length, path.length - ".json".length);
    const id = `minecraft:${key}`;
    const biomeTags = tagsByBiome.get(id) ?? [];
    const dimension = deriveDimension(key, biomeTags);
    const placement = derivePlacement(key, dimension);
    const vertical = placement === "underground";
    const yRange = vertical ? dimensionYRanges.get(dimension) : undefined;
    const surfaceMap = placement === "surface" && dimension === "overworld";

    biomes.push({
      id,
      key,
      name: names.get(`biome.minecraft.${key}`) ?? humanizeKey(key),
      dimension,
      category: deriveCategory(key, biomeTags, placement),
      placement,
      requiresY: vertical,
      vertical,
      ...(yRange ? { yRange } : {}),
      surfaceClimate: surfaceMap,
      surfaceMap,
      searchable: placement !== "special",
      temperature: typeof raw.temperature === "number" ? raw.temperature : 0,
      downfall: typeof raw.downfall === "number" ? raw.downfall : undefined,
      hasPrecipitation: raw.has_precipitation === true,
      effects: readEffects(raw),
      tags: biomeTags,
      sourcePath: path,
      raw,
    });
  }

  return biomes.sort((left, right) => left.key.localeCompare(right.key));
}

async function readDimensionYRanges(
  paths: string[],
  source: ArchiveSource,
): Promise<Map<BiomeDefinition["dimension"], BiomeYRange>> {
  const ranges = new Map<BiomeDefinition["dimension"], BiomeYRange>();

  for (const [dimension, path] of DIMENSION_TYPE_PATHS) {
    if (!paths.includes(path)) {
      continue;
    }

    try {
      const raw = await source.readJson<JsonValue>(path);
      if (!isRecord(raw) || typeof raw.min_y !== "number" || typeof raw.height !== "number") {
        continue;
      }
      ranges.set(dimension, {
        min: raw.min_y,
        max: raw.min_y + raw.height - 1,
        sourcePath: path,
      });
    } catch {
      // Dimension bounds are enrichment only; malformed or missing files should not block biome extraction.
    }
  }

  return ranges;
}

/** Invert the `worldgen/biome` tags into a biome-id -> short-tag-name map. */
function indexBiomeTags(tags: TagDefinition[]): Map<string, string[]> {
  const byBiome = new Map<string, string[]>();
  for (const tag of tags) {
    if (tag.registry !== "worldgen" || !tag.id.startsWith(BIOME_TAG_ID_PREFIX)) {
      continue;
    }
    const shortName = tag.id.slice(BIOME_TAG_ID_PREFIX.length);
    for (const value of tag.values) {
      const list = byBiome.get(value) ?? [];
      list.push(shortName);
      byBiome.set(value, list);
    }
  }
  for (const list of byBiome.values()) {
    list.sort();
  }
  return byBiome;
}

function readEffects(raw: Record<string, JsonValue>): BiomeEffectColors {
  const effects = isRecord(raw.effects) ? raw.effects : {};
  const attributes = isRecord(raw.attributes) ? raw.attributes : {};
  const fromEffects = (effectKey: string, visualKey: string): string | undefined =>
    asHexColor(effects[effectKey]) ?? asHexColor(attributes[`minecraft:visual/${visualKey}`]);

  const colors: BiomeEffectColors = {
    waterColor: fromEffects("water_color", "water_color"),
    waterFogColor: fromEffects("water_fog_color", "water_fog_color"),
    fogColor: fromEffects("fog_color", "fog_color"),
    skyColor: fromEffects("sky_color", "sky_color"),
    grassColor: fromEffects("grass_color", "grass_color"),
    foliageColor: fromEffects("foliage_color", "foliage_color"),
  };
  // Drop undefined keys so the JSON stays compact.
  for (const colorKey of Object.keys(colors) as (keyof BiomeEffectColors)[]) {
    if (colors[colorKey] === undefined) {
      delete colors[colorKey];
    }
  }
  return colors;
}

const NETHER_KEYS = new Set(["nether_wastes", "crimson_forest", "warped_forest", "soul_sand_valley", "basalt_deltas"]);
const END_KEYS = new Set(["the_end", "end_highlands", "end_midlands", "end_barrens", "small_end_islands", "the_void"]);
const UNDERGROUND_OVERWORLD_KEYS = new Set(["deep_dark", "dripstone_caves", "lush_caves", "sulfur_caves"]);
const SPECIAL_KEYS = new Set(["the_void"]);

function deriveDimension(key: string, tags: string[]): BiomeDefinition["dimension"] {
  if (tags.includes("is_nether") || NETHER_KEYS.has(key)) {
    return "nether";
  }
  if (tags.includes("is_end") || END_KEYS.has(key)) {
    return "end";
  }
  if (tags.includes("is_overworld")) {
    return "overworld";
  }
  return "unknown";
}

function derivePlacement(key: string, dimension: BiomeDefinition["dimension"]): BiomeDefinition["placement"] {
  if (SPECIAL_KEYS.has(key)) {
    return "special";
  }
  if (dimension === "nether") {
    return "nether";
  }
  if (dimension === "end") {
    return "end";
  }
  if (dimension === "overworld" && UNDERGROUND_OVERWORLD_KEYS.has(key)) {
    return "underground";
  }
  return "surface";
}

/** Coarse grouping for legends/filters: tag-first, then key heuristics. */
function deriveCategory(key: string, tags: string[], placement: BiomeDefinition["placement"]): string {
  if (placement === "special") {
    return "special";
  }
  if (placement === "underground") {
    return "cave";
  }
  if (placement === "nether") {
    return "nether";
  }
  if (placement === "end") {
    return "end";
  }
  if (tags.includes("is_ocean") || key.includes("ocean")) {
    return "ocean";
  }
  if (tags.includes("is_river") || key.includes("river")) {
    return "river";
  }
  if (tags.includes("is_beach") || key.endsWith("beach") || key === "stony_shore") {
    return "beach";
  }
  if (key.includes("swamp")) {
    return "swamp";
  }
  if (tags.includes("is_badlands") || key.includes("badlands")) {
    return "badlands";
  }
  if (tags.includes("is_jungle") || key.includes("jungle")) {
    return "jungle";
  }
  if (tags.includes("is_taiga") || key.includes("taiga")) {
    return "taiga";
  }
  if (tags.includes("is_savanna") || key.includes("savanna")) {
    return "savanna";
  }
  if (key === "desert") {
    return "desert";
  }
  if (tags.includes("is_mountain") || /peaks|slopes|grove|meadow|windswept/.test(key)) {
    return "mountain";
  }
  if (tags.includes("is_forest") || key.includes("forest") || key === "pale_garden") {
    return "forest";
  }
  if (key.includes("snowy") || key.includes("frozen") || key.includes("ice")) {
    return "snowy";
  }
  if (key === "mushroom_fields") {
    return "mushroom";
  }
  if (key.includes("plains") || key === "cherry_grove") {
    return "plains";
  }
  return "other";
}

function asHexColor(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : undefined;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function humanizeKey(key: string): string {
  return key
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
