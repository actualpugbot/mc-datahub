import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createConsoleLogger } from "../src/core/logger.js";
import { DecompiledSourceExtractor } from "../src/extraction/sourceDerivedExtractor.js";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    Array.from(tempDirs, async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
  tempDirs.clear();
});

describe("decompiled source extractor", () => {
  test("extracts item stats from decompiled item, food, tool, and armor sources", async () => {
    const root = await createTempClientRoot();
    await writeJavaFile(
      root,
      "net/minecraft/world/item/Items.java",
      `package net.minecraft.world.item;

public class Items {
   public static final Item BREAD = registerItem("bread", new Item.Properties().food(Foods.BREAD));
   public static final Item NETHERITE_SWORD = registerItem(
      "netherite_sword", new Item.Properties().sword(ToolMaterial.NETHERITE, 3.0F, -2.4F).fireResistant()
   );
   public static final Item CHAINMAIL_HELMET = registerItem(
      "chainmail_helmet", new Item.Properties().humanoidArmor(ArmorMaterials.CHAINMAIL, ArmorType.HELMET).rarity(Rarity.UNCOMMON)
   );
   public static final Item OAK_SIGN = registerBlock(
      Blocks.OAK_SIGN, (b, p) -> new SignItem(b, Blocks.OAK_WALL_SIGN, p), new Item.Properties().stacksTo(16)
   );
   public static final Item STONE = registerBlock(Blocks.STONE);
}`,
    );
    await writeJavaFile(
      root,
      "net/minecraft/world/food/Foods.java",
      `package net.minecraft.world.food;

public class Foods {
   public static final FoodProperties BREAD = new FoodProperties.Builder().nutrition(5).saturationModifier(0.6F).build();
}`,
    );
    await writeJavaFile(
      root,
      "net/minecraft/world/item/ToolMaterial.java",
      `package net.minecraft.world.item;

public record ToolMaterial(Object incorrect, int durability, float speed, float attackDamageBonus, int enchantmentValue, Object repairs) {
   public static final ToolMaterial NETHERITE = new ToolMaterial(null, 2031, 9.0F, 4.0F, 15, null);
}`,
    );
    await writeJavaFile(
      root,
      "net/minecraft/world/item/equipment/ArmorMaterials.java",
      `package net.minecraft.world.item.equipment;

public interface ArmorMaterials {
   ArmorMaterial CHAINMAIL = new ArmorMaterial(15, makeDefense(1, 4, 5, 2, 4), 12, null, 0.0F, 0.0F, null, null);
}`,
    );
    await writeJavaFile(
      root,
      "net/minecraft/world/item/equipment/ArmorType.java",
      `package net.minecraft.world.item.equipment;

public enum ArmorType {
   HELMET(null, 11, "helmet"),
   CHESTPLATE(null, 16, "chestplate"),
   LEGGINGS(null, 15, "leggings"),
   BOOTS(null, 13, "boots"),
   BODY(null, 16, "body");
}`,
    );

    const result = await new DecompiledSourceExtractor(createConsoleLogger(false)).extract(root);

    expect(result.itemStats.find((entry) => entry.id === "minecraft:bread")).toMatchObject({
      id: "minecraft:bread",
      stackSize: 64,
      rarity: "common",
      fireResistant: false,
      food: {
        reference: "bread",
        nutrition: 5,
        saturationModifier: 0.6,
        alwaysEdible: false,
      },
    });
    expect(result.itemStats.find((entry) => entry.id === "minecraft:netherite_sword")).toMatchObject({
      id: "minecraft:netherite_sword",
      stackSize: 1,
      durability: 2031,
      fireResistant: true,
      tool: {
        kind: "sword",
        material: "netherite",
        durability: 2031,
        miningSpeed: 9,
        enchantability: 15,
        attackDamage: 7,
        attackSpeed: -2.4,
      },
    });
    expect(result.itemStats.find((entry) => entry.id === "minecraft:chainmail_helmet")).toMatchObject({
      id: "minecraft:chainmail_helmet",
      stackSize: 1,
      rarity: "uncommon",
      armor: {
        category: "humanoid",
        material: "chainmail",
        type: "helmet",
        durability: 165,
        defense: 2,
        enchantability: 12,
      },
    });
    expect(result.itemStats.find((entry) => entry.id === "minecraft:oak_sign")?.stackSize).toBe(16);
    expect(result.itemStats.find((entry) => entry.id === "minecraft:stone")?.registration).toBe("block");
  });

  test("extracts block properties from direct and helper-based property chains", async () => {
    const root = await createTempClientRoot();
    await writeJavaFile(
      root,
      "net/minecraft/world/level/block/Blocks.java",
      `package net.minecraft.world.level.block;

public class Blocks {
   public static final Block STONE = register(
      "stone",
      BlockBehaviour.Properties.of().mapColor(MapColor.STONE).requiresCorrectToolForDrops().strength(1.5F, 6.0F).sound(SoundType.STONE)
   );
   public static final Block DEEPSLATE_GOLD_ORE = register(
      "deepslate_gold_ore",
      BlockBehaviour.Properties.ofLegacyCopy(GOLD_ORE).mapColor(MapColor.DEEPSLATE).strength(4.5F, 3.0F).sound(SoundType.DEEPSLATE)
   );
   public static final Block POTTED_FLOWER = register(
      "potted_flower", p -> new FlowerPotBlock(RED_FLOWER, p), flowerPotProperties().randomTicks()
   );
   public static final Block WALL_TORCH = register(
      "wall_torch", wallVariant(TORCH, true).noCollision().instabreak().lightLevel(statex -> 14).sound(SoundType.WOOD).pushReaction(PushReaction.DESTROY)
   );

   private static BlockBehaviour.Properties flowerPotProperties() {
      return BlockBehaviour.Properties.of().instabreak().noOcclusion().pushReaction(PushReaction.DESTROY);
   }

   private static BlockBehaviour.Properties wallVariant(final Block standingBlock, final boolean copyName) {
      return BlockBehaviour.Properties.of();
   }

   private static Block register(final String id, final BlockBehaviour.Properties properties) {
      return null;
   }

   private static Block register(final String id, final java.util.function.Function<BlockBehaviour.Properties, Block> factory, final BlockBehaviour.Properties properties) {
      return null;
   }
}`,
    );

    const result = await new DecompiledSourceExtractor(createConsoleLogger(false)).extract(root);

    expect(result.blockProperties.find((entry) => entry.id === "minecraft:stone")).toMatchObject({
      id: "minecraft:stone",
      destroyTime: 1.5,
      explosionResistance: 6,
      requiresCorrectToolForDrops: true,
      mapColor: "stone",
      soundType: "stone",
    });
    expect(result.blockProperties.find((entry) => entry.id === "minecraft:deepslate_gold_ore")).toMatchObject({
      id: "minecraft:deepslate_gold_ore",
      copiedFrom: "minecraft:gold_ore",
      destroyTime: 4.5,
      explosionResistance: 3,
      mapColor: "deepslate",
      soundType: "deepslate",
    });
    expect(result.blockProperties.find((entry) => entry.id === "minecraft:potted_flower")).toMatchObject({
      id: "minecraft:potted_flower",
      randomTicks: true,
      pushReaction: "destroy",
      destroyTime: 0,
    });
    expect(result.blockProperties.find((entry) => entry.id === "minecraft:wall_torch")).toMatchObject({
      id: "minecraft:wall_torch",
      noCollision: true,
      pushReaction: "destroy",
      lightEmission: {
        kind: "constant",
        value: 14,
      },
      destroyTime: 0,
    });
  });

  test("resolves 26.2 reference ids and corrects symbol/id mismatches", async () => {
    const root = await createTempClientRoot();
    await writeReferenceClasses(root);
    await writeJavaFile(
      root,
      "net/minecraft/world/level/block/Blocks.java",
      `package net.minecraft.world.level.block;

public class Blocks {
   public static final Block STONE = register(
      BlockItemIds.STONE,
      BlockBehaviour.Properties.of().mapColor(MapColor.STONE).requiresCorrectToolForDrops().strength(1.5F, 6.0F).sound(SoundType.STONE)
   );
   public static final Block POTTED_AZALEA = register(
      BlockIds.POTTED_AZALEA_BUSH, p -> new FlowerPotBlock(AZALEA, p), BlockBehaviour.Properties.of().instabreak().noOcclusion()
   );

   private static Block register(final Object id, final BlockBehaviour.Properties properties) {
      return null;
   }

   private static Block register(final Object id, final Object factory, final BlockBehaviour.Properties properties) {
      return null;
   }
}`,
    );
    await writeJavaFile(
      root,
      "net/minecraft/world/item/Items.java",
      `package net.minecraft.world.item;

public class Items {
   public static final Item STONE = registerBlock(BlockItemIds.STONE, Blocks.STONE);
   public static final Item BEETROOT = registerItem(BlockItemIds.BEETROOT_CROP.item(), new Item.Properties().food(Foods.BEETROOT));
}`,
    );

    const result = await new DecompiledSourceExtractor(createConsoleLogger(false)).extract(root);

    // BlockIds.POTTED_AZALEA_BUSH resolves the registered id even though the Java symbol is POTTED_AZALEA.
    expect(result.blockProperties.find((entry) => entry.id === "minecraft:potted_azalea_bush")).toMatchObject({
      id: "minecraft:potted_azalea_bush",
      destroyTime: 0,
    });
    expect(result.blockProperties.some((entry) => entry.id === "minecraft:potted_azalea")).toBe(false);
    expect(result.blockProperties.find((entry) => entry.id === "minecraft:stone")?.destroyTime).toBe(1.5);
    // BlockItemId.create("beetroots", "beetroot_seeds") -> the item id is the second argument.
    expect(result.itemStats.some((entry) => entry.id === "minecraft:beetroot_seeds")).toBe(true);
    expect(result.itemStats.some((entry) => entry.id === "minecraft:beetroot_crop")).toBe(false);
  });

  test("expands ColorCollection block registrations with per-color map colors", async () => {
    const root = await createTempClientRoot();
    await writeReferenceClasses(root);
    await writeJavaFile(root, "net/minecraft/world/item/DyeColor.java", dyeColorSource());
    await writeJavaFile(
      root,
      "net/minecraft/world/level/block/Blocks.java",
      `package net.minecraft.world.level.block;

public class Blocks {
   public static final ColorCollection<Block> WOOL = ColorCollection.registerBlocks(
      BlockItemIds.WOOL,
      Blocks::register,
      (var0, p) -> new Block(p),
      color -> BlockBehaviour.Properties.of()
         .mapColor(color.getMapColor())
         .instrument(NoteBlockInstrument.GUITAR)
         .strength(0.8F)
         .sound(SoundType.WOOL)
         .ignitedByLava()
   );
   public static final ColorCollection<Block> DYED_TERRACOTTA = ColorCollection.registerBlocks(
      BlockItemIds.DYED_TERRACOTTA,
      Blocks::register,
      (var0, p) -> new Block(p),
      color -> BlockBehaviour.Properties.of().mapColor(color.getTerracottaColor()).requiresCorrectToolForDrops().strength(1.25F, 4.2F)
   );

   private static Block register(final Object id, final Object factory, final BlockBehaviour.Properties properties) {
      return null;
   }
}`,
    );

    const result = await new DecompiledSourceExtractor(createConsoleLogger(false)).extract(root);
    const wool = result.blockProperties.filter((entry) => entry.id.endsWith("_wool"));

    expect(wool).toHaveLength(16);
    expect(result.blockProperties.find((entry) => entry.id === "minecraft:white_wool")).toMatchObject({
      id: "minecraft:white_wool",
      sourceSymbol: "WHITE_WOOL",
      destroyTime: 0.8,
      soundType: "wool",
      instrument: "guitar",
      ignitedByLava: true,
      // distinctive map color proves the value came from the parsed DyeColor.java, not the fallback table.
      mapColor: "quartz",
    });
    expect(result.blockProperties.find((entry) => entry.id === "minecraft:red_wool")?.mapColor).toBe("color_red");
    expect(result.blockProperties.find((entry) => entry.id === "minecraft:white_terracotta")).toMatchObject({
      destroyTime: 1.25,
      explosionResistance: 4.2,
      requiresCorrectToolForDrops: true,
      mapColor: "terracotta_white",
    });
  });

  test("expands WeatheringCopperCollection block registrations across weather/wax states", async () => {
    const root = await createTempClientRoot();
    await writeReferenceClasses(root);
    await writeJavaFile(
      root,
      "net/minecraft/world/level/block/Blocks.java",
      `package net.minecraft.world.level.block;

public class Blocks {
   public static final WeatheringCopperCollection<Block> CUT_COPPER = WeatheringCopperCollection.registerBlocks(
      BlockItemIds.CUT_COPPER,
      Blocks::register,
      (s, p) -> new Block(p),
      WeatheringCopperFullBlock::new,
      p -> BlockBehaviour.Properties.of().requiresCorrectToolForDrops().strength(3.0F, 6.0F).sound(SoundType.COPPER)
   );

   private static Block register(final Object id, final Object factory, final BlockBehaviour.Properties properties) {
      return null;
   }
}`,
    );

    const result = await new DecompiledSourceExtractor(createConsoleLogger(false)).extract(root);
    const cutCopper = result.blockProperties.filter((entry) => entry.id.includes("cut_copper"));

    expect(cutCopper).toHaveLength(8);
    for (const id of ["minecraft:cut_copper", "minecraft:exposed_cut_copper", "minecraft:waxed_cut_copper", "minecraft:waxed_oxidized_cut_copper"]) {
      expect(result.blockProperties.find((entry) => entry.id === id)).toMatchObject({
        destroyTime: 3,
        explosionResistance: 6,
        requiresCorrectToolForDrops: true,
        soundType: "copper",
      });
    }
  });

  test("resolves per-state copiedFrom for copy-based copper families", async () => {
    const root = await createTempClientRoot();
    await writeReferenceClasses(root);
    await writeJavaFile(
      root,
      "net/minecraft/world/level/block/Blocks.java",
      `package net.minecraft.world.level.block;

public class Blocks {
   public static final WeatheringCopperCollection<Block> COPPER_BLOCK = WeatheringCopperCollection.registerBlocks(
      BlockItemIds.COPPER_BLOCK,
      Blocks::register,
      (var0, p) -> new Block(p),
      WeatheringCopperFullBlock::new,
      statex -> BlockBehaviour.Properties.of().requiresCorrectToolForDrops().strength(3.0F, 6.0F).sound(SoundType.COPPER)
   );
   public static final WeatheringCopperCollection<Block> CUT_COPPER = WeatheringCopperCollection.registerBlocks(
      BlockItemIds.CUT_COPPER,
      Blocks::register,
      (var0, p) -> new Block(p),
      WeatheringCopperFullBlock::new,
      statex -> BlockBehaviour.Properties.ofFullCopy(COPPER_BLOCK.weathering().pick(statex))
   );

   private static Block register(final Object id, final Object factory, final BlockBehaviour.Properties properties) {
      return null;
   }
}`,
    );

    const result = await new DecompiledSourceExtractor(createConsoleLogger(false)).extract(root);

    // The base copper family carries the real properties...
    expect(result.blockProperties.find((entry) => entry.id === "minecraft:copper")?.destroyTime).toBe(3);
    // ...and each cut_copper variant records the per-state block it copies from.
    expect(result.blockProperties.find((entry) => entry.id === "minecraft:cut_copper")?.copiedFrom).toBe("minecraft:copper");
    expect(result.blockProperties.find((entry) => entry.id === "minecraft:exposed_cut_copper")?.copiedFrom).toBe("minecraft:exposed_copper");
    expect(result.blockProperties.find((entry) => entry.id === "minecraft:waxed_oxidized_cut_copper")?.copiedFrom).toBe("minecraft:oxidized_copper");
  });

  test("resolves per-weather-state copper map colors, instruments, and light levels", async () => {
    const root = await createTempClientRoot();
    await writeReferenceClasses(root);
    await writeJavaFile(
      root,
      "net/minecraft/world/level/block/Blocks.java",
      `package net.minecraft.world.level.block;

public class Blocks {
   public static final WeatheringCopperCollection<Block> COPPER_BLOCK = WeatheringCopperCollection.registerBlocks(
      BlockItemIds.COPPER_BLOCK, Blocks::register, (var0, p) -> new Block(p), WeatheringCopperFullBlock::new, statex -> {
         BlockBehaviour.Properties var10000 = BlockBehaviour.Properties.of();
         MapColor var10001 = switch (statex) {
            case UNAFFECTED -> MapColor.COLOR_ORANGE;
            case EXPOSED -> MapColor.TERRACOTTA_LIGHT_GRAY;
            case WEATHERED -> MapColor.WARPED_STEM;
            case OXIDIZED -> MapColor.WARPED_NYLIUM;
         };
         return var10000.mapColor(var10001).requiresCorrectToolForDrops().strength(3.0F, 6.0F).instrument(switch (statex) {
            case UNAFFECTED -> NoteBlockInstrument.TRUMPET;
            case EXPOSED -> NoteBlockInstrument.TRUMPET_EXPOSED;
            case WEATHERED -> NoteBlockInstrument.TRUMPET_WEATHERED;
            case OXIDIZED -> NoteBlockInstrument.TRUMPET_OXIDIZED;
         }).sound(SoundType.COPPER);
      }
   );
   public static final WeatheringCopperCollection<Block> COPPER_GRATE = WeatheringCopperCollection.registerBlocks(
      BlockItemIds.COPPER_GRATE,
      Blocks::register,
      (var0, p) -> new WaterloggedTransparentBlock(p),
      WeatheringCopperGrateBlock::new,
      statex -> BlockBehaviour.Properties.of()
         .strength(3.0F, 6.0F)
         .sound(SoundType.COPPER_GRATE)
         .mapColor(var1x -> COPPER_BLOCK.weathering().pick(statex).defaultMapColor())
         .requiresCorrectToolForDrops()
   );

   private static Block register(final Object id, final Object factory, final BlockBehaviour.Properties properties) {
      return null;
   }
}`,
    );

    const result = await new DecompiledSourceExtractor(createConsoleLogger(false)).extract(root);

    // copper_block carries the per-state map color / instrument directly from the switch.
    expect(result.blockProperties.find((entry) => entry.id === "minecraft:copper")).toMatchObject({
      mapColor: "color_orange",
      instrument: "trumpet",
      destroyTime: 3,
    });
    expect(result.blockProperties.find((entry) => entry.id === "minecraft:weathered_copper")).toMatchObject({
      mapColor: "warped_stem",
      instrument: "trumpet_weathered",
    });
    // Waxed variants share the unwaxed state's map color/instrument.
    expect(result.blockProperties.find((entry) => entry.id === "minecraft:waxed_oxidized_copper")).toMatchObject({
      mapColor: "warped_nylium",
      instrument: "trumpet_oxidized",
    });
    // copper_grate references COPPER_BLOCK's per-state map color via defaultMapColor().
    expect(result.blockProperties.find((entry) => entry.id === "minecraft:copper_grate")?.mapColor).toBe("color_orange");
    expect(result.blockProperties.find((entry) => entry.id === "minecraft:oxidized_copper_grate")?.mapColor).toBe("warped_nylium");
  });

  test("inherits properties from ofFullCopy/ofLegacyCopy sources, including helper-registered blocks", async () => {
    const root = await createTempClientRoot();
    await writeReferenceClasses(root);
    await writeJavaFile(
      root,
      "net/minecraft/world/level/block/Blocks.java",
      `package net.minecraft.world.level.block;

public class Blocks {
   public static final Block STONE = register(
      BlockItemIds.STONE,
      BlockBehaviour.Properties.of().mapColor(MapColor.STONE).requiresCorrectToolForDrops().strength(1.5F, 6.0F).sound(SoundType.STONE)
   );
   public static final Block STONE_SLAB = registerSlab(BlockItemIds.STONE_SLAB, STONE);
   public static final Block STONE_STAIRS = registerLegacyStair(BlockItemIds.STONE_STAIRS, STONE);
   public static final Block DEEPSLATE_VARIANT = register(
      BlockItemIds.DEEPSLATE_VARIANT,
      BlockBehaviour.Properties.ofLegacyCopy(STONE).strength(4.5F, 3.0F).sound(SoundType.DEEPSLATE)
   );

   private static Block registerSlab(final BlockItemId id, final Block base) {
      return register(id, SlabBlock::new, BlockBehaviour.Properties.ofLegacyCopy(base));
   }

   private static Block registerLegacyStair(final BlockItemId id, final Block base) {
      return register(id.block(), p -> new StairBlock(base.defaultBlockState(), p), BlockBehaviour.Properties.ofLegacyCopy(base));
   }

   private static Block register(final Object id, final BlockBehaviour.Properties properties) {
      return null;
   }

   private static Block register(final Object id, final Object factory, final BlockBehaviour.Properties properties) {
      return null;
   }
}`,
    );

    const result = await new DecompiledSourceExtractor(createConsoleLogger(false)).extract(root);
    const find = (id: string) => result.blockProperties.find((entry) => entry.id === id);

    // Helper-registered slab/stairs resolve the copy source to the real base block
    // (not the literal `base` parameter) and inherit its physical properties.
    expect(find("minecraft:stone_slab")).toMatchObject({
      copiedFrom: "minecraft:stone",
      destroyTime: 1.5,
      explosionResistance: 6,
      requiresCorrectToolForDrops: true,
      soundType: "stone",
      mapColor: "stone",
    });
    expect(find("minecraft:stone_stairs")).toMatchObject({
      copiedFrom: "minecraft:stone",
      destroyTime: 1.5,
      explosionResistance: 6,
      requiresCorrectToolForDrops: true,
    });
    // Explicit overrides win; only the unset fields (here requiresCorrectToolForDrops and
    // mapColor) are inherited from the copied block.
    expect(find("minecraft:deepslate_variant")).toMatchObject({
      copiedFrom: "minecraft:stone",
      destroyTime: 4.5,
      explosionResistance: 3,
      soundType: "deepslate",
      requiresCorrectToolForDrops: true,
      mapColor: "stone",
    });
  });

  test("expands collection blocks declared through property-helper methods", async () => {
    const root = await createTempClientRoot();
    await writeReferenceClasses(root);
    await writeJavaFile(
      root,
      "net/minecraft/world/level/block/Blocks.java",
      `package net.minecraft.world.level.block;

public class Blocks {
   public static final ColorCollection<Block> DYED_SHULKER_BOX = ColorCollection.registerBlocks(
      BlockItemIds.DYED_SHULKER_BOX,
      Blocks::register,
      ShulkerBoxBlock::new,
      color -> shulkerBoxProperties(color == DyeColor.PURPLE ? MapColor.TERRACOTTA_PURPLE : color.getMapColor())
   );

   private static BlockBehaviour.Properties shulkerBoxProperties(final MapColor mapColor) {
      return BlockBehaviour.Properties.of()
         .mapColor(mapColor)
         .forceSolidOn()
         .strength(2.0F)
         .dynamicShape()
         .noOcclusion()
         .pushReaction(PushReaction.DESTROY);
   }

   private static Block register(final Object id, final Object factory, final BlockBehaviour.Properties properties) {
      return null;
   }
}`,
    );

    const result = await new DecompiledSourceExtractor(createConsoleLogger(false)).extract(root);
    const shulkerBoxes = result.blockProperties.filter((entry) => entry.id.endsWith("_shulker_box"));

    expect(shulkerBoxes).toHaveLength(16);
    expect(result.blockProperties.find((entry) => entry.id === "minecraft:white_shulker_box")).toMatchObject({
      destroyTime: 2,
      pushReaction: "destroy",
    });
  });

  test("expands ColorCollection and WeatheringCopperCollection item registrations", async () => {
    const root = await createTempClientRoot();
    await writeReferenceClasses(root);
    await writeJavaFile(
      root,
      "net/minecraft/world/item/Items.java",
      `package net.minecraft.world.item;

public class Items {
   public static final ColorCollection<Item> WOOL = ColorCollection.registerBlockItems(
      BlockItemIds.WOOL, Blocks.WOOL, (id, block, var2) -> registerBlock(id, block)
   );
   public static final ColorCollection<Item> DYED_SHULKER_BOX = ColorCollection.registerBlockItems(
      BlockItemIds.DYED_SHULKER_BOX,
      Blocks.DYED_SHULKER_BOX,
      (id, block, var2) -> registerBlock(id, block, new Item.Properties().stacksTo(1))
   );
   public static final ColorCollection<Item> DYE = ColorCollection.registerItems(
      ItemIds.DYE, (id, color) -> registerItem(id, DyeItem::new, new Item.Properties())
   );
   public static final WeatheringCopperCollection<Item> CUT_COPPER = WeatheringCopperCollection.registerItems(
      BlockItemIds.CUT_COPPER, Blocks.CUT_COPPER, Items::registerBlock
   );
}`,
    );

    const result = await new DecompiledSourceExtractor(createConsoleLogger(false)).extract(root);

    expect(result.itemStats.filter((entry) => entry.id.endsWith("_wool"))).toHaveLength(16);
    expect(result.itemStats.find((entry) => entry.id === "minecraft:white_wool")).toMatchObject({
      registration: "block",
      stackSize: 64,
    });
    expect(result.itemStats.find((entry) => entry.id === "minecraft:white_shulker_box")).toMatchObject({
      registration: "block",
      stackSize: 1,
    });
    expect(result.itemStats.find((entry) => entry.id === "minecraft:white_dye")).toMatchObject({
      registration: "item",
      stackSize: 64,
    });
    expect(result.itemStats.filter((entry) => entry.id.includes("cut_copper"))).toHaveLength(8);
    expect(result.itemStats.find((entry) => entry.id === "minecraft:waxed_exposed_cut_copper")?.registration).toBe("block");
  });
});

async function createTempClientRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mc-datahub-source-derived-"));
  tempDirs.add(root);
  return root;
}

async function writeJavaFile(root: string, relativePath: string, contents: string): Promise<void> {
  const absolutePath = join(root, relativePath);
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, contents, "utf8");
}

// Minimal 26.2-style reference id classes. Block/item registrations reference these
// symbols instead of inline string literals, and the color/copper collections expand
// to their concrete ids through the createSimpleColored/createSimpleCopper helpers.
async function writeReferenceClasses(root: string): Promise<void> {
  await writeJavaFile(
    root,
    "net/minecraft/references/BlockItemIds.java",
    `package net.minecraft.references;

public class BlockItemIds {
   public static final BlockItemId STONE = BlockItemId.create("stone");
   public static final BlockItemId STONE_SLAB = BlockItemId.create("stone_slab");
   public static final BlockItemId STONE_STAIRS = BlockItemId.create("stone_stairs");
   public static final BlockItemId DEEPSLATE_VARIANT = BlockItemId.create("deepslate_variant");
   public static final BlockItemId BEETROOT_CROP = BlockItemId.create("beetroots", "beetroot_seeds");
   public static final ColorCollection<BlockItemId> WOOL = createSimpleColored("wool");
   public static final ColorCollection<BlockItemId> DYED_TERRACOTTA = createSimpleColored("terracotta");
   public static final ColorCollection<BlockItemId> DYED_SHULKER_BOX = createSimpleColored("shulker_box");
   public static final WeatheringCopperCollection<BlockItemId> COPPER_BLOCK = createSimpleCopper("copper");
   public static final WeatheringCopperCollection<BlockItemId> COPPER_GRATE = createSimpleCopper("copper_grate");
   public static final WeatheringCopperCollection<BlockItemId> CUT_COPPER = createSimpleCopper("cut_copper");

   private static ColorCollection<BlockItemId> createSimpleColored(final String baseName) {
      return ColorCollection.prefixWithColor(ColorCollection.create(baseName)).map(BlockItemId::create);
   }

   private static WeatheringCopperCollection<BlockItemId> createSimpleCopper(final String baseName) {
      return WeatheringCopperCollection.prefixWithState(WeatheringCopperCollection.create(baseName)).map(BlockItemId::create);
   }
}`,
  );
  await writeJavaFile(
    root,
    "net/minecraft/references/BlockIds.java",
    `package net.minecraft.references;

public class BlockIds {
   public static final ResourceKey<Block> POTTED_AZALEA_BUSH = create("potted_azalea_bush");

   private static ResourceKey<Block> create(final String name) {
      return ResourceKey.create(Registries.BLOCK, Identifier.withDefaultNamespace(name));
   }
}`,
  );
  await writeJavaFile(
    root,
    "net/minecraft/references/ItemIds.java",
    `package net.minecraft.references;

public class ItemIds {
   public static final ColorCollection<ResourceKey<Item>> DYE = createSimpleColored("dye");

   private static ResourceKey<Item> create(final String name) {
      return ResourceKey.create(Registries.ITEM, Identifier.withDefaultNamespace(name));
   }

   private static ColorCollection<ResourceKey<Item>> createSimpleColored(final String baseName) {
      return ColorCollection.prefixWithColor(ColorCollection.create(baseName)).map(ItemIds::create);
   }
}`,
  );
}

function dyeColorSource(): string {
  // WHITE uses a deliberately atypical map color (QUARTZ) so tests can prove the value
  // came from parsing this file rather than the extractor's fallback color table.
  const entries: Array<[string, string, string]> = [
    ["white", "QUARTZ", "TERRACOTTA_WHITE"],
    ["orange", "COLOR_ORANGE", "TERRACOTTA_ORANGE"],
    ["magenta", "COLOR_MAGENTA", "TERRACOTTA_MAGENTA"],
    ["light_blue", "COLOR_LIGHT_BLUE", "TERRACOTTA_LIGHT_BLUE"],
    ["yellow", "COLOR_YELLOW", "TERRACOTTA_YELLOW"],
    ["lime", "COLOR_LIGHT_GREEN", "TERRACOTTA_LIGHT_GREEN"],
    ["pink", "COLOR_PINK", "TERRACOTTA_PINK"],
    ["gray", "COLOR_GRAY", "TERRACOTTA_GRAY"],
    ["light_gray", "COLOR_LIGHT_GRAY", "TERRACOTTA_LIGHT_GRAY"],
    ["cyan", "COLOR_CYAN", "TERRACOTTA_CYAN"],
    ["purple", "COLOR_PURPLE", "TERRACOTTA_PURPLE"],
    ["blue", "COLOR_BLUE", "TERRACOTTA_BLUE"],
    ["brown", "COLOR_BROWN", "TERRACOTTA_BROWN"],
    ["green", "COLOR_GREEN", "TERRACOTTA_GREEN"],
    ["red", "COLOR_RED", "TERRACOTTA_RED"],
    ["black", "COLOR_BLACK", "TERRACOTTA_BLACK"],
  ];
  const lines = entries.map(
    ([name, mapColor, terracotta], index) =>
      `   ${name.toUpperCase()}(${index}, "${name}", ${1000 + index}, MapColor.${mapColor}, MapColor.${terracotta}, 1, 2),`,
  );
  lines[lines.length - 1] = lines[lines.length - 1]!.replace(/,$/, ";");

  return `package net.minecraft.world.item;

public enum DyeColor {
${lines.join("\n")}
}`;
}
