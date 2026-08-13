import { describe, expect, test } from "vitest";
import type { VersionDataset } from "../src/domain/types.js";
import { validateDataset } from "../src/validation/datasetValidation.js";

describe("dataset validation", () => {
  test("passes coherent normalized recipes, links, and recursive tags", () => {
    const dataset = fixture();
    const report = validateDataset(dataset);

    expect(report.status).toBe("passed");
    expect(report.counts).toMatchObject({
      concreteRecipeOutputs: 1,
      normalizedRecipeOutputs: 1,
      declaredIngredientRecipes: 1,
      normalizedIngredientRecipes: 1,
      itemRecipeLinks: 1,
      errors: 0,
    });
  });

  test("reports the normalization regressions found in current-schema game data", () => {
    const dataset = fixture();
    dataset.recipes[0]!.ingredients = [];
    dataset.recipes[0]!.ingredientTags = [];
    dataset.recipes[0]!.result = undefined;
    dataset.items.find((item) => item.id === "minecraft:stick")!.recipeIds = [];
    dataset.items.find((item) => item.id === "minecraft:oak_planks")!.tags = [];

    const report = validateDataset(dataset);
    expect(report.status).toBe("failed");
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "invalid_normalized_recipe_result",
        "missing_normalized_recipe_ingredients",
        "missing_normalized_tag_membership",
      ]),
    );
  });
});

function fixture(): VersionDataset {
  return {
    version: "test",
    generatedAt: "2026-08-13T00:00:00.000Z",
    provenance: { sourceArtifacts: ["fixture"], extractedFromPaths: [] },
    blocks: [],
    items: [
      {
        id: "minecraft:oak_planks",
        tags: ["minecraft:building_materials", "minecraft:planks"],
        recipeIds: [],
        modelRef: "minecraft:item/oak_planks",
        textureRefs: [],
        sourcePath: "assets/minecraft/items/oak_planks.json",
        raw: {},
      },
      {
        id: "minecraft:stick",
        tags: [],
        recipeIds: ["minecraft:stick"],
        modelRef: "minecraft:item/stick",
        textureRefs: [],
        sourcePath: "assets/minecraft/items/stick.json",
        raw: {},
      },
    ],
    recipes: [
      {
        id: "minecraft:stick",
        type: "minecraft:crafting_shaped",
        ingredients: [],
        ingredientTags: ["minecraft:planks"],
        result: { item: "minecraft:stick", count: 4 },
        sourcePath: "data/minecraft/recipe/stick.json",
        raw: {
          type: "minecraft:crafting_shaped",
          key: { "#": "#minecraft:planks" },
          pattern: ["#", "#"],
          result: { id: "minecraft:stick", count: 4 },
        },
      },
    ],
    textures: [],
    models: [],
    palettes: [],
    itemStats: [],
    blockProperties: [],
    enchantments: [],
    tags: [
      {
        id: "minecraft:planks",
        registry: "item",
        replace: false,
        values: ["minecraft:oak_planks"],
        sourcePath: "data/minecraft/tags/item/planks.json",
        raw: {},
      },
      {
        id: "minecraft:building_materials",
        registry: "item",
        replace: false,
        values: ["#minecraft:planks"],
        sourcePath: "data/minecraft/tags/item/building_materials.json",
        raw: {},
      },
    ],
    lootTables: [],
    advancements: [],
    translations: [],
    biomes: [],
    mobImages: [],
    mobModels: [],
    mobSounds: [],
  };
}
