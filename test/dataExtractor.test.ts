import { deflateSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { InMemoryArchiveSource } from "../src/archive/archiveSource.js";
import { createConsoleLogger } from "../src/core/logger.js";
import { MinecraftDataExtractor } from "../src/extraction/dataExtractor.js";

describe("data extractor", () => {
  test("normalizes blocks, items, recipes, textures, models, and palettes", async () => {
    const archive = new InMemoryArchiveSource({
      "assets/minecraft/blockstates/oak_planks.json": JSON.stringify({
        variants: {
          "": {
            model: "block/oak_planks",
          },
        },
      }),
      "assets/minecraft/models/block/oak_planks.json": JSON.stringify({
        textures: {
          all: "block/oak_planks",
        },
      }),
      "assets/minecraft/models/item/stick.json": JSON.stringify({
        parent: "item/generated",
        textures: {
          layer0: "item/stick",
        },
      }),
      "assets/minecraft/items/stick.json": JSON.stringify({
        model: {
          type: "minecraft:model",
          model: "minecraft:item/stick",
        },
      }),
      "assets/minecraft/models/item/generated.json": JSON.stringify({
        textures: {},
      }),
      "assets/minecraft/textures/block/oak_planks.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      "assets/minecraft/textures/item/stick.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      "assets/minecraft/textures/trims/color_palettes/amethyst.png": createRgbPng([
        [201, 143, 243],
        [154, 92, 198],
        [108, 73, 170],
        [82, 54, 135],
        [66, 39, 118],
        [54, 28, 106],
        [36, 12, 83],
        [23, 6, 59],
      ]),
      "assets/minecraft/textures/trims/color_palettes/copper.png": createRgbPng([
        [227, 130, 108],
        [180, 104, 77],
        [154, 71, 44],
        [121, 60, 40],
        [109, 52, 32],
        [95, 43, 24],
        [76, 32, 16],
        [61, 24, 11],
      ]),
      "assets/minecraft/textures/trims/color_palettes/gold.png": createRgbPng([
        [255, 253, 144],
        [236, 217, 63],
        [222, 177, 45],
        [177, 103, 18],
        [160, 69, 10],
        [128, 53, 3],
        [113, 45, 0],
        [87, 35, 0],
      ]),
      "assets/minecraft/textures/trims/color_palettes/quartz.png": createRgbPng([
        [242, 239, 237],
        [246, 234, 223],
        [227, 219, 196],
        [182, 173, 150],
        [144, 142, 128],
        [101, 97, 86],
        [69, 67, 60],
        [42, 40, 34],
      ]),
      "assets/minecraft/textures/trims/color_palettes/trim_palette.png": createGrayscalePng([224, 192, 160, 128, 96, 64, 32, 0]),
      "assets/minecraft/textures/colormap/grass.png": createRgbPng([
        [94, 200, 64],
        [105, 197, 73],
        [115, 194, 84],
        [124, 191, 93],
        [132, 189, 102],
        [138, 187, 110],
        [142, 185, 118],
        [144, 183, 125],
      ]),
      "data/minecraft/recipes/stick.json": JSON.stringify({
        type: "minecraft:crafting_shaped",
        pattern: ["#", "#"],
        key: {
          "#": {
            item: "minecraft:oak_planks",
          },
        },
        result: {
          item: "minecraft:stick",
          count: 4,
        },
      }),
      "data/minecraft/tags/blocks/planks.json": JSON.stringify({
        replace: false,
        values: ["minecraft:oak_planks"],
      }),
      "data/minecraft/tags/items/sticks.json": JSON.stringify({
        replace: false,
        values: ["minecraft:stick"],
      }),
    });

    const dataset = await new MinecraftDataExtractor(createConsoleLogger(false)).extract("1.21.5", [archive]);

    expect(dataset.blocks[0]?.id).toBe("minecraft:oak_planks");
    expect(dataset.blocks[0]?.tags).toContain("minecraft:planks");
    expect(dataset.blocks[0]?.textureRefs).toContain("minecraft:block/oak_planks");

    expect(dataset.items[0]?.id).toBe("minecraft:stick");
    expect(dataset.items[0]?.clientItemPath).toBe("assets/minecraft/items/stick.json");
    expect(dataset.items[0]?.recipeIds).toContain("minecraft:stick");
    expect(dataset.items[0]?.tags).toContain("minecraft:sticks");

    expect(dataset.recipes[0]?.result?.item).toBe("minecraft:stick");
    expect(dataset.textures.map((texture) => texture.id)).toEqual([
      "minecraft:block/oak_planks",
      "minecraft:colormap/grass",
      "minecraft:item/stick",
      "minecraft:trims/color_palettes/amethyst",
      "minecraft:trims/color_palettes/copper",
      "minecraft:trims/color_palettes/gold",
      "minecraft:trims/color_palettes/quartz",
      "minecraft:trims/color_palettes/trim_palette",
    ]);
    expect(dataset.textures.find((texture) => texture.id === "minecraft:block/oak_planks")?.imagePath).toBe(
      "images/block/oak_planks.png",
    );
    expect(dataset.textures.find((texture) => texture.id === "minecraft:trims/color_palettes/amethyst")?.imagePath).toBe(
      "images/trims/color_palettes/amethyst.png",
    );

    const amethystExtracted = dataset.palettes.find((palette) => palette.id === "minecraft:palette/extracted/trim/amethyst");
    expect(amethystExtracted?.colors).toEqual([
      "#c98ff3",
      "#9a5cc6",
      "#6c49aa",
      "#523687",
      "#422776",
      "#361c6a",
      "#240c53",
      "#17063b",
    ]);
    expect(dataset.palettes.some((palette) => palette.id === "minecraft:palette/curated/material/amethyst-radiance")).toBe(true);
    expect(dataset.palettes.some((palette) => palette.id === "minecraft:palette/curated/fusion/amethyst-copper")).toBe(true);
    expect(dataset.palettes.some((palette) => palette.id === "minecraft:palette/curated/biome/sunlit-meadow")).toBe(true);
  });

  test("reads recipes from singular recipe directories used by bundled jars", async () => {
    const archive = new InMemoryArchiveSource({
      "data/minecraft/recipe/stick.json": JSON.stringify({
        type: "minecraft:crafting_shaped",
        pattern: ["#", "#"],
        key: {
          "#": {
            item: "minecraft:oak_planks",
          },
        },
        result: {
          item: "minecraft:stick",
          count: 4,
        },
      }),
    });

    const dataset = await new MinecraftDataExtractor(createConsoleLogger(false)).extract("26.1.1", [archive]);

    expect(dataset.recipes).toHaveLength(1);
    expect(dataset.recipes[0]).toMatchObject({
      id: "minecraft:stick",
      type: "minecraft:crafting_shaped",
      ingredients: ["minecraft:oak_planks"],
      result: {
        item: "minecraft:stick",
        count: 4,
      },
    });
  });

  test("extracts enchantments, tags, loot tables, advancements, and translations", async () => {
    const archive = new InMemoryArchiveSource({
      "data/minecraft/enchantment/sharpness.json": JSON.stringify({
        description: { translate: "enchantment.minecraft.sharpness" },
        supported_items: "#minecraft:enchantable/sharp_weapon",
        weight: 10,
        max_level: 5,
        anvil_cost: 1,
        slots: ["mainhand"],
      }),
      "data/minecraft/tags/block/planks.json": JSON.stringify({
        replace: false,
        values: ["minecraft:oak_planks", "#minecraft:non_flammable_wood"],
      }),
      "data/minecraft/tags/item/planks.json": JSON.stringify({
        values: [{ id: "minecraft:oak_planks", required: false }],
      }),
      "data/minecraft/loot_table/blocks/oak_planks.json": JSON.stringify({
        type: "minecraft:block",
        pools: [
          {
            rolls: 1,
            entries: [{ type: "minecraft:item", name: "minecraft:oak_planks" }],
            functions: [{ function: "minecraft:explosion_decay" }],
          },
        ],
      }),
      "data/minecraft/advancement/story/root.json": JSON.stringify({
        display: {
          title: { translate: "advancements.story.root.title" },
          description: { translate: "advancements.story.root.description" },
          icon: { id: "minecraft:grass_block" },
          frame: "task",
        },
        criteria: { crafting_table: { trigger: "minecraft:inventory_changed" } },
        rewards: { experience: 10 },
      }),
      "assets/minecraft/lang/en_us.json": JSON.stringify({
        "block.minecraft.oak_planks": "Oak Planks",
        "enchantment.minecraft.sharpness": "Sharpness",
      }),
    });

    const dataset = await new MinecraftDataExtractor(createConsoleLogger(false)).extract("26.1.1", [archive]);

    expect(dataset.enchantments[0]).toMatchObject({
      id: "minecraft:sharpness",
      descriptionKey: "enchantment.minecraft.sharpness",
      maxLevel: 5,
      weight: 10,
      slots: ["mainhand"],
    });

    const blockTag = dataset.tags.find((tag) => tag.registry === "block" && tag.id === "minecraft:planks");
    expect(blockTag?.values).toEqual(["minecraft:oak_planks", "#minecraft:non_flammable_wood"]);
    const itemTag = dataset.tags.find((tag) => tag.registry === "item" && tag.id === "minecraft:planks");
    expect(itemTag?.values).toEqual(["minecraft:oak_planks"]);

    expect(dataset.lootTables[0]).toMatchObject({
      id: "minecraft:blocks/oak_planks",
      type: "minecraft:block",
      poolCount: 1,
      itemDrops: ["minecraft:oak_planks"],
      functions: ["minecraft:explosion_decay"],
    });

    expect(dataset.advancements[0]).toMatchObject({
      id: "minecraft:story/root",
      titleKey: "advancements.story.root.title",
      iconItem: "minecraft:grass_block",
      frame: "task",
      criteria: ["crafting_table"],
      rewards: { experience: 10 },
    });

    expect(dataset.translations).toEqual([
      { key: "block.minecraft.oak_planks", value: "Oak Planks" },
      { key: "enchantment.minecraft.sharpness", value: "Sharpness" },
    ]);
  });
});

function createRgbPng(pixels: Array<[number, number, number]>): Buffer {
  const width = pixels.length;
  const raw = Buffer.alloc(1 + width * 3);
  raw.writeUInt8(0, 0);

  for (let index = 0; index < pixels.length; index += 1) {
    const [red, green, blue] = pixels[index] ?? [0, 0, 0];
    const pixelOffset = 1 + index * 3;
    raw.writeUInt8(red, pixelOffset);
    raw.writeUInt8(green, pixelOffset + 1);
    raw.writeUInt8(blue, pixelOffset + 2);
  }

  return createPng(width, 1, 2, raw);
}

function createGrayscalePng(values: number[]): Buffer {
  const width = values.length;
  const raw = Buffer.alloc(1 + width);
  raw.writeUInt8(0, 0);

  for (let index = 0; index < values.length; index += 1) {
    raw.writeUInt8(values[index] ?? 0, 1 + index);
  }

  return createPng(width, 1, 0, raw);
}

function createPng(width: number, height: number, colorType: number, raw: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(colorType, 9);
  header.writeUInt8(0, 10);
  header.writeUInt8(0, 11);
  header.writeUInt8(0, 12);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    createChunk("IHDR", header),
    createChunk("IDAT", deflateSync(raw)),
    createChunk("IEND", Buffer.alloc(0)),
  ]);
}

function createChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
}
