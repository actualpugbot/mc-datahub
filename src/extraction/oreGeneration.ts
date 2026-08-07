import type { ArchiveSource } from "../archive/archiveSource.js";
import type {
  BiomeDefinition,
  JsonValue,
  OreDistributionContext,
  OreDistributionDefinition,
  OreGenerationDataset,
  OreGenerationDimension,
  OreGenerationFeature,
  OreHeightCurvePoint,
} from "../domain/types.js";

/** 26.3 snapshots renamed worldgen/configured_feature to worldgen/feature; support both layouts. */
const CONFIGURED_FEATURE_PREFIXES = [
  "data/minecraft/worldgen/feature/",
  "data/minecraft/worldgen/configured_feature/",
];
const PLACED_FEATURE_PREFIX = "data/minecraft/worldgen/placed_feature/";
const NOISE_SETTINGS = new Map<OreGenerationDimension["id"], string>([
  ["overworld", "data/minecraft/worldgen/noise_settings/overworld.json"],
  ["nether", "data/minecraft/worldgen/noise_settings/nether.json"],
  ["end", "data/minecraft/worldgen/noise_settings/end.json"],
]);

interface HeightDistribution {
  type: "uniform" | "trapezoid";
  minInclusive: number;
  maxInclusive: number;
  plateau: number;
  probabilities: Map<number, number>;
}

/**
 * Joins vanilla configured ore features, placed-feature height providers, noise-setting bounds,
 * and biome feature lists into exact per-Y placement-attempt curves. The output deliberately does
 * not call those values "ore blocks": target terrain, vein geometry and air exposure are later
 * generation steps and cannot be reduced to a seed-independent exact block count.
 */
export async function buildOreGeneration(
  paths: string[],
  source: ArchiveSource,
  biomes: BiomeDefinition[],
): Promise<OreGenerationDataset> {
  const warnings: string[] = [];
  const dimensions = await readDimensions(paths, source);
  const dimensionById = new Map(dimensions.map((dimension) => [dimension.id, dimension] as const));
  const biomeFeatureUsage = indexBiomeFeatureUsage(biomes);
  const features: OreGenerationFeature[] = [];

  const placedPaths = paths.filter((path) => path.startsWith(PLACED_FEATURE_PREFIX) && path.endsWith(".json")).sort();

  for (const placedPath of placedPaths) {
    const placedRaw = await source.readJson<JsonValue>(placedPath);
    if (!isRecord(placedRaw) || typeof placedRaw.feature !== "string" || !Array.isArray(placedRaw.placement)) {
      continue;
    }

    const configuredFeatureId = normalizeId(placedRaw.feature);
    const configuredPath = configuredFeaturePath(configuredFeatureId, paths);
    if (!configuredPath) {
      continue;
    }

    const configuredRaw = await source.readJson<JsonValue>(configuredPath);
    if (!isRecord(configuredRaw) || typeof configuredRaw.type !== "string") {
      continue;
    }
    // Releases nest the payload under `config`; 26.3 snapshots inline it beside `type`.
    const configured = isRecord(configuredRaw.config) ? configuredRaw.config : configuredRaw;
    const generationType = localId(configuredRaw.type);
    if (generationType !== "ore" && generationType !== "scattered_ore") {
      continue;
    }

    const oreBlockIds = readOreBlockIds(configured.targets);
    const resourceKey = resourceKeyFromBlocks(oreBlockIds);
    if (!resourceKey) {
      // Vanilla also names dirt, gravel, tuff and similar underground blobs "ore" features. They
      // are useful worldgen internals, but they do not belong in a player-facing ore-level tool.
      continue;
    }

    const id = idFromPath(PLACED_FEATURE_PREFIX, placedPath);
    const biomeIds = [...(biomeFeatureUsage.get(id) ?? [])].sort();
    const inferredDimensions = unique(
      biomeIds
        .map((biomeId) => biomes.find((biome) => biome.id === biomeId)?.dimension)
        .filter((dimension): dimension is OreGenerationDimension["id"] => dimension !== undefined),
    );
    if (inferredDimensions.length !== 1) {
      warnings.push(
        `${id} was referenced by ${biomeIds.length} biomes across ${inferredDimensions.length} resolved dimensions; its height curve was not emitted.`,
      );
      continue;
    }

    const dimensionId = inferredDimensions[0]!;
    const dimension = dimensionById.get(dimensionId);
    if (!dimension) {
      warnings.push(`${id} uses ${dimensionId}, but no noise-settings bounds were available.`);
      continue;
    }

    const heightModifier = placedRaw.placement.find(
      (modifier) => isRecord(modifier) && localId(modifier.type) === "height_range" && isRecord(modifier.height),
    );
    if (!isRecord(heightModifier) || !isRecord(heightModifier.height)) {
      warnings.push(`${id} has no supported height_range placement modifier.`);
      continue;
    }

    const height = buildHeightDistribution(heightModifier.height, dimension);
    if (!height) {
      warnings.push(`${id} uses an unsupported height provider.`);
      continue;
    }

    const configuredAttemptsPerChunk = readExpectedAttempts(placedRaw.placement);
    if (configuredAttemptsPerChunk === undefined) {
      warnings.push(`${id} uses an unsupported count or rarity placement modifier.`);
      continue;
    }

    const curve = [...height.probabilities]
      .filter(([y]) => y >= dimension.minY && y <= dimension.maxY)
      .map(([y, probability]) => ({
        y,
        probability: round12(probability),
        expectedPlacementsPerChunk: round12(probability * configuredAttemptsPerChunk),
      }));
    const inBoundsExpectedPlacementsPerChunk = round12(curve.reduce((sum, point) => sum + point.expectedPlacementsPerChunk, 0));

    features.push({
      id,
      configuredFeatureId,
      resourceId: `minecraft:${resourceKey}`,
      dimension: dimensionId,
      biomeIds,
      oreBlockIds,
      replaceableTags: readReplaceableTags(configured.targets),
      generationType,
      veinSize: numberValue(configured.size) ?? 0,
      discardChanceOnAirExposure: numberValue(configured.discard_chance_on_air_exposure) ?? 0,
      configuredAttemptsPerChunk: round12(configuredAttemptsPerChunk),
      inBoundsExpectedPlacementsPerChunk,
      height: {
        type: height.type,
        minInclusive: height.minInclusive,
        maxInclusive: height.maxInclusive,
        plateau: height.plateau,
      },
      curve,
      configuredFeatureSourcePath: configuredPath,
      placedFeatureSourcePath: placedPath,
    });
  }

  features.sort((left, right) => left.id.localeCompare(right.id));
  const ores = buildOreDefinitions(features, biomes, dimensions);
  return {
    metric: "configured_feature_placement_attempts",
    dimensions,
    features,
    ores,
    warnings: unique(warnings).sort(),
  };
}

async function readDimensions(paths: string[], source: ArchiveSource): Promise<OreGenerationDimension[]> {
  const dimensions: OreGenerationDimension[] = [];
  for (const [id, path] of NOISE_SETTINGS) {
    if (!paths.includes(path)) {
      continue;
    }
    const raw = await source.readJson<JsonValue>(path);
    if (!isRecord(raw) || !isRecord(raw.noise)) {
      continue;
    }
    const minY = numberValue(raw.noise.min_y);
    const height = numberValue(raw.noise.height);
    if (minY === undefined || height === undefined) {
      continue;
    }
    const bedrockFloorFreeAtOrAbove = findBedrockFloorFreeY(raw.surface_rule, { minY, maxY: minY + height - 1 });
    dimensions.push({
      id,
      minY,
      maxY: minY + height - 1,
      ...(bedrockFloorFreeAtOrAbove !== undefined ? { bedrockFloorFreeAtOrAbove } : {}),
      sourcePath: path,
    });
  }
  return dimensions.sort((left, right) => left.id.localeCompare(right.id));
}

function findBedrockFloorFreeY(value: JsonValue | undefined, bounds: { minY: number; maxY: number }): number | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findBedrockFloorFreeY(entry, bounds);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    localId(value.type) === "vertical_gradient" &&
    value.random_name === "minecraft:bedrock_floor" &&
    value.false_at_and_above !== undefined
  ) {
    return resolveAnchor(value.false_at_and_above, bounds);
  }
  for (const child of Object.values(value)) {
    const found = findBedrockFloorFreeY(child, bounds);
    if (found !== undefined) return found;
  }
  return undefined;
}

function indexBiomeFeatureUsage(biomes: BiomeDefinition[]): Map<string, Set<string>> {
  const usage = new Map<string, Set<string>>();
  for (const biome of biomes) {
    const featureIds = new Set<string>();
    if (isRecord(biome.raw)) collectIds(biome.raw.features, featureIds);
    for (const featureId of featureIds) {
      const biomesForFeature = usage.get(featureId) ?? new Set<string>();
      biomesForFeature.add(biome.id);
      usage.set(featureId, biomesForFeature);
    }
  }
  return usage;
}

function collectIds(value: JsonValue | undefined, ids: Set<string>): void {
  if (typeof value === "string") {
    ids.add(normalizeId(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectIds(child, ids);
  }
}

function buildHeightDistribution(
  raw: Record<string, JsonValue>,
  dimension: OreGenerationDimension,
): HeightDistribution | undefined {
  const type = localId(raw.type);
  if ((type !== "uniform" && type !== "trapezoid") || raw.min_inclusive === undefined || raw.max_inclusive === undefined) {
    return undefined;
  }
  const minInclusive = resolveAnchor(raw.min_inclusive, dimension);
  const maxInclusive = resolveAnchor(raw.max_inclusive, dimension);
  if (minInclusive === undefined || maxInclusive === undefined || minInclusive > maxInclusive) {
    return undefined;
  }
  const plateau = type === "trapezoid" ? Math.max(0, numberValue(raw.plateau) ?? 0) : maxInclusive - minInclusive;
  const probabilities = new Map<number, number>();

  if (type === "uniform" || plateau >= maxInclusive - minInclusive) {
    const probability = 1 / (maxInclusive - minInclusive + 1);
    for (let y = minInclusive; y <= maxInclusive; y += 1) probabilities.set(y, probability);
  } else {
    // Exact convolution used by TrapezoidHeight.sample(): min + U(0..end) + U(0..start).
    const range = maxInclusive - minInclusive;
    const plateauStart = Math.floor((range - plateau) / 2);
    const plateauEnd = range - plateauStart;
    const denominator = (plateauStart + 1) * (plateauEnd + 1);
    for (let left = 0; left <= plateauEnd; left += 1) {
      for (let right = 0; right <= plateauStart; right += 1) {
        const y = minInclusive + left + right;
        probabilities.set(y, (probabilities.get(y) ?? 0) + 1 / denominator);
      }
    }
  }

  return { type, minInclusive, maxInclusive, plateau, probabilities };
}

function resolveAnchor(value: JsonValue, dimension: { minY: number; maxY: number }): number | undefined {
  if (!isRecord(value)) return undefined;
  const absolute = numberValue(value.absolute);
  if (absolute !== undefined) return absolute;
  const aboveBottom = numberValue(value.above_bottom);
  if (aboveBottom !== undefined) return dimension.minY + aboveBottom;
  const belowTop = numberValue(value.below_top);
  if (belowTop !== undefined) return dimension.maxY - belowTop;
  return undefined;
}

function readExpectedAttempts(placements: JsonValue[]): number | undefined {
  const count = placements.find((entry) => isRecord(entry) && localId(entry.type) === "count");
  if (isRecord(count)) {
    return expectedIntProvider(count.count);
  }
  const rarity = placements.find((entry) => isRecord(entry) && localId(entry.type) === "rarity_filter");
  if (isRecord(rarity)) {
    const chance = numberValue(rarity.chance);
    return chance && chance > 0 ? 1 / chance : undefined;
  }
  return 1;
}

function expectedIntProvider(value: JsonValue | undefined): number | undefined {
  const direct = numberValue(value);
  if (direct !== undefined) return direct;
  if (!isRecord(value) || localId(value.type) !== "uniform") return undefined;
  const min = numberValue(value.min_inclusive);
  const max = numberValue(value.max_inclusive);
  return min !== undefined && max !== undefined ? (min + max) / 2 : undefined;
}

function buildOreDefinitions(
  features: OreGenerationFeature[],
  biomes: BiomeDefinition[],
  dimensions: OreGenerationDimension[],
): OreDistributionDefinition[] {
  const byResource = groupBy(features, (feature) => feature.resourceId);
  const dimensionById = new Map(dimensions.map((dimension) => [dimension.id, dimension] as const));
  const biomeById = new Map(biomes.map((biome) => [biome.id, biome] as const));
  const ores: OreDistributionDefinition[] = [];

  for (const [resourceId, resourceFeatures] of byResource) {
    const contexts: OreDistributionContext[] = [];
    const byDimension = groupBy(resourceFeatures, (feature) => feature.dimension);
    for (const [dimensionId, dimensionFeatures] of byDimension) {
      const dimension = dimensionById.get(dimensionId);
      if (!dimension) continue;
      const dimensionBiomes = biomes.filter((biome) => biome.dimension === dimensionId);
      const signatureBiomes = new Map<string, string[]>();
      for (const biome of dimensionBiomes) {
        const signature = dimensionFeatures
          .filter((feature) => feature.biomeIds.includes(biome.id))
          .map((feature) => feature.id)
          .sort()
          .join("|");
        if (!signature) continue;
        const grouped = signatureBiomes.get(signature) ?? [];
        grouped.push(biome.id);
        signatureBiomes.set(signature, grouped);
      }

      const groups = [...signatureBiomes.entries()].sort((left, right) => {
        if (left[1].length !== right[1].length) return right[1].length - left[1].length;
        return left[0].localeCompare(right[0]);
      });
      const usedIds = new Set<string>();
      for (let index = 0; index < groups.length; index += 1) {
        const [signature, biomeIds] = groups[index]!;
        const featureIds = signature.split("|");
        const contextFeatures = dimensionFeatures.filter((feature) => featureIds.includes(feature.id));
        const curve = aggregateCurves(contextFeatures);
        if (curve.length === 0) continue;
        const best = bestRange(curve);
        const recommendedCurve = curve.filter((point) => point.y >= (dimension.bedrockFloorFreeAtOrAbove ?? dimension.minY));
        const recommended = bestRange(recommendedCurve.length > 0 ? recommendedCurve : curve);
        const label = contextLabel(biomeIds, dimensionBiomes, biomeById, dimensionId, index === 0);
        let contextKey = slugify(label.replace(/\bbiomes?\b/gi, "")) || "default";
        if (index === 0 && biomeIds.length === dimensionBiomes.length) contextKey = "default";
        let id = `${dimensionId}/${contextKey}`;
        let suffix = 2;
        while (usedIds.has(id)) id = `${dimensionId}/${contextKey}-${suffix++}`;
        usedIds.add(id);
        contexts.push({
          id,
          label,
          dimension: dimensionId,
          biomeIds: [...biomeIds].sort(),
          featureIds,
          oreBlockIds: unique(contextFeatures.flatMap((feature) => feature.oreBlockIds)).sort(),
          configuredAttemptsPerChunk: round12(
            contextFeatures.reduce((sum, feature) => sum + feature.configuredAttemptsPerChunk, 0),
          ),
          inBoundsExpectedPlacementsPerChunk: round12(
            contextFeatures.reduce((sum, feature) => sum + feature.inBoundsExpectedPlacementsPerChunk, 0),
          ),
          bestY: best.preferred,
          bestYRange: { min: best.min, max: best.max },
          recommendedY: recommended.preferred,
          recommendedYRange: { min: recommended.min, max: recommended.max },
          curve,
        });
      }
    }

    const key = localId(resourceId);
    ores.push({
      id: resourceId,
      key,
      name: resourceName(key),
      oreBlockIds: unique(resourceFeatures.flatMap((feature) => feature.oreBlockIds)).sort(),
      contexts: contexts.sort((left, right) => left.id.localeCompare(right.id)),
    });
  }

  return ores.sort((left, right) => left.name.localeCompare(right.name));
}

function aggregateCurves(features: OreGenerationFeature[]): OreHeightCurvePoint[] {
  const expectedByY = new Map<number, number>();
  for (const feature of features) {
    for (const point of feature.curve) {
      expectedByY.set(point.y, (expectedByY.get(point.y) ?? 0) + point.expectedPlacementsPerChunk);
    }
  }
  return [...expectedByY]
    .sort(([left], [right]) => left - right)
    .map(([y, expectedPlacementsPerChunk]) => ({
      y,
      expectedPlacementsPerChunk: round12(expectedPlacementsPerChunk),
    }));
}

function bestRange(curve: OreHeightCurvePoint[]): { min: number; max: number; preferred: number } {
  const maximum = Math.max(...curve.map((point) => point.expectedPlacementsPerChunk));
  const bestYs = curve.filter((point) => Math.abs(point.expectedPlacementsPerChunk - maximum) < 1e-11).map((point) => point.y);
  return { min: Math.min(...bestYs), max: Math.max(...bestYs), preferred: Math.max(...bestYs) };
}

function contextLabel(
  biomeIds: string[],
  dimensionBiomes: BiomeDefinition[],
  biomeById: Map<string, BiomeDefinition>,
  dimension: OreGenerationDimension["id"],
  largest: boolean,
): string {
  if (biomeIds.length === dimensionBiomes.length) return `All ${humanize(dimension)} Biomes`;
  if (biomeIds.length === 1) return biomeById.get(biomeIds[0]!)?.name ?? humanize(localId(biomeIds[0]!));
  const categories = unique(biomeIds.map((id) => biomeById.get(id)?.category).filter((value): value is string => !!value));
  if (categories.length === 1 && categories[0] !== "other") return `${humanize(categories[0]!)} Biomes`;
  return largest ? `Common ${humanize(dimension)} Biomes` : `${biomeIds.length} ${humanize(dimension)} Biomes`;
}

function readOreBlockIds(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return unique(
    value
      .map((target) => {
        if (!isRecord(target)) return undefined;
        // Releases use { state: { Name: "minecraft:iron_ore" } }; 26.3 snapshots flatten the
        // blockstate literal to a bare id string (with optional [properties]).
        if (typeof target.state === "string") {
          const state = target.state;
          return state.includes("[") ? state.slice(0, state.indexOf("[")) : state;
        }
        return isRecord(target.state) && typeof target.state.Name === "string" ? target.state.Name : undefined;
      })
      .filter((id): id is string => typeof id === "string")
      .map(normalizeId),
  ).sort();
}

function readReplaceableTags(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  // Releases put a single { predicate_type: tag_match, tag } on target; 26.3 snapshots nest
  // tag_match leaves under any_of/all_of rule trees, so collect every `tag` string depth-first.
  const collect = (node: JsonValue | undefined): void => {
    if (Array.isArray(node)) {
      for (const entry of node) collect(entry);
      return;
    }
    if (!isRecord(node)) return;
    if (typeof node.tag === "string") tags.push(node.tag);
    for (const entry of Object.values(node)) collect(entry as JsonValue);
  };
  for (const target of value) {
    if (isRecord(target)) collect(target.target as JsonValue);
  }
  return unique(tags.map(normalizeId)).sort();
}

function resourceKeyFromBlocks(blockIds: string[]): string | undefined {
  const keys = unique(
    blockIds
      .map(localId)
      .map((id) => id.replace(/^deepslate_/, ""))
      .map((id) => {
        if (id === "ancient_debris") return "ancient_debris";
        if (id === "nether_quartz_ore") return "quartz";
        if (id === "nether_gold_ore") return "gold";
        if (id === "lapis_ore") return "lapis_lazuli";
        return id.endsWith("_ore") ? id.slice(0, -"_ore".length) : undefined;
      })
      .filter((id): id is string => id !== undefined),
  );
  return keys.length === 1 ? keys[0] : undefined;
}

function configuredFeaturePath(id: string, paths: string[]): string | undefined {
  const [namespace, key] = id.split(":", 2);
  if (namespace !== "minecraft" || !key) {
    return undefined;
  }
  for (const prefix of CONFIGURED_FEATURE_PREFIXES) {
    const candidate = `${prefix}${key}.json`;
    if (paths.includes(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function idFromPath(prefix: string, path: string): string {
  return `minecraft:${path.slice(prefix.length, -".json".length)}`;
}

function normalizeId(id: string): string {
  return id.includes(":") ? id : `minecraft:${id}`;
}

function localId(value: JsonValue | undefined): string {
  if (typeof value !== "string") return "";
  return value.includes(":") ? (value.split(":", 2)[1] ?? "") : value;
}

function resourceName(key: string): string {
  if (key === "lapis_lazuli") return "Lapis Lazuli";
  if (key === "quartz") return "Nether Quartz";
  return humanize(key);
}

function humanize(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function groupBy<T, K extends string>(values: T[], keyOf: (value: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const entries = grouped.get(key) ?? [];
    entries.push(value);
    grouped.set(key, entries);
  }
  return grouped;
}

function round12(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}
