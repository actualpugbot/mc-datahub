import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createConsoleLogger } from "../src/core/logger.js";
import { TreeFeaturesExtractor } from "../src/extraction/treeFeaturesExtractor.js";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    Array.from(tempDirs, async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
  tempDirs.clear();
});

async function createTempClientRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tree-features-"));
  tempDirs.add(root);
  return root;
}

async function writeFileAt(root: string, relativePath: string, contents: string): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

const PLANK_ROLES = [
  "planks",
  "stairs",
  "slab",
  "fence",
  "fence_gate",
  "door",
  "trapdoor",
  "button",
  "pressure_plate",
  "sign",
  "hanging_sign",
  "shelf",
];
const OVERWORLD_FAMILIES = ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry", "pale_oak"];
const NETHER_FAMILIES = ["crimson", "warped"];

/** Every block id the extractor expects to find a blockstate file for, across all twelve families. */
function expectedBlockIds(): string[] {
  const ids: string[] = [];
  for (const family of OVERWORLD_FAMILIES) {
    ids.push(family === "mangrove" ? "mangrove_propagule" : `${family}_sapling`);
    ids.push(`${family}_log`, `stripped_${family}_log`, `${family}_wood`, `stripped_${family}_wood`, `${family}_leaves`);
    for (const role of PLANK_ROLES) {
      ids.push(`${family}_${role}`);
    }
  }
  for (const family of NETHER_FAMILIES) {
    ids.push(`${family}_fungus`, `${family}_stem`, `stripped_${family}_stem`, `${family}_hyphae`, `stripped_${family}_hyphae`);
    for (const role of PLANK_ROLES) {
      ids.push(`${family}_${role}`);
    }
  }
  ids.push("bamboo", "bamboo_block", "stripped_bamboo_block", "bamboo_mosaic", "bamboo_mosaic_stairs", "bamboo_mosaic_slab");
  for (const role of PLANK_ROLES) {
    ids.push(`bamboo_${role}`);
  }
  return ids;
}

/** Grower name → the TreeFeatures symbols it wires, in constructor slot order. */
const GROWER_SOURCES = [
  `public static final TreeGrower OAK = new TreeGrower("oak", 0.1F, Optional.empty(), Optional.empty(), Optional.of(TreeFeatures.OAK), Optional.of(TreeFeatures.FANCY_OAK), Optional.of(TreeFeatures.OAK_BEES_005), Optional.of(TreeFeatures.FANCY_OAK_BEES_005));`,
  `public static final TreeGrower SPRUCE = new TreeGrower("spruce", 0.5F, Optional.of(TreeFeatures.MEGA_SPRUCE), Optional.of(TreeFeatures.MEGA_PINE), Optional.of(TreeFeatures.SPRUCE), Optional.empty(), Optional.empty(), Optional.empty());`,
  `public static final TreeGrower MANGROVE = new TreeGrower("mangrove", 0.85F, Optional.empty(), Optional.empty(), Optional.of(TreeFeatures.MANGROVE), Optional.of(TreeFeatures.TALL_MANGROVE), Optional.empty(), Optional.empty());`,
  `public static final TreeGrower BIRCH = new TreeGrower("birch", Optional.empty(), Optional.of(TreeFeatures.BIRCH), Optional.of(TreeFeatures.BIRCH_BEES_005));`,
  `public static final TreeGrower JUNGLE = new TreeGrower("jungle", Optional.of(TreeFeatures.MEGA_JUNGLE_TREE), Optional.of(TreeFeatures.JUNGLE_TREE_NO_VINE), Optional.empty());`,
  `public static final TreeGrower ACACIA = new TreeGrower("acacia", Optional.empty(), Optional.of(TreeFeatures.ACACIA), Optional.empty());`,
  `public static final TreeGrower CHERRY = new TreeGrower("cherry", Optional.empty(), Optional.of(TreeFeatures.CHERRY), Optional.of(TreeFeatures.CHERRY_BEES_005));`,
  `public static final TreeGrower DARK_OAK = new TreeGrower("dark_oak", Optional.of(TreeFeatures.DARK_OAK), Optional.empty(), Optional.empty());`,
  `public static final TreeGrower PALE_OAK = new TreeGrower("pale_oak", Optional.of(TreeFeatures.PALE_OAK_BONEMEAL), Optional.empty(), Optional.empty());`,
];

const TREE_GROWER_SOURCE = `package net.minecraft.world.level.block.grower;
public final class TreeGrower {
${GROWER_SOURCES.map((line) => `   ${line}`).join("\n")}
}`;

/** Every configured-feature key the growers (and the nether fungi) can reach. */
const FEATURE_SYMBOLS = [
  "OAK",
  "FANCY_OAK",
  "OAK_BEES_005",
  "FANCY_OAK_BEES_005",
  "SPRUCE",
  "MEGA_SPRUCE",
  "MEGA_PINE",
  "BIRCH",
  "BIRCH_BEES_005",
  "JUNGLE_TREE_NO_VINE",
  "MEGA_JUNGLE_TREE",
  "ACACIA",
  "CHERRY",
  "CHERRY_BEES_005",
  "DARK_OAK",
  "PALE_OAK_BONEMEAL",
  "MANGROVE",
  "TALL_MANGROVE",
  "CRIMSON_FUNGUS",
  "CRIMSON_FUNGUS_PLANTED",
  "WARPED_FUNGUS",
  "WARPED_FUNGUS_PLANTED",
];

const TREE_FEATURES_SOURCE = `package net.minecraft.data.worldgen.features;
public class TreeFeatures {
${FEATURE_SYMBOLS.map(
  (symbol) =>
    `   public static final ResourceKey<ConfiguredFeature<?, ?>> ${symbol} = FeatureUtils.createKey("${symbol.toLowerCase()}");`,
).join("\n")}
}`;

const SAPLING_REGISTRATIONS: Array<[block: string, blockClass: string, grower: string]> = [
  ["OAK_SAPLING", "SaplingBlock", "OAK"],
  ["SPRUCE_SAPLING", "SaplingBlock", "SPRUCE"],
  ["BIRCH_SAPLING", "SaplingBlock", "BIRCH"],
  ["JUNGLE_SAPLING", "SaplingBlock", "JUNGLE"],
  ["ACACIA_SAPLING", "SaplingBlock", "ACACIA"],
  ["CHERRY_SAPLING", "SaplingBlock", "CHERRY"],
  ["DARK_OAK_SAPLING", "SaplingBlock", "DARK_OAK"],
  ["PALE_OAK_SAPLING", "SaplingBlock", "PALE_OAK"],
  ["MANGROVE_PROPAGULE", "MangrovePropaguleBlock", "MANGROVE"],
];

const BLOCKS_SOURCE = `package net.minecraft.world.level.block;
public class Blocks {
${SAPLING_REGISTRATIONS.map(
  ([block, blockClass, grower]) => `   public static final Block ${block} = register(
      BlockItemIds.${block},
      p -> new ${blockClass}(TreeGrower.${grower}, p),
      BlockBehaviour.Properties.of().noCollision()
   );`,
).join("\n")}
   public static final Block CRIMSON_FUNGUS = register(
      BlockItemIds.CRIMSON_FUNGUS,
      p -> new NetherFungusBlock(TreeFeatures.CRIMSON_FUNGUS_PLANTED, CRIMSON_NYLIUM, BlockTags.SUPPORTS_CRIMSON_FUNGUS, p),
      BlockBehaviour.Properties.of().instabreak()
   );
   public static final Block WARPED_FUNGUS = register(
      BlockItemIds.WARPED_FUNGUS,
      p -> new NetherFungusBlock(TreeFeatures.WARPED_FUNGUS_PLANTED, WARPED_NYLIUM, BlockTags.SUPPORTS_WARPED_FUNGUS, p),
      BlockBehaviour.Properties.of().instabreak()
   );
}`;

const SAPLING_SOURCE = `package net.minecraft.world.level.block;
public class SaplingBlock extends VegetationBlock implements BonemealableBlock {
   public static final IntegerProperty STAGE = BlockStateProperties.STAGE;
   protected void randomTick(final BlockState state, final ServerLevel level, final BlockPos pos, final RandomSource random) {
      if (level.getMaxLocalRawBrightness(pos.above()) >= 9 && random.nextInt(7) == 0) {
         this.advanceTree(level, pos, state, random);
      }
   }
   public void advanceTree(final ServerLevel level, final BlockPos pos, final BlockState state, final RandomSource random) {
      if (state.getValue(STAGE) == 0) {
         level.setBlock(pos, state.cycle(STAGE), 260);
      } else {
         this.treeGrower.growTree(level, level.getChunkSource().getGenerator(), pos, state, random);
      }
   }
   public boolean isBonemealSuccess(final Level level, final RandomSource random, final BlockPos pos, final BlockState state) {
      return level.getRandom().nextFloat() < 0.45;
   }
}`;

const FIRE_SOURCE = `package net.minecraft.world.level.block;
public class FireBlock extends BaseFireBlock {
   public static void bootStrap() {
      FireBlock fire = (FireBlock)Blocks.FIRE;
      fire.setFlammable(Blocks.OAK_PLANKS, 5, 20);
      fire.setFlammable(Blocks.OAK_STAIRS, 5, 20);
      fire.setFlammable(Blocks.OAK_SLAB, 5, 20);
      fire.setFlammable(Blocks.OAK_FENCE, 5, 20);
      fire.setFlammable(Blocks.OAK_LOG, 5, 5);
      fire.setFlammable(Blocks.STRIPPED_OAK_LOG, 5, 5);
      fire.setFlammable(Blocks.OAK_WOOD, 5, 5);
      fire.setFlammable(Blocks.STRIPPED_OAK_WOOD, 5, 5);
      fire.setFlammable(Blocks.OAK_LEAVES, 30, 60);
      fire.setFlammable(Blocks.BAMBOO_PLANKS, 5, 20);
   }
}`;

// Trimmed to the tag-driven wood entries; the real chain is longer but parses identically.
const FUEL_SOURCE = `package net.minecraft.world.level.block.entity;
public class FuelValues {
   public static FuelValues vanillaBurnTimes(final HolderLookup.Provider registries, final FeatureFlagSet enabledFeatures) {
      return vanillaBurnTimes(registries, enabledFeatures, 200);
   }
   public static FuelValues vanillaBurnTimes(final HolderLookup.Provider registries, final FeatureFlagSet enabledFeatures, final int baseUnit) {
      return new FuelValues.Builder(registries, enabledFeatures)
         .add(Items.LAVA_BUCKET, baseUnit * 100)
         .add(ItemTags.LOGS, baseUnit * 3 / 2)
         .add(ItemTags.PLANKS, baseUnit * 3 / 2)
         .add(ItemTags.WOODEN_SLABS, baseUnit * 3 / 4)
         .add(ItemTags.SAPLINGS, baseUnit / 2)
         .remove(ItemTags.NON_FLAMMABLE_WOOD)
         .build();
   }
}`;

const COMPOSTER_SOURCE = `package net.minecraft.world.level.block;
public class ComposterBlock extends Block {
   public static final Object2FloatMap<ItemLike> COMPOSTABLES = new Object2FloatOpenHashMap();
   static {
      COMPOSTABLES.defaultReturnValue(-1.0F);
      add(0.3F, Items.OAK_LEAVES);
      add(0.3F, Items.OAK_SAPLING);
      add(0.3F, Items.MANGROVE_PROPAGULE);
      add(0.65F, Items.CRIMSON_FUNGUS);
   }
}`;

interface TrunkSpec {
  type: string;
  base: number;
  a: number;
  b: number;
}

function treeFeature(options: {
  trunk: TrunkSpec;
  log: string;
  leaves: string;
  foliage: Record<string, unknown>;
  decorators?: unknown[];
  ignoreVines?: boolean;
}): string {
  return JSON.stringify({
    type: "minecraft:tree",
    config: {
      decorators: options.decorators ?? [],
      foliage_placer: options.foliage,
      foliage_provider: { type: "minecraft:simple_state_provider", state: { Name: options.leaves } },
      force_dirt: false,
      ignore_vines: options.ignoreVines ?? false,
      trunk_placer: {
        type: options.trunk.type,
        base_height: options.trunk.base,
        height_rand_a: options.trunk.a,
        height_rand_b: options.trunk.b,
      },
      trunk_provider: { type: "minecraft:simple_state_provider", state: { Name: options.log } },
    },
  });
}

function hugeFungus(family: string, planted: boolean): string {
  return JSON.stringify({
    type: "minecraft:huge_fungus",
    config: {
      decor_state: { Name: "minecraft:shroomlight" },
      hat_state: { Name: family === "crimson" ? "minecraft:nether_wart_block" : "minecraft:warped_wart_block" },
      planted,
      stem_state: { Name: `minecraft:${family}_stem` },
      valid_base_block: { Name: `minecraft:${family}_nylium` },
    },
  });
}

const BLOB_FOLIAGE = { type: "minecraft:blob_foliage_placer", radius: 2, offset: 0, height: 3 };
const BEEHIVE_005 = { type: "minecraft:beehive", probability: 0.05 };
const ALTER_GROUND_PODZOL = {
  type: "minecraft:alter_ground",
  provider: { type: "minecraft:simple_state_provider", state: { Name: "minecraft:podzol" } },
};

const CONFIGURED_FEATURES: Record<string, string> = {
  oak: treeFeature({
    trunk: { type: "minecraft:straight_trunk_placer", base: 4, a: 2, b: 0 },
    log: "minecraft:oak_log",
    leaves: "minecraft:oak_leaves",
    foliage: BLOB_FOLIAGE,
    ignoreVines: true,
  }),
  oak_bees_005: treeFeature({
    trunk: { type: "minecraft:straight_trunk_placer", base: 4, a: 2, b: 0 },
    log: "minecraft:oak_log",
    leaves: "minecraft:oak_leaves",
    foliage: BLOB_FOLIAGE,
    decorators: [BEEHIVE_005],
    ignoreVines: true,
  }),
  fancy_oak: treeFeature({
    trunk: { type: "minecraft:fancy_trunk_placer", base: 3, a: 11, b: 0 },
    log: "minecraft:oak_log",
    leaves: "minecraft:oak_leaves",
    foliage: { type: "minecraft:fancy_foliage_placer", radius: 2, offset: 4, height: 4 },
    ignoreVines: true,
  }),
  fancy_oak_bees_005: treeFeature({
    trunk: { type: "minecraft:fancy_trunk_placer", base: 3, a: 11, b: 0 },
    log: "minecraft:oak_log",
    leaves: "minecraft:oak_leaves",
    foliage: { type: "minecraft:fancy_foliage_placer", radius: 2, offset: 4, height: 4 },
    decorators: [BEEHIVE_005],
    ignoreVines: true,
  }),
  spruce: treeFeature({
    trunk: { type: "minecraft:straight_trunk_placer", base: 5, a: 2, b: 1 },
    log: "minecraft:spruce_log",
    leaves: "minecraft:spruce_leaves",
    foliage: {
      type: "minecraft:spruce_foliage_placer",
      radius: 2,
      offset: 1,
      trunk_height: { min_inclusive: 1, max_inclusive: 2 },
    },
  }),
  mega_spruce: treeFeature({
    trunk: { type: "minecraft:giant_trunk_placer", base: 13, a: 2, b: 14 },
    log: "minecraft:spruce_log",
    leaves: "minecraft:spruce_leaves",
    foliage: {
      type: "minecraft:mega_pine_foliage_placer",
      radius: 0,
      offset: 0,
      crown_height: { min_inclusive: 13, max_inclusive: 17 },
    },
    decorators: [ALTER_GROUND_PODZOL],
  }),
  mega_pine: treeFeature({
    trunk: { type: "minecraft:giant_trunk_placer", base: 13, a: 2, b: 14 },
    log: "minecraft:spruce_log",
    leaves: "minecraft:spruce_leaves",
    foliage: {
      type: "minecraft:mega_pine_foliage_placer",
      radius: 0,
      offset: 0,
      crown_height: { min_inclusive: 3, max_inclusive: 7 },
    },
    decorators: [ALTER_GROUND_PODZOL],
  }),
  birch: treeFeature({
    trunk: { type: "minecraft:straight_trunk_placer", base: 5, a: 2, b: 0 },
    log: "minecraft:birch_log",
    leaves: "minecraft:birch_leaves",
    foliage: BLOB_FOLIAGE,
    ignoreVines: true,
  }),
  birch_bees_005: treeFeature({
    trunk: { type: "minecraft:straight_trunk_placer", base: 5, a: 2, b: 0 },
    log: "minecraft:birch_log",
    leaves: "minecraft:birch_leaves",
    foliage: BLOB_FOLIAGE,
    decorators: [BEEHIVE_005],
    ignoreVines: true,
  }),
  jungle_tree_no_vine: treeFeature({
    trunk: { type: "minecraft:straight_trunk_placer", base: 4, a: 8, b: 0 },
    log: "minecraft:jungle_log",
    leaves: "minecraft:jungle_leaves",
    foliage: BLOB_FOLIAGE,
    ignoreVines: true,
  }),
  mega_jungle_tree: treeFeature({
    trunk: { type: "minecraft:mega_jungle_trunk_placer", base: 10, a: 2, b: 19 },
    log: "minecraft:jungle_log",
    leaves: "minecraft:jungle_leaves",
    foliage: { type: "minecraft:jungle_foliage_placer", radius: 2, offset: 0, height: 2 },
    decorators: [
      { type: "minecraft:trunk_vine" },
      { type: "minecraft:leave_vine", probability: 0.25 },
      { type: "minecraft:cocoa", probability: 0.2 },
    ],
  }),
  acacia: treeFeature({
    trunk: { type: "minecraft:forking_trunk_placer", base: 5, a: 2, b: 2 },
    log: "minecraft:acacia_log",
    leaves: "minecraft:acacia_leaves",
    foliage: { type: "minecraft:acacia_foliage_placer", radius: 2, offset: 0 },
    ignoreVines: true,
  }),
  cherry: treeFeature({
    trunk: { type: "minecraft:cherry_trunk_placer", base: 7, a: 1, b: 0 },
    log: "minecraft:cherry_log",
    leaves: "minecraft:cherry_leaves",
    foliage: { type: "minecraft:cherry_foliage_placer", radius: 4, offset: 0, height: 5 },
    ignoreVines: true,
  }),
  cherry_bees_005: treeFeature({
    trunk: { type: "minecraft:cherry_trunk_placer", base: 7, a: 1, b: 0 },
    log: "minecraft:cherry_log",
    leaves: "minecraft:cherry_leaves",
    foliage: { type: "minecraft:cherry_foliage_placer", radius: 4, offset: 0, height: 5 },
    decorators: [BEEHIVE_005],
    ignoreVines: true,
  }),
  dark_oak: treeFeature({
    trunk: { type: "minecraft:dark_oak_trunk_placer", base: 6, a: 2, b: 1 },
    log: "minecraft:dark_oak_log",
    leaves: "minecraft:dark_oak_leaves",
    foliage: { type: "minecraft:dark_oak_foliage_placer", radius: 0, offset: 0 },
    ignoreVines: true,
  }),
  pale_oak_bonemeal: treeFeature({
    trunk: { type: "minecraft:dark_oak_trunk_placer", base: 6, a: 2, b: 1 },
    log: "minecraft:pale_oak_log",
    leaves: "minecraft:pale_oak_leaves",
    foliage: { type: "minecraft:dark_oak_foliage_placer", radius: 0, offset: 0 },
    ignoreVines: true,
  }),
  mangrove: treeFeature({
    trunk: { type: "minecraft:upwards_branching_trunk_placer", base: 2, a: 1, b: 4 },
    log: "minecraft:mangrove_log",
    leaves: "minecraft:mangrove_leaves",
    foliage: {
      type: "minecraft:random_spread_foliage_placer",
      radius: 3,
      offset: 0,
      foliage_height: 2,
      leaf_placement_attempts: 70,
    },
    decorators: [
      { type: "minecraft:leave_vine", probability: 0.125 },
      {
        type: "minecraft:attached_to_leaves",
        probability: 0.14,
        block_provider: { type: "minecraft:simple_state_provider", state: { Name: "minecraft:mangrove_propagule" } },
      },
      { type: "minecraft:beehive", probability: 0.01 },
    ],
    ignoreVines: true,
  }),
  tall_mangrove: treeFeature({
    trunk: { type: "minecraft:upwards_branching_trunk_placer", base: 4, a: 1, b: 9 },
    log: "minecraft:mangrove_log",
    leaves: "minecraft:mangrove_leaves",
    foliage: {
      type: "minecraft:random_spread_foliage_placer",
      radius: 3,
      offset: 0,
      foliage_height: 2,
      leaf_placement_attempts: 70,
    },
    ignoreVines: true,
  }),
  crimson_fungus: hugeFungus("crimson", false),
  crimson_fungus_planted: hugeFungus("crimson", true),
  warped_fungus: hugeFungus("warped", false),
  warped_fungus_planted: hugeFungus("warped", true),
};

const ITEM_TAGS: Record<string, string[]> = {
  // Nested so the recursive tag resolution is exercised the way the real #logs tree is built.
  logs: ["#minecraft:oak_logs", "#minecraft:crimson_stems", "minecraft:bamboo_block", "minecraft:stripped_bamboo_block"],
  oak_logs: ["minecraft:oak_log", "minecraft:stripped_oak_log", "minecraft:oak_wood", "minecraft:stripped_oak_wood"],
  crimson_stems: [
    "minecraft:crimson_stem",
    "minecraft:stripped_crimson_stem",
    "minecraft:crimson_hyphae",
    "minecraft:stripped_crimson_hyphae",
  ],
  planks: ["minecraft:oak_planks", "minecraft:bamboo_planks", "minecraft:crimson_planks", "minecraft:warped_planks"],
  wooden_slabs: ["minecraft:oak_slab", "minecraft:crimson_slab"],
  saplings: ["minecraft:oak_sapling", "minecraft:mangrove_propagule"],
  non_flammable_wood: [
    "minecraft:crimson_stem",
    "minecraft:stripped_crimson_stem",
    "minecraft:crimson_hyphae",
    "minecraft:stripped_crimson_hyphae",
    "minecraft:crimson_planks",
    "minecraft:crimson_slab",
    "minecraft:warped_planks",
  ],
};

async function writeFixture(root: string): Promise<void> {
  await writeFileAt(root, "net/minecraft/world/level/block/grower/TreeGrower.java", TREE_GROWER_SOURCE);
  await writeFileAt(root, "net/minecraft/data/worldgen/features/TreeFeatures.java", TREE_FEATURES_SOURCE);
  await writeFileAt(root, "net/minecraft/world/level/block/SaplingBlock.java", SAPLING_SOURCE);
  await writeFileAt(root, "net/minecraft/world/level/block/Blocks.java", BLOCKS_SOURCE);
  await writeFileAt(root, "net/minecraft/world/level/block/FireBlock.java", FIRE_SOURCE);
  await writeFileAt(root, "net/minecraft/world/level/block/entity/FuelValues.java", FUEL_SOURCE);
  await writeFileAt(root, "net/minecraft/world/level/block/ComposterBlock.java", COMPOSTER_SOURCE);

  for (const [key, contents] of Object.entries(CONFIGURED_FEATURES)) {
    await writeFileAt(root, `data/minecraft/worldgen/configured_feature/${key}.json`, contents);
  }
  for (const [tag, values] of Object.entries(ITEM_TAGS)) {
    await writeFileAt(root, `data/minecraft/tags/item/${tag}.json`, JSON.stringify({ values }));
  }
  for (const id of expectedBlockIds()) {
    await writeFileAt(
      root,
      `assets/minecraft/blockstates/${id}.json`,
      JSON.stringify({ variants: { "": { model: `minecraft:block/${id}` } } }),
    );
  }
  await writeFileAt(
    root,
    "assets/minecraft/lang/en_us.json",
    JSON.stringify({ "block.minecraft.oak_planks": "Oak Planks", "block.minecraft.mangrove_propagule": "Mangrove Propagule" }),
  );
}

describe("tree features extractor", () => {
  test("resolves growers, sapling mechanics, feature shapes, and per-block wood stats", async () => {
    const root = await createTempClientRoot();
    await writeFixture(root);

    const dataset = await new TreeFeaturesExtractor(createConsoleLogger(false)).extract(root);
    expect(dataset).toBeDefined();

    // Sapling mechanics are parsed, not hardcoded.
    expect(dataset?.growth).toEqual({
      lightLevelMin: 9,
      randomTickGrowthOneIn: 7,
      growthStages: 2,
      bonemealSuccessChance: 0.45,
      sourcePath: "net/minecraft/world/level/block/SaplingBlock.java",
    });

    expect(dataset?.families.map((family) => family.family)).toEqual([
      "oak",
      "spruce",
      "birch",
      "jungle",
      "acacia",
      "dark_oak",
      "mangrove",
      "cherry",
      "pale_oak",
      "bamboo",
      "crimson",
      "warped",
    ]);

    const byFamily = new Map(dataset?.families.map((family) => [family.family, family]));
    const byFeature = new Map(dataset?.features.map((feature) => [feature.key, feature]));

    // Oak: the 8-argument grower resolves all four slots and the sapling registration.
    const oak = byFamily.get("oak");
    expect(oak?.sapling).toBe("minecraft:oak_sapling");
    expect(oak?.grower).toEqual({
      name: "oak",
      secondaryChance: 0.1,
      tree: "minecraft:oak",
      secondaryTree: "minecraft:fancy_oak",
      flowers: "minecraft:oak_bees_005",
      secondaryFlowers: "minecraft:fancy_oak_bees_005",
      canBeTwoByTwo: false,
      requiresTwoByTwo: false,
    });
    expect(byFeature.get("minecraft:oak")?.trunkPlacer).toEqual({
      type: "minecraft:straight_trunk_placer",
      baseHeight: 4,
      heightRandA: 2,
      heightRandB: 0,
      minHeight: 4,
      maxHeight: 6,
    });
    expect(byFeature.get("minecraft:oak")?.foliagePlacer).toEqual({
      type: "minecraft:blob_foliage_placer",
      params: { radius: 2, offset: 0, height: 3 },
    });
    expect(byFeature.get("minecraft:oak")?.trunkBlock).toBe("minecraft:oak_log");
    expect(byFeature.get("minecraft:oak_bees_005")?.decorators).toEqual([{ type: "minecraft:beehive", probability: 0.05 }]);

    // Dark oak only has a mega variant, so a lone sapling never grows.
    const darkOak = byFamily.get("dark_oak");
    expect(darkOak?.grower).toMatchObject({
      megaTree: "minecraft:dark_oak",
      canBeTwoByTwo: true,
      requiresTwoByTwo: true,
    });
    expect(darkOak?.grower?.tree).toBeUndefined();
    expect(byFeature.get("minecraft:dark_oak")?.trunkPlacer?.type).toBe("minecraft:dark_oak_trunk_placer");
    expect(byFamily.get("pale_oak")?.grower?.requiresTwoByTwo).toBe(true);

    // Spruce keeps both mega variants behind the 0.5 secondary roll and turns the ground to podzol.
    const spruce = byFamily.get("spruce");
    expect(spruce?.grower).toMatchObject({
      secondaryChance: 0.5,
      tree: "minecraft:spruce",
      megaTree: "minecraft:mega_spruce",
      secondaryMegaTree: "minecraft:mega_pine",
      canBeTwoByTwo: true,
      requiresTwoByTwo: false,
    });
    const megaSpruce = byFeature.get("minecraft:mega_spruce");
    expect(megaSpruce?.trunkPlacer).toMatchObject({ type: "minecraft:giant_trunk_placer", baseHeight: 13, maxHeight: 29 });
    expect(megaSpruce?.decorators).toEqual([{ type: "minecraft:alter_ground", block: "minecraft:podzol" }]);
    expect(megaSpruce?.foliagePlacer?.params).toMatchObject({ crown_height_min: 13, crown_height_max: 17 });

    // Mangrove grows from a propagule, and the feature hangs propagules off its own leaves.
    expect(byFamily.get("mangrove")?.sapling).toBe("minecraft:mangrove_propagule");
    expect(byFamily.get("mangrove")?.blocks.find((block) => block.role === "propagule")).toMatchObject({
      id: "minecraft:mangrove_propagule",
      name: "Mangrove Propagule",
      compostChance: 0.3,
    });
    expect(byFeature.get("minecraft:mangrove")?.decorators).toContainEqual({
      type: "minecraft:attached_to_leaves",
      probability: 0.14,
      block: "minecraft:mangrove_propagule",
    });

    // Per-block wood stats: fuel resolves through nested item tags, flammability through FireBlock.
    const oakBlocks = new Map(oak?.blocks.map((block) => [block.role, block]));
    expect(oakBlocks.get("planks")).toEqual({
      id: "minecraft:oak_planks",
      name: "Oak Planks",
      role: "planks",
      flammable: true,
      igniteOdds: 5,
      burnOdds: 20,
      fuelTicks: 300,
    });
    expect(oakBlocks.get("log")).toMatchObject({ fuelTicks: 300, flammable: true, igniteOdds: 5, burnOdds: 5 });
    expect(oakBlocks.get("slab")?.fuelTicks).toBe(150);
    expect(oakBlocks.get("sapling")?.fuelTicks).toBe(100);
    expect(oakBlocks.get("leaves")).toMatchObject({ compostChance: 0.3, flammable: true });
    expect(oakBlocks.get("leaves")?.fuelTicks).toBeUndefined();
    expect(oak?.blocks.map((block) => block.role)).toEqual([
      "sapling",
      "log",
      "stripped_log",
      "wood",
      "stripped_wood",
      ...PLANK_ROLES,
      "leaves",
    ]);

    // Crimson: nether wood never burns and is stripped back out of the fuel table.
    const crimson = byFamily.get("crimson");
    expect(crimson?.category).toBe("nether");
    expect(crimson?.fungus).toEqual({
      block: "minecraft:crimson_fungus",
      wildFeature: "minecraft:crimson_fungus",
      plantedFeature: "minecraft:crimson_fungus_planted",
    });
    expect(crimson?.blocks.every((block) => block.flammable === false)).toBe(true);
    expect(crimson?.blocks.every((block) => block.fuelTicks === undefined)).toBe(true);
    expect(crimson?.blocks.find((block) => block.role === "fungus")?.compostChance).toBe(0.65);
    expect(byFeature.get("minecraft:crimson_fungus")).toMatchObject({
      featureType: "minecraft:huge_fungus",
      trunkBlock: "minecraft:crimson_stem",
      foliageBlock: "minecraft:nether_wart_block",
      decorBlock: "minecraft:shroomlight",
      baseBlock: "minecraft:crimson_nylium",
    });

    // Bamboo has no grower but still carries the plank set plus the mosaic blocks.
    const bamboo = byFamily.get("bamboo");
    expect(bamboo?.category).toBe("bamboo");
    expect(bamboo?.grower).toBeUndefined();
    expect(bamboo?.sapling).toBeUndefined();
    expect(bamboo?.blocks.map((block) => block.role)).toContain("mosaic_slab");
    expect(bamboo?.blocks.find((block) => block.role === "bamboo_block")?.fuelTicks).toBe(300);

    // Every grower-reachable feature (plus the four huge fungi) is summarized exactly once.
    expect(dataset?.features).toHaveLength(22);
    expect(dataset?.warnings).toEqual([]);
  });

  test("returns undefined when TreeGrower.java is absent", async () => {
    const root = await createTempClientRoot();
    expect(await new TreeFeaturesExtractor(createConsoleLogger(false)).extract(root)).toBeUndefined();
  });
});
