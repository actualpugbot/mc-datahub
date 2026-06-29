import { describe, expect, test } from "vitest";
import { DiffEngine } from "../src/diff/diffEngine.js";
import type { VersionDataset } from "../src/domain/types.js";

function createDataset(version: string): VersionDataset {
  return {
    version,
    generatedAt: "2026-01-01T00:00:00.000Z",
    provenance: {
      sourceArtifacts: [],
      extractedFromPaths: [],
    },
    blocks: [],
    items: [],
    recipes: [],
    textures: [],
    models: [],
    palettes: [],
    itemStats: [],
    blockProperties: [],
    enchantments: [],
    tags: [],
    lootTables: [],
    advancements: [],
    translations: [],
    biomes: [],
    mobImages: [],
    mobSounds: [],
  };
}

describe("diff engine", () => {
  test("captures added, removed, and changed records", () => {
    const from = createDataset("1.0");
    from.blocks = [
      {
        id: "minecraft:stone",
        tags: [],
        modelRefs: [],
        textureRefs: [],
        blockstatePath: "assets/minecraft/blockstates/stone.json",
        raw: {},
      },
    ];
    from.items = [
      {
        id: "minecraft:stick",
        tags: [],
        recipeIds: ["minecraft:stick"],
        modelRef: "minecraft:item/stick",
        textureRefs: ["minecraft:item/stick"],
        sourcePath: "assets/minecraft/models/item/stick.json",
        raw: {},
      },
    ];

    const to = createDataset("1.1");
    to.blocks = [
      {
        id: "minecraft:stone",
        tags: ["minecraft:mineable/pickaxe"],
        modelRefs: [],
        textureRefs: [],
        blockstatePath: "assets/minecraft/blockstates/stone.json",
        raw: {},
      },
      {
        id: "minecraft:granite",
        tags: [],
        modelRefs: [],
        textureRefs: [],
        blockstatePath: "assets/minecraft/blockstates/granite.json",
        raw: {},
      },
    ];
    from.palettes = [
      {
        id: "minecraft:palette/curated/material/amethyst-radiance",
        kind: "curated",
        category: "material",
        name: "Amethyst Radiance",
        description: "A bright amethyst gradient.",
        colors: ["#ffffff", "#cccccc", "#999999", "#666666"],
        sources: ["minecraft:palette/extracted/trim/amethyst"],
        tags: ["curated", "material", "amethyst"],
      },
    ];

    to.palettes = [
      {
        id: "minecraft:palette/curated/material/amethyst-radiance",
        kind: "curated",
        category: "material",
        name: "Amethyst Radiance",
        description: "A brighter amethyst gradient.",
        colors: ["#ffffff", "#dddddd", "#999999", "#666666"],
        sources: ["minecraft:palette/extracted/trim/amethyst"],
        tags: ["curated", "material", "amethyst"],
      },
    ];
    from.mobImages = [
      {
        id: "minecraft:allay",
        localId: "allay",
        displayName: "Allay",
        imagePath: "mob-images/allay/allay.png",
        sourcePath: "assets/minecraft/textures/entity/allay/allay.png",
        origin: "renderer",
        variants: [
          {
            id: "allay/allay",
            imagePath: "mob-images/allay/allay.png",
            sourcePath: "assets/minecraft/textures/entity/allay/allay.png",
            origin: "renderer",
            role: "base",
          },
        ],
      },
    ];

    to.mobImages = [
      {
        id: "minecraft:allay",
        localId: "allay",
        displayName: "Allay",
        imagePath: "mob-images/allay/allay_v2.png",
        sourcePath: "assets/minecraft/textures/entity/allay/allay_v2.png",
        origin: "renderer",
        variants: [
          {
            id: "allay/allay_v2",
            imagePath: "mob-images/allay/allay_v2.png",
            sourcePath: "assets/minecraft/textures/entity/allay/allay_v2.png",
            origin: "renderer",
            role: "base",
          },
        ],
      },
    ];

    const diff = new DiffEngine().compare(from, to);
    expect(diff.blocks.added).toHaveLength(1);
    expect(diff.blocks.changed).toHaveLength(1);
    expect(diff.items.removed).toHaveLength(1);
    expect(diff.mobImages.changed).toHaveLength(1);
    expect(diff.palettes.changed).toHaveLength(1);
  });
});
