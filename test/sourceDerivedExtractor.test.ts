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

  test("derives armor durability from the parsed ArmorType base values, not hard-coded defaults", async () => {
    const root = await createTempClientRoot();
    await writeJavaFile(
      root,
      "net/minecraft/world/item/Items.java",
      `package net.minecraft.world.item;

public class Items {
   public static final Item CHAINMAIL_HELMET = registerItem(
      "chainmail_helmet", new Item.Properties().humanoidArmor(ArmorMaterials.CHAINMAIL, ArmorType.HELMET)
   );
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
    // HELMET base durability here (25) differs from DEFAULT_ARMOR_DURABILITY.helmet (11).
    await writeJavaFile(
      root,
      "net/minecraft/world/item/equipment/ArmorType.java",
      `package net.minecraft.world.item.equipment;

public enum ArmorType {
   HELMET(null, 25, "helmet"),
   CHESTPLATE(null, 16, "chestplate"),
   LEGGINGS(null, 15, "leggings"),
   BOOTS(null, 13, "boots"),
   BODY(null, 16, "body");
}`,
    );

    const result = await new DecompiledSourceExtractor(createConsoleLogger(false)).extract(root);

    // durabilityMultiplier (15) * parsed helmet base (25) = 375, not the default-derived 15 * 11 = 165.
    expect(result.itemStats.find((entry) => entry.id === "minecraft:chainmail_helmet")?.armor?.durability).toBe(375);
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
