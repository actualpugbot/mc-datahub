import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileExists, readJsonFile } from "../core/fs.js";
import type { Logger } from "../core/logger.js";
import type {
  TreeFamilyBlockStats,
  TreeFamilyDefinition,
  TreeFamilyFungus,
  TreeFeatureDecorator,
  TreeFeatureShape,
  TreeFeatureTrunkPlacer,
  TreeFeaturesDataset,
  TreeFeaturesGrowthMechanics,
  TreeGrowerDefinition,
} from "../domain/types.js";

const TREE_GROWER_SOURCE = "net/minecraft/world/level/block/grower/TreeGrower.java";
const TREE_FEATURES_SOURCE = "net/minecraft/data/worldgen/features/TreeFeatures.java";
const SAPLING_SOURCE = "net/minecraft/world/level/block/SaplingBlock.java";
const BLOCKS_SOURCE = "net/minecraft/world/level/block/Blocks.java";
const FIRE_SOURCE = "net/minecraft/world/level/block/FireBlock.java";
const FUEL_SOURCE = "net/minecraft/world/level/block/entity/FuelValues.java";
const COMPOSTER_SOURCE = "net/minecraft/world/level/block/ComposterBlock.java";
const CONFIGURED_FEATURE_DIR = "data/minecraft/worldgen/configured_feature";
const ITEM_TAG_DIR = "data/minecraft/tags/item";
const BLOCKSTATE_DIR = "assets/minecraft/blockstates";
const LANG_PATH = "assets/minecraft/lang/en_us.json";

/** The huge-fungus features are not referenced by any TreeGrower but belong to the crimson/warped families. */
const FUNGUS_FEATURES = ["crimson_fungus", "crimson_fungus_planted", "warped_fungus", "warped_fungus_planted"];

type FamilyCategory = "overworld" | "nether" | "bamboo";

const FAMILIES: Array<{ key: string; category: FamilyCategory }> = [
  { key: "oak", category: "overworld" },
  { key: "spruce", category: "overworld" },
  { key: "birch", category: "overworld" },
  { key: "jungle", category: "overworld" },
  { key: "acacia", category: "overworld" },
  { key: "dark_oak", category: "overworld" },
  { key: "mangrove", category: "overworld" },
  { key: "cherry", category: "overworld" },
  { key: "pale_oak", category: "overworld" },
  { key: "bamboo", category: "bamboo" },
  { key: "crimson", category: "nether" },
  { key: "warped", category: "nether" },
];

/** Shared roles for every plank-derived block in a family, in presentation order. */
const PLANK_SET_ROLES: Array<[role: string, suffix: string]> = [
  ["planks", "planks"],
  ["stairs", "stairs"],
  ["slab", "slab"],
  ["fence", "fence"],
  ["fence_gate", "fence_gate"],
  ["door", "door"],
  ["trapdoor", "trapdoor"],
  ["button", "button"],
  ["pressure_plate", "pressure_plate"],
  ["sign", "sign"],
  ["hanging_sign", "hanging_sign"],
  ["shelf", "shelf"],
];

interface ParsedGrower {
  name: string;
  secondaryChance: number;
  /** Bare feature keys in slot order: mega, secondaryMega, tree, secondaryTree, flowers, secondaryFlowers. */
  slots: Array<string | undefined>;
}

interface RawConfiguredFeature {
  type?: string;
  config?: Record<string, unknown>;
}

/**
 * Derives per-wood-family tree data from decompiled source and worldgen JSON: which configured
 * features each sapling's TreeGrower can place (including 2x2 mega and bee variants), the sapling
 * growth-mechanics constants, the trunk/foliage shape of every referenced feature, and per-block
 * flammability / furnace-fuel / compost stats for each family's full block set. Numbers are parsed
 * from the actual source; parse gaps become warnings instead of guesses.
 */
export class TreeFeaturesExtractor {
  private displayNames = new Map<string, string>();
  private tagCache = new Map<string, string[]>();

  constructor(private readonly logger: Logger) {}

  async extract(decompiledClientRoot: string): Promise<TreeFeaturesDataset | undefined> {
    const growerPath = join(decompiledClientRoot, TREE_GROWER_SOURCE);
    if (!(await fileExists(growerPath))) {
      this.logger.warn(`Skipping tree features; ${TREE_GROWER_SOURCE} was not found under ${decompiledClientRoot}.`);
      return undefined;
    }

    this.displayNames = await this.loadLang(decompiledClientRoot);
    this.tagCache = new Map();

    const warnings: string[] = [];
    const sourcePaths: string[] = [
      TREE_GROWER_SOURCE,
      TREE_FEATURES_SOURCE,
      SAPLING_SOURCE,
      BLOCKS_SOURCE,
      CONFIGURED_FEATURE_DIR,
    ];

    const featureKeys = await this.readTreeFeatureKeys(decompiledClientRoot, warnings);
    const growers = await this.readGrowers(growerPath, featureKeys, warnings);
    const saplingGrowers = await this.readSaplingRegistrations(decompiledClientRoot, warnings);
    const fungusFeaturesByBlock = await this.readFungusRegistrations(decompiledClientRoot, featureKeys, warnings);
    const growth = await this.readGrowthMechanics(decompiledClientRoot, warnings);
    const flammability = await this.readFlammability(decompiledClientRoot, sourcePaths, warnings);
    const fuelTicks = await this.readFuelValues(decompiledClientRoot, sourcePaths, warnings);
    const compost = await this.readCompostables(decompiledClientRoot, sourcePaths, warnings);

    const families: TreeFamilyDefinition[] = [];
    const referencedFeatures = new Set<string>(FUNGUS_FEATURES);

    for (const { key, category } of FAMILIES) {
      const family: TreeFamilyDefinition = {
        family: key,
        displayName: titleCase(key),
        category,
        blocks: await this.buildFamilyBlocks(decompiledClientRoot, key, category, { flammability, fuelTicks, compost }, warnings),
      };

      if (category === "nether") {
        family.sapling = `minecraft:${key}_fungus`;
        family.fungus = this.fungusInfo(key, fungusFeaturesByBlock, warnings);
      } else if (category === "overworld") {
        const grower = growers.get(key);
        if (grower) {
          family.grower = this.toGrowerDefinition(grower);
          for (const slot of grower.slots) {
            if (slot) {
              referencedFeatures.add(slot);
            }
          }
        } else {
          warnings.push(`No TreeGrower named "${key}" was found in TreeGrower.java.`);
        }
        const sapling = saplingGrowers.get(key);
        if (sapling) {
          family.sapling = `minecraft:${sapling}`;
        } else {
          warnings.push(`No sapling block registration referencing TreeGrower.${key.toUpperCase()} was found in Blocks.java.`);
        }
      }

      families.push(family);
    }

    const features: TreeFeatureShape[] = [];
    for (const featureKey of Array.from(referencedFeatures).sort((left, right) => left.localeCompare(right))) {
      const shape = await this.readFeatureShape(decompiledClientRoot, featureKey, warnings);
      if (shape) {
        features.push(shape);
      }
    }

    for (const warning of warnings) {
      this.logger.warn(`Tree features: ${warning}`);
    }

    return { growth, families, features, sourcePaths, warnings };
  }

  /** Parses `SYMBOL = FeatureUtils.createKey("name")` from TreeFeatures.java into symbol → bare feature key. */
  private async readTreeFeatureKeys(root: string, warnings: string[]): Promise<Map<string, string>> {
    const keys = new Map<string, string>();
    const path = join(root, TREE_FEATURES_SOURCE);
    if (!(await fileExists(path))) {
      warnings.push(`${TREE_FEATURES_SOURCE} was not found; grower feature references cannot be resolved.`);
      return keys;
    }
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(/(\w+)\s*=\s*FeatureUtils\.createKey\("([^"]+)"\)/g)) {
      keys.set(match[1]!, match[2]!);
    }
    if (keys.size === 0) {
      warnings.push(`No FeatureUtils.createKey entries were parsed from ${TREE_FEATURES_SOURCE}.`);
    }
    return keys;
  }

  /**
   * Parses every `new TreeGrower(...)` static in TreeGrower.java. The 8-argument constructor is
   * (name, secondaryChance, megaTree, secondaryMegaTree, tree, secondaryTree, flowers, secondaryFlowers);
   * the 4-argument convenience constructor is (name, megaTree, tree, flowers) with chance 0.
   */
  private async readGrowers(
    growerPath: string,
    featureKeys: Map<string, string>,
    warnings: string[],
  ): Promise<Map<string, ParsedGrower>> {
    const source = await readFile(growerPath, "utf8");
    const growers = new Map<string, ParsedGrower>();

    for (const match of source.matchAll(/new TreeGrower\(([\s\S]*?)\);/g)) {
      const args = match[1]!;
      const name = args.match(/"([a-z0-9_]+)"/)?.[1];
      if (!name) {
        continue;
      }
      const chance = args.match(/"[a-z0-9_]+",\s*([\d.]+)F/);
      const optionals: Array<string | undefined> = [];
      let resolved = true;
      for (const optional of args.matchAll(/Optional\.(?:empty\(\)|of\(TreeFeatures\.(\w+)\))/g)) {
        const symbol = optional[1];
        if (symbol === undefined) {
          optionals.push(undefined);
          continue;
        }
        const featureKey = featureKeys.get(symbol);
        if (!featureKey) {
          warnings.push(`Grower "${name}" references TreeFeatures.${symbol}, which was not found in TreeFeatures.java.`);
          resolved = false;
        }
        optionals.push(featureKey);
      }
      if (!resolved) {
        continue;
      }

      // Slot order: [megaTree, secondaryMegaTree, tree, secondaryTree, flowers, secondaryFlowers].
      let slots: Array<string | undefined>;
      if (optionals.length === 6) {
        slots = optionals;
      } else if (optionals.length === 3) {
        slots = [optionals[0], undefined, optionals[1], undefined, optionals[2], undefined];
      } else {
        warnings.push(`Grower "${name}" has ${optionals.length} Optional arguments; expected 3 or 6.`);
        continue;
      }

      growers.set(name, { name, secondaryChance: chance ? Number(chance[1]) : 0, slots });
    }

    if (growers.size === 0) {
      warnings.push("No TreeGrower definitions were parsed from TreeGrower.java.");
    }
    return growers;
  }

  private toGrowerDefinition(grower: ParsedGrower): TreeGrowerDefinition {
    const [megaTree, secondaryMegaTree, tree, secondaryTree, flowers, secondaryFlowers] = grower.slots;
    return {
      name: grower.name,
      secondaryChance: grower.secondaryChance,
      ...(tree ? { tree: `minecraft:${tree}` } : {}),
      ...(secondaryTree ? { secondaryTree: `minecraft:${secondaryTree}` } : {}),
      ...(megaTree ? { megaTree: `minecraft:${megaTree}` } : {}),
      ...(secondaryMegaTree ? { secondaryMegaTree: `minecraft:${secondaryMegaTree}` } : {}),
      ...(flowers ? { flowers: `minecraft:${flowers}` } : {}),
      ...(secondaryFlowers ? { secondaryFlowers: `minecraft:${secondaryFlowers}` } : {}),
      canBeTwoByTwo: megaTree !== undefined,
      requiresTwoByTwo: megaTree !== undefined && tree === undefined,
    };
  }

  /** Maps grower name → sapling/propagule block id from the Blocks.java registrations. */
  private async readSaplingRegistrations(root: string, warnings: string[]): Promise<Map<string, string>> {
    const saplings = new Map<string, string>();
    const path = join(root, BLOCKS_SOURCE);
    if (!(await fileExists(path))) {
      warnings.push(`${BLOCKS_SOURCE} was not found; sapling registrations omitted.`);
      return saplings;
    }
    const source = await readFile(path, "utf8");
    const pattern = /register\(\s*BlockItemIds\.(\w+),\s*p -> new (?:SaplingBlock|MangrovePropaguleBlock)\(TreeGrower\.(\w+),/g;
    for (const match of source.matchAll(pattern)) {
      saplings.set(match[2]!.toLowerCase(), match[1]!.toLowerCase());
    }
    if (saplings.size === 0) {
      warnings.push("No SaplingBlock/MangrovePropaguleBlock registrations were parsed from Blocks.java.");
    }
    return saplings;
  }

  /** Maps fungus block id → the planted huge-fungus feature key from the NetherFungusBlock registrations. */
  private async readFungusRegistrations(
    root: string,
    featureKeys: Map<string, string>,
    warnings: string[],
  ): Promise<Map<string, string>> {
    const fungi = new Map<string, string>();
    const path = join(root, BLOCKS_SOURCE);
    if (!(await fileExists(path))) {
      return fungi;
    }
    const source = await readFile(path, "utf8");
    const pattern = /register\(\s*BlockItemIds\.(\w+),\s*p -> new NetherFungusBlock\(TreeFeatures\.(\w+),/g;
    for (const match of source.matchAll(pattern)) {
      const featureKey = featureKeys.get(match[2]!);
      if (featureKey) {
        fungi.set(match[1]!.toLowerCase(), featureKey);
      } else {
        warnings.push(`Fungus block ${match[1]!.toLowerCase()} references unresolved TreeFeatures.${match[2]!}.`);
      }
    }
    return fungi;
  }

  private fungusInfo(family: string, fungusFeaturesByBlock: Map<string, string>, warnings: string[]): TreeFamilyFungus {
    const block = `${family}_fungus`;
    const planted = fungusFeaturesByBlock.get(block);
    if (!planted) {
      warnings.push(`No NetherFungusBlock registration for ${block} was found in Blocks.java.`);
    }
    return {
      block: `minecraft:${block}`,
      wildFeature: `minecraft:${block}`,
      plantedFeature: `minecraft:${planted ?? `${block}_planted`}`,
    };
  }

  /** Parses the sapling growth constants (light threshold, tick odds, stages, bonemeal chance) from SaplingBlock.java. */
  private async readGrowthMechanics(root: string, warnings: string[]): Promise<TreeFeaturesGrowthMechanics> {
    const growth: TreeFeaturesGrowthMechanics = { sourcePath: SAPLING_SOURCE };
    const path = join(root, SAPLING_SOURCE);
    if (!(await fileExists(path))) {
      warnings.push(`${SAPLING_SOURCE} was not found; growth mechanics omitted.`);
      return growth;
    }
    const source = await readFile(path, "utf8");

    const light = source.match(/getMaxLocalRawBrightness\(pos\.above\(\)\)\s*>=\s*(\d+)/);
    if (light) {
      growth.lightLevelMin = Number(light[1]);
    } else {
      warnings.push("The sapling light threshold (getMaxLocalRawBrightness >= N) was not found in SaplingBlock.java.");
    }

    const tick = source.match(/random\.nextInt\((\d+)\)\s*==\s*0/);
    if (tick) {
      growth.randomTickGrowthOneIn = Number(tick[1]);
    } else {
      warnings.push("The sapling random-tick odds (random.nextInt(N) == 0) were not found in SaplingBlock.java.");
    }

    // advanceTree cycles STAGE from 0 to 1 first, then grows: two steps in total.
    if (/getValue\(STAGE\)\s*==\s*0/.test(source) && /cycle\(STAGE\)/.test(source)) {
      growth.growthStages = 2;
    } else {
      warnings.push("The two-step STAGE cycle was not found in SaplingBlock.java.");
    }

    const bonemeal = source.match(/nextFloat\(\)\s*<\s*([\d.]+)/);
    if (bonemeal) {
      growth.bonemealSuccessChance = Number(bonemeal[1]);
    } else {
      warnings.push("The sapling bonemeal success chance (nextFloat() < N) was not found in SaplingBlock.java.");
    }

    return growth;
  }

  /** Parses FireBlock.bootStrap(): block id → { igniteOdds, burnOdds }. Absent means not flammable. */
  private async readFlammability(
    root: string,
    sourcePaths: string[],
    warnings: string[],
  ): Promise<Map<string, { igniteOdds: number; burnOdds: number }>> {
    const flammability = new Map<string, { igniteOdds: number; burnOdds: number }>();
    const path = join(root, FIRE_SOURCE);
    if (!(await fileExists(path))) {
      warnings.push(`${FIRE_SOURCE} was not found; flammability omitted.`);
      return flammability;
    }
    sourcePaths.push(FIRE_SOURCE);
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(/setFlammable\(Blocks\.(\w+),\s*(\d+),\s*(\d+)\)/g)) {
      flammability.set(match[1]!.toLowerCase(), { igniteOdds: Number(match[2]), burnOdds: Number(match[3]) });
    }
    if (flammability.size === 0) {
      warnings.push("No setFlammable entries were parsed from FireBlock.bootStrap().");
    }
    return flammability;
  }

  /**
   * Replays the FuelValues.vanillaBurnTimes builder chain: item id → burn ticks. Tag adds are resolved
   * through the exported item-tag JSON files, expressions are evaluated with Java integer semantics, and
   * `.remove(tag)` entries (non-flammable nether wood) are dropped, exactly as the game does.
   */
  private async readFuelValues(root: string, sourcePaths: string[], warnings: string[]): Promise<Map<string, number>> {
    const fuel = new Map<string, number>();
    const path = join(root, FUEL_SOURCE);
    if (!(await fileExists(path))) {
      warnings.push(`${FUEL_SOURCE} was not found; fuel values omitted.`);
      return fuel;
    }
    sourcePaths.push(FUEL_SOURCE);
    const source = await readFile(path, "utf8");

    const baseUnitMatch = source.match(/vanillaBurnTimes\(\s*registries,\s*enabledFeatures,\s*(\d+)\s*\)/);
    if (!baseUnitMatch) {
      warnings.push("The vanillaBurnTimes base unit was not found in FuelValues.java.");
      return fuel;
    }
    const baseUnit = Number(baseUnitMatch[1]);

    const chainStart = source.indexOf("new FuelValues.Builder");
    const chainEnd = source.indexOf(".build()", chainStart);
    if (chainStart < 0 || chainEnd < 0) {
      warnings.push("The FuelValues builder chain was not found in FuelValues.java.");
      return fuel;
    }
    const chain = source.slice(chainStart, chainEnd);

    for (const match of chain.matchAll(/\.(add|remove)\(\s*(ItemTags|Items|Blocks)\.(\w+)\s*(?:,\s*([^)]*))?\)/g)) {
      const [, operation, registry, symbol, expression] = match;
      const bareId = symbol!.toLowerCase();
      if (operation === "remove") {
        if (registry !== "ItemTags") {
          warnings.push(`Unsupported FuelValues remove target ${registry}.${symbol}.`);
          continue;
        }
        for (const id of await this.resolveItemTag(root, bareId, new Set(), warnings)) {
          fuel.delete(id);
        }
        continue;
      }

      const ticks = evaluateJavaIntExpression(expression ?? "", baseUnit);
      if (ticks === undefined) {
        warnings.push(`Could not evaluate the fuel expression "${expression ?? ""}" for ${registry}.${symbol}.`);
        continue;
      }
      if (registry === "ItemTags") {
        for (const id of await this.resolveItemTag(root, bareId, new Set(), warnings)) {
          fuel.set(id, ticks);
        }
      } else {
        fuel.set(`minecraft:${bareId}`, ticks);
      }
    }

    if (fuel.size === 0) {
      warnings.push("No fuel values were parsed from FuelValues.vanillaBurnTimes().");
    }
    return fuel;
  }

  /** Parses ComposterBlock's COMPOSTABLES bootstrap: item id → compost fill chance. */
  private async readCompostables(root: string, sourcePaths: string[], warnings: string[]): Promise<Map<string, number>> {
    const compost = new Map<string, number>();
    const path = join(root, COMPOSTER_SOURCE);
    if (!(await fileExists(path))) {
      warnings.push(`${COMPOSTER_SOURCE} was not found; compost chances omitted.`);
      return compost;
    }
    sourcePaths.push(COMPOSTER_SOURCE);
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(/add\(([\d.]+)F,\s*Items\.(\w+)\)/g)) {
      compost.set(`minecraft:${match[2]!.toLowerCase()}`, Number(match[1]));
    }
    if (compost.size === 0) {
      warnings.push("No COMPOSTABLES entries were parsed from ComposterBlock.java.");
    }
    return compost;
  }

  /** Builds the family's expected block set (role → id), verifying each block exists via its blockstate file. */
  private async buildFamilyBlocks(
    root: string,
    family: string,
    category: FamilyCategory,
    stats: {
      flammability: Map<string, { igniteOdds: number; burnOdds: number }>;
      fuelTicks: Map<string, number>;
      compost: Map<string, number>;
    },
    warnings: string[],
  ): Promise<TreeFamilyBlockStats[]> {
    const entries: Array<[role: string, bareId: string]> = [];

    if (category === "overworld") {
      entries.push(family === "mangrove" ? ["propagule", "mangrove_propagule"] : ["sapling", `${family}_sapling`]);
      entries.push(
        ["log", `${family}_log`],
        ["stripped_log", `stripped_${family}_log`],
        ["wood", `${family}_wood`],
        ["stripped_wood", `stripped_${family}_wood`],
      );
      for (const [role, suffix] of PLANK_SET_ROLES) {
        entries.push([role, `${family}_${suffix}`]);
      }
      entries.push(["leaves", `${family}_leaves`]);
    } else if (category === "nether") {
      entries.push(
        ["fungus", `${family}_fungus`],
        ["stem", `${family}_stem`],
        ["stripped_stem", `stripped_${family}_stem`],
        ["hyphae", `${family}_hyphae`],
        ["stripped_hyphae", `stripped_${family}_hyphae`],
      );
      for (const [role, suffix] of PLANK_SET_ROLES) {
        entries.push([role, `${family}_${suffix}`]);
      }
    } else {
      // Bamboo: the shoot item plants "bamboo"; bamboo_block stands in for the log and mosaic extends the plank set.
      entries.push(["sapling", "bamboo"], ["bamboo_block", "bamboo_block"], ["stripped_bamboo_block", "stripped_bamboo_block"]);
      for (const [role, suffix] of PLANK_SET_ROLES) {
        entries.push([role, `bamboo_${suffix}`]);
      }
      entries.push(["mosaic", "bamboo_mosaic"], ["mosaic_stairs", "bamboo_mosaic_stairs"], ["mosaic_slab", "bamboo_mosaic_slab"]);
    }

    const blocks: TreeFamilyBlockStats[] = [];
    for (const [role, bareId] of entries) {
      if (!(await fileExists(join(root, BLOCKSTATE_DIR, `${bareId}.json`)))) {
        warnings.push(`Expected block ${bareId} (${family} ${role}) has no blockstate file; skipped.`);
        continue;
      }
      const id = `minecraft:${bareId}`;
      const flammable = stats.flammability.get(bareId);
      const fuel = stats.fuelTicks.get(id);
      const compostChance = stats.compost.get(id);
      blocks.push({
        id,
        name: this.nameFor(bareId),
        role,
        flammable: flammable !== undefined,
        ...(flammable ? { igniteOdds: flammable.igniteOdds, burnOdds: flammable.burnOdds } : {}),
        ...(fuel !== undefined ? { fuelTicks: fuel } : {}),
        ...(compostChance !== undefined ? { compostChance } : {}),
      });
    }
    return blocks;
  }

  /** Reads one configured feature JSON and summarizes its trunk/foliage/decorator shape. */
  private async readFeatureShape(root: string, featureKey: string, warnings: string[]): Promise<TreeFeatureShape | undefined> {
    const relativePath = `${CONFIGURED_FEATURE_DIR}/${featureKey}.json`;
    const path = join(root, relativePath);
    if (!(await fileExists(path))) {
      warnings.push(`Configured feature ${featureKey} referenced by a grower was not found at ${relativePath}.`);
      return undefined;
    }

    let raw: RawConfiguredFeature;
    try {
      raw = await readJsonFile<RawConfiguredFeature>(path);
    } catch (error) {
      warnings.push(`Could not read configured feature ${featureKey}: ${(error as Error).message}.`);
      return undefined;
    }

    const config = isRecord(raw.config) ? raw.config : {};
    const shape: TreeFeatureShape = {
      key: `minecraft:${featureKey}`,
      featureType: typeof raw.type === "string" ? raw.type : "unknown",
      decorators: [],
      sourcePath: relativePath,
    };

    if (shape.featureType === "minecraft:tree") {
      shape.trunkPlacer = this.trunkPlacer(config.trunk_placer, featureKey, warnings);
      const foliage = config.foliage_placer;
      if (isRecord(foliage) && typeof foliage.type === "string") {
        shape.foliagePlacer = { type: foliage.type, params: flattenNumbers(foliage, ["type"]) };
      } else {
        warnings.push(`Tree feature ${featureKey} has no foliage_placer.`);
      }
      shape.trunkBlock = providerBlock(config.trunk_provider);
      shape.foliageBlock = providerBlock(config.foliage_provider);
      if (shape.trunkBlock === undefined) {
        warnings.push(`Tree feature ${featureKey} has no resolvable trunk block.`);
      }
      if (typeof config.ignore_vines === "boolean") {
        shape.ignoreVines = config.ignore_vines;
      }
      const rootPlacer = config.root_placer;
      if (isRecord(rootPlacer) && typeof rootPlacer.type === "string") {
        shape.rootPlacerType = rootPlacer.type;
      }
      if (Array.isArray(config.decorators)) {
        shape.decorators = config.decorators.filter(isRecord).map((decorator) => this.decorator(decorator));
      }
    } else if (shape.featureType === "minecraft:huge_fungus") {
      shape.trunkBlock = stateName(config.stem_state);
      shape.foliageBlock = stateName(config.hat_state);
      shape.decorBlock = stateName(config.decor_state);
      shape.baseBlock = stateName(config.valid_base_block);
      if (shape.trunkBlock === undefined) {
        warnings.push(`Huge fungus feature ${featureKey} has no resolvable stem block.`);
      }
    } else {
      warnings.push(`Feature ${featureKey} has unexpected type ${shape.featureType}.`);
    }

    return shape;
  }

  private trunkPlacer(raw: unknown, featureKey: string, warnings: string[]): TreeFeatureTrunkPlacer | undefined {
    if (
      !isRecord(raw) ||
      typeof raw.type !== "string" ||
      typeof raw.base_height !== "number" ||
      typeof raw.height_rand_a !== "number" ||
      typeof raw.height_rand_b !== "number"
    ) {
      warnings.push(`Tree feature ${featureKey} has no complete trunk_placer (type/base_height/height_rand_a/height_rand_b).`);
      return undefined;
    }
    return {
      type: raw.type,
      baseHeight: raw.base_height,
      heightRandA: raw.height_rand_a,
      heightRandB: raw.height_rand_b,
      minHeight: raw.base_height,
      maxHeight: raw.base_height + raw.height_rand_a + raw.height_rand_b,
    };
  }

  private decorator(raw: Record<string, unknown>): TreeFeatureDecorator {
    const block = findStateName(raw);
    return {
      type: typeof raw.type === "string" ? raw.type : "unknown",
      ...(typeof raw.probability === "number" ? { probability: raw.probability } : {}),
      ...(block ? { block } : {}),
    };
  }

  /** Reads the raw `values` array of an item tag file, or [] if missing. */
  private async readItemTagRaw(root: string, tagId: string): Promise<unknown[]> {
    const path = join(root, ITEM_TAG_DIR, `${stripNamespace(tagId)}.json`);
    if (!(await fileExists(path))) {
      return [];
    }
    try {
      const raw = await readJsonFile<{ values?: unknown[] }>(path);
      return Array.isArray(raw.values) ? raw.values : [];
    } catch {
      return [];
    }
  }

  /** Recursively resolves an item tag to concrete item ids, guarding against cycles. */
  private async resolveItemTag(root: string, tagId: string, seen: Set<string>, warnings: string[]): Promise<string[]> {
    const normalizedTag = stripNamespace(tagId);
    const cached = this.tagCache.get(normalizedTag);
    if (cached) {
      return cached;
    }
    if (seen.has(normalizedTag)) {
      return [];
    }
    seen.add(normalizedTag);

    const values = await this.readItemTagRaw(root, tagId);
    if (values.length === 0 && !(await fileExists(join(root, ITEM_TAG_DIR, `${normalizedTag}.json`)))) {
      warnings.push(`Item tag #minecraft:${normalizedTag} referenced by FuelValues was not found.`);
    }

    const ids = new Set<string>();
    for (const value of values) {
      const entry = typeof value === "string" ? value : isRecord(value) && typeof value.id === "string" ? value.id : "";
      if (!entry) {
        continue;
      }
      if (entry.startsWith("#")) {
        for (const nested of await this.resolveItemTag(root, entry.slice(1), seen, warnings)) {
          ids.add(nested);
        }
      } else {
        ids.add(normalizeId(entry));
      }
    }

    const resolved = Array.from(ids);
    this.tagCache.set(normalizedTag, resolved);
    return resolved;
  }

  private nameFor(bareId: string): string {
    return (
      this.displayNames.get(`block.minecraft.${bareId}`) ?? this.displayNames.get(`item.minecraft.${bareId}`) ?? titleCase(bareId)
    );
  }

  private async loadLang(root: string): Promise<Map<string, string>> {
    const path = join(root, LANG_PATH);
    if (!(await fileExists(path))) {
      return new Map();
    }
    try {
      const raw = await readJsonFile<Record<string, string>>(path);
      return new Map(Object.entries(raw));
    } catch {
      return new Map();
    }
  }
}

/**
 * Evaluates a Java integer expression over +, -, *, / with the `baseUnit` variable and Java's
 * truncating integer division (e.g. "baseUnit * 3 / 2" → 300 when baseUnit is 200).
 */
function evaluateJavaIntExpression(expression: string, baseUnit: number): number | undefined {
  const compact = expression.replace(/\s+/g, "");
  const tokens = compact.match(/\d+|baseUnit|[+\-*/]/g);
  if (!tokens || tokens.join("") !== compact) {
    return undefined;
  }

  let index = 0;
  const value = (): number | undefined => {
    const token = tokens[index++];
    if (token === "baseUnit") {
      return baseUnit;
    }
    return token !== undefined && /^\d+$/.test(token) ? Number(token) : undefined;
  };
  const term = (): number | undefined => {
    let left = value();
    while (left !== undefined && (tokens[index] === "*" || tokens[index] === "/")) {
      const operator = tokens[index++];
      const right = value();
      if (right === undefined) {
        return undefined;
      }
      left = operator === "*" ? left * right : Math.trunc(left / right);
    }
    return left;
  };

  let result = term();
  while (result !== undefined && (tokens[index] === "+" || tokens[index] === "-")) {
    const operator = tokens[index++];
    const right = term();
    if (right === undefined) {
      return undefined;
    }
    result = operator === "+" ? result + right : result - right;
  }
  return index === tokens.length ? result : undefined;
}

/** Extracts the block id from a state provider (simple providers directly; rule-based via its first rule). */
function providerBlock(provider: unknown): string | undefined {
  if (!isRecord(provider)) {
    return undefined;
  }
  const direct = stateName(provider.state);
  if (direct) {
    return direct;
  }
  return findStateName(provider);
}

/** Reads the `Name` of a blockstate literal like { "Name": "minecraft:oak_log", "Properties": {...} }. */
function stateName(state: unknown): string | undefined {
  return isRecord(state) && typeof state.Name === "string" ? state.Name : undefined;
}

/** Depth-first search for the first `state.Name` inside a nested provider/decorator structure. */
function findStateName(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findStateName(entry);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const direct = stateName(value.state);
  if (direct) {
    return direct;
  }
  for (const entry of Object.values(value)) {
    const found = findStateName(entry);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** Collects scalar numbers from an object; { min_inclusive, max_inclusive } ranges flatten to <key>_min / <key>_max. */
function flattenNumbers(source: Record<string, unknown>, excludeKeys: string[]): Record<string, number> {
  const params: Record<string, number> = {};
  for (const [key, value] of Object.entries(source)) {
    if (excludeKeys.includes(key)) {
      continue;
    }
    if (typeof value === "number") {
      params[key] = value;
    } else if (isRecord(value) && typeof value.min_inclusive === "number" && typeof value.max_inclusive === "number") {
      params[`${key}_min`] = value.min_inclusive;
      params[`${key}_max`] = value.max_inclusive;
    }
  }
  return params;
}

function normalizeId(value: string): string {
  const trimmed = value.trim();
  return trimmed.includes(":") ? trimmed : `minecraft:${trimmed}`;
}

function stripNamespace(value: string): string {
  const withoutHash = value.startsWith("#") ? value.slice(1) : value;
  const colon = withoutHash.indexOf(":");
  return colon >= 0 ? withoutHash.slice(colon + 1) : withoutHash;
}

function titleCase(value: string): string {
  return value
    .split(/[_/]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
