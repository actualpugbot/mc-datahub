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
    mobModels: [],
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

describe("diff coverage of the whole dataset", () => {
  test("reports every dataset field as either a collection or an object diff", () => {
    const diff = new DiffEngine().compare(createDataset("1.0"), createDataset("1.1"));
    const { fromVersion: _from, toVersion: _to, generatedAt: _at, ...fields } = diff;

    const collections = Object.entries(fields).filter(([, value]) => "added" in value);
    const objects = Object.entries(fields).filter(([, value]) => !("added" in value));

    // Which fields exist is enforced at compile time by _EveryDatasetFieldIsClassified; the counts are
    // here so that adding one to VersionDataset without wiring the diff is caught at run time too.
    expect(collections).toHaveLength(24);
    expect(objects).toHaveLength(11);
    for (const [name, value] of objects) {
      expect(value, name).toMatchObject({ status: expect.any(String), changedFields: expect.any(Array) });
    }
  });

  test("reports a changed whole-object dataset and names the fields that moved", () => {
    const from = createDataset("1.0");
    const to = createDataset("1.1");
    from.treeFeatures = { generatedAt: "x", version: "1.0", families: [], growth: [], warnings: [] } as never;
    to.treeFeatures = { generatedAt: "x", version: "1.0", families: [{ id: "oak" }], growth: [], warnings: [] } as never;

    const diff = new DiffEngine().compare(from, to);
    expect(diff.treeFeatures.status).toBe("changed");
    expect(diff.treeFeatures.changedFields).toEqual(["families"]);
  });

  test("distinguishes an added dataset from an unchanged one", () => {
    const from = createDataset("1.0");
    const to = createDataset("1.1");
    to.sulfurCube = { archetypes: [], blocks: [] } as never;

    const diff = new DiffEngine().compare(from, to);
    expect(diff.sulfurCube.status).toBe("added");
    expect(diff.sulfurCube.changedFields).toEqual(["archetypes", "blocks"]);
    expect(diff.lootOdds.status).toBe("unchanged");
    expect(diff.anvilMechanics).toEqual({ status: "unchanged", changedFields: [] });
  });

  test("reports a removed dataset", () => {
    const from = createDataset("1.0");
    const to = createDataset("1.1");
    from.oreGeneration = {
      metric: "configured_feature_placement_attempts",
      dimensions: [],
      features: [],
      ores: [],
      warnings: [],
    };

    const diff = new DiffEngine().compare(from, to);
    expect(diff.oreGeneration.status).toBe("removed");
  });

  test("diffs the newly covered keyed collections", () => {
    const from = createDataset("1.0");
    const to = createDataset("1.1");
    from.structures = [{ id: "minecraft:village_plains", key: "village_plains" } as never];
    to.structures = [
      { id: "minecraft:village_plains", key: "village_plains_v2" } as never,
      { id: "minecraft:trial_chambers", key: "trial_chambers" } as never,
    ];

    const diff = new DiffEngine().compare(from, to);
    expect(diff.structures.changed).toHaveLength(1);
    expect(diff.structures.added).toHaveLength(1);
    expect(diff.structures.added[0]?.id).toBe("minecraft:trial_chambers");
  });
});
